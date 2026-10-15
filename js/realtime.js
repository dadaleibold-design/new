/* ============================================================
 * js/realtime.js
 * طبقة موثوقية فوق Supabase Realtime.
 *
 * المشكلة التي تحلّها:
 *   متصفحات الجوال (Chrome/Android وSafari/iOS) تُجمّد (Freeze) التبويب
 *   الخلفي بعد نحو 5 دقائق من إخفائه، فيموت WebSocket بصمت.
 *
 * ضمانات هذه الطبقة (بعد إصلاح حلقة التكرار):
 *   1) نمط Singleton لكل topic: لا تُفتح قناتان بنفس الاسم أبداً.
 *      إنشاء قناة جديدة بنفس الـ topic يُغلق القديمة أولاً.
 *   2) حارس الإلغاء (stale guard): أي حدث حالة يأتي من قناة أُزيلت أو
 *      استُبدلت يُتجاهَل. هذا هو سبب الحلقة الأصلية: إزالة القناة القديمة
 *      كانت تُطلق CLOSED ⇒ جدولة إعادة ⇒ إزالة القناة الجديدة ⇒ CLOSED …
 *   3) لا إعادة بناء للقناة السليمة: ensureHealthy() يعيد البناء فقط إن
 *      كانت القناة ميتة (errored/closed) أو غير متصلة.
 *   4) حدّ للمحاولات: بعد maxRetries تُعلَّم القناة failed ولا تعود تلقائياً
 *      إلا بإعادة بناء صريحة (rebuild) — فلا حلقة لا نهائية على خطأ دائم
 *      في الخادم (مثل جدول غير منشور في supabase_realtime).
 *   5) نبضة يقظة مع تراجع أُسّي (exponential backoff) لعمليات الإحياء.
 * ============================================================ */

/**
 * حالة WebSocket الخام كما تعيدها Supabase Realtime، مثلاً:
 * open | connecting | closing | closed. نُبقي القيمة الخام للتشخيص.
 */
export function realtimeConnectionState(supabase) {
  try {
    const value = supabase?.realtime?.connectionState?.();
    if (typeof value === "string" && value) return value.toLowerCase();
    // بعض adapters قد تعيد WebSocket.readyState مباشرة (OPEN === 1).
    if (value === 1) return "open";
    return "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * RealtimeClient.isConnected() هو المصدر الأدق في Supabase v2.
 * connectionState() يعيد `open` لا `connected` في Phoenix/Supabase؛ إبقاء
 * fallback للحالة النصية يدعم adapters القديمة ومحاكيات الاختبار.
 */
export function isRealtimeConnected(supabase) {
  try {
    const isConnected = supabase?.realtime?.isConnected?.();
    if (typeof isConnected === "boolean") return isConnected;
  } catch {
    // استخدم حالة socket أدناه إن لم يتوفر isConnected أو تعذّر استدعاؤه.
  }

  const state = realtimeConnectionState(supabase);
  return state === "open" || state === "connected";
}

/** حالة قناة واحدة: joined | joining | leaving | closed | errored | unknown */
export function channelState(channel) {
  try {
    const value = channel?.state;
    return typeof value === "string" && value ? value : "unknown";
  } catch {
    return "unknown";
  }
}

/** القناة «حيّة»: منضمّة أو قيد الانضمام، والاتصال الأساسي متصل */
export function isChannelAlive(supabase, channel) {
  if (!channel) return false;
  const state = channelState(channel);
  return (state === "joined" || state === "joining") && isRealtimeConnected(supabase);
}

function listChannels(supabase) {
  try {
    const channels = supabase?.getChannels?.();
    return Array.isArray(channels) ? channels : [];
  } catch {
    return [];
  }
}

/** تقرير تشخيصي كامل — يُستخدم في السجل وفي شاشة التشخيص داخل التطبيق */
export function diagnoseRealtime(supabase) {
  const channels = listChannels(supabase).map((channel) => ({
    topic: channel?.topic || "?",
    state: channelState(channel),
  }));

  const unhealthy = channels.filter(
    (channel) => channel.state === "errored" || channel.state === "closed" || channel.state === "leaving"
  );

  return {
    connection: realtimeConnectionState(supabase),
    channels,
    unhealthy,
    healthy: isRealtimeConnected(supabase) && unhealthy.length === 0,
  };
}

/** يعيد الاتصال الأساسي إن كان مقطوعاً — ويعيد true إن كان متصلاً فعلاً */
export function ensureRealtimeConnected(supabase) {
  if (isRealtimeConnected(supabase)) return true;
  try {
    supabase?.realtime?.connect?.();
  } catch (error) {
    console.warn("[realtime] تعذّر إعادة الاتصال:", error);
  }
  return isRealtimeConnected(supabase);
}

function jitter(ms) {
  return ms + Math.floor(Math.random() * 350);
}

/** سجلّ القنوات المُدارة: topic → handle (نمط Singleton) */
const managedChannels = new Map();

/** إزالات قيد التنفيذ: topic → Promise — لا تُنشأ قناة بنفس الاسم قبل انتهائها */
const pendingRemovals = new Map();

/** يعيد القناة المُدارة الحالية لهذا الـ topic إن وُجدت (للتشخيص/الاختبار) */
export function getManagedChannel(topic) {
  return managedChannels.get(topic) || null;
}

/**
 * ينشئ قناة Realtime تعيد الاشتراك تلقائياً عند أي خطأ/انقطاع.
 *
 * ⚠️ نمط Singleton: إن وُجدت قناة مُدارة نشطة بنفس الـ topic تُغلَق أولاً،
 * فلا تتكرّر القنوات على الـ socket الواحد أبداً.
 *
 * @param {object} supabase
 * @param {object} options
 * @param {string} options.topic            اسم القناة (topic)
 * @param {object} [options.config]         إعدادات القناة (مثل presence)
 * @param {Array<{type:string, filter?:object, callback:Function}>} [options.handlers]
 *        المستمعون؛ يُمرَّر للدالة (payload, channel, handle) للوصول للقناة الحالية.
 * @param {(status:string, error:any, channel:any)=>void} [options.onStatus]
 * @param {string} [options.label]
 * @param {number} [options.maxRetries=8]
 * @param {number} [options.minDelayMs=1200]
 * @param {number} [options.maxDelayMs=30000]
 */
export function createResilientChannel(supabase, options = {}) {
  const {
    topic,
    config,
    handlers = [],
    onStatus = null,
    label = topic,
    maxRetries = 8,
    minDelayMs = 1200,
    maxDelayMs = 30000,
  } = options;

  // Singleton: أغلق أي نسخة سابقة بنفس الـ topic قبل إنشاء الجديدة
  const previous = managedChannels.get(topic);
  if (previous && !previous.stopped) previous.stop();

  let channel = null;
  let stopped = false;
  let attempt = 0;
  let failed = false;
  let retryTimer = null;
  let generation = 0; // يزداد مع كل بناء/إيقاف — لإبطال الاستدعاءات القديمة
  let queue = Promise.resolve();

  const handle = {
    topic,
    get channel() {
      return channel;
    },
    get stopped() {
      return stopped;
    },
    get failed() {
      return failed;
    },
    ready: null,
    rebuild: null,
    ensureHealthy: null,
    stop: null,
  };

  const log = (message, extra) => {
    if (extra === undefined) console.warn(`[realtime:${label}] ${message}`);
    else console.warn(`[realtime:${label}] ${message}`, extra);
  };

  function attach(ch) {
    handlers.forEach((handler) => {
      try {
        ch.on(handler.type, handler.filter, (payload) => {
          try {
            handler.callback(payload, ch, handle);
          } catch (error) {
            log("خطأ داخل مستمع القناة", error);
          }
        });
      } catch (error) {
        log("تعذّر ربط مستمع", error);
      }
    });
  }

  function scheduleRetry() {
    if (stopped || retryTimer) return;
    if (attempt >= maxRetries) {
      failed = true;
      log(`توقّفت المحاولات التلقائية بعد ${maxRetries} محاولة — تُعاد عند الحاجة (rebuild)`);
      return;
    }
    const delay = jitter(Math.min(maxDelayMs, minDelayMs * 2 ** attempt));
    attempt += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      queue = queue.then(build, build);
    }, delay);
  }

  async function build() {
    if (stopped) return null;
    const gen = ++generation;

    // إزالة القناة القديمة: قد تُطلق CLOSED عليها — لكن استدعاءاتها صارت
    // قديمة (channel = null) فيتجاهلها حارس الإلغاء أدناه.
    const old = channel;
    channel = null;
    if (old) {
      try {
        await supabase.removeChannel(old);
      } catch (error) {
        log("تعذّر إغلاق القناة القديمة", error);
      }
    }
    if (stopped || gen !== generation) return null;

    // لا تُنشئ قناة بنفس الـ topic قبل اكتمال إزالة القديمة (سباق Singleton)
    if (pendingRemovals.has(topic)) {
      await pendingRemovals.get(topic);
      if (stopped || gen !== generation) return null;
    }

    const ch = supabase.channel(topic, config);
    channel = ch;
    attach(ch);

    ch.subscribe((status, error) => {
      // حارس الإلغاء: تجاهل أي حدث من قناة أُزيلت أو استُبدلت أو أُوقفت
      if (stopped || gen !== generation || ch !== channel) return;

      try {
        onStatus?.(status, error, ch);
      } catch (callbackError) {
        log("خطأ داخل onStatus", callbackError);
      }

      if (status === "SUBSCRIBED") {
        attempt = 0;
        failed = false;
        return;
      }
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        log(`حالة قناة غير سليمة (${status}) — جدولة إعادة اشتراك`, error || "");
        scheduleRetry();
      }
    });

    return ch;
  }

  /** إعادة بناء صريحة: تُصفِّر العدّاد وتتجاوز حد المحاولات */
  handle.rebuild = ({ force = false } = {}) => {
    if (stopped) return Promise.resolve(null);
    if (!force && isChannelAlive(supabase, channel) && channelState(channel) === "joined") {
      return Promise.resolve(channel);
    }
    attempt = 0;
    failed = false;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    queue = queue.then(build, build);
    return queue;
  };

  /** يعيد البناء فقط إن كانت القناة ميتة — لا يمسّ القناة السليمة */
  handle.ensureHealthy = () => {
    if (stopped) return Promise.resolve(null);
    if (isChannelAlive(supabase, channel)) return Promise.resolve(channel);
    return handle.rebuild({ force: true });
  };

  handle.stop = () => {
    if (stopped) return;
    stopped = true;
    generation += 1;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    if (managedChannels.get(topic) === handle) managedChannels.delete(topic);
    const ch = channel;
    channel = null;
    if (ch) {
      let removal;
      try {
        removal = Promise.resolve(supabase.removeChannel(ch)).catch((error) => {
          log("تعذّر إغلاق القناة", error);
        });
      } catch (error) {
        log("تعذّر إغلاق القناة", error);
        removal = Promise.resolve();
      }
      const tracked = removal.finally(() => {
        if (pendingRemovals.get(topic) === tracked) pendingRemovals.delete(topic);
      });
      pendingRemovals.set(topic, tracked);
    }
  };

  managedChannels.set(topic, handle);
  handle.ready = build();

  return handle;
}

/**
 * نبضة يقظة (Watchdog) لاتصال Realtime.
 *
 * تعمل بمؤقت متكيّف: سريع في المقدمة، بطيء في الخلفية. وعمليات الإحياء
 * تتراجع أُسّياً (reviveCooldownMs × 2^n حتى maxReviveCooldownMs) إن لم تعُد
 * القنوات سليمة — فلا تتحول قناة معطوبة إلى حلقة إحياء كل 30 ثانية.
 *
 * @param {object} options
 * @param {object} options.supabase
 * @param {() => boolean} [options.isEnabled]
 * @param {(reason:string) => any} [options.onRevive]
 * @param {(info:object) => void} [options.onConnectionLost]
 * @param {number} [options.visibleIntervalMs=20000]
 * @param {number} [options.hiddenIntervalMs=45000]
 * @param {number} [options.lostThreshold=2]
 * @param {number} [options.reviveCooldownMs=30000]
 * @param {number} [options.maxReviveCooldownMs=300000]
 */
export function startRealtimeWatchdog(options = {}) {
  const {
    supabase,
    isEnabled = () => true,
    onRevive = null,
    onConnectionLost = null,
    visibleIntervalMs = 20000,
    hiddenIntervalMs = 45000,
    lostThreshold = 2,
    reviveCooldownMs = 30000,
    maxReviveCooldownMs = 300000,
  } = options;

  let timer = null;
  let tickPromise = null;
  let stopped = false;
  let misses = 0;
  let lastReviveAt = 0;
  let reviveFailures = 0;

  function schedule() {
    if (stopped || timer) return;
    const delay = (typeof document !== "undefined" && document.hidden)
      ? hiddenIntervalMs
      : visibleIntervalMs;
    timer = setTimeout(() => {
      timer = null;
      void tick();
    }, delay);
  }

  async function revive(reason) {
    if (typeof onRevive !== "function") return;
    const cooldown = Math.min(reviveCooldownMs * 2 ** reviveFailures, maxReviveCooldownMs);
    if (Date.now() - lastReviveAt < cooldown) return;
    lastReviveAt = Date.now();
    reviveFailures += 1;
    console.warn(`[realtime:watchdog] إحياء الاتصال (${reason}) — محاولة #${reviveFailures}`);
    try {
      await onRevive(reason);
    } catch (error) {
      console.warn("[realtime:watchdog] فشل الإحياء:", error);
    }
  }

  function tick() {
    if (stopped) return Promise.resolve();

    // ping() قد يُستدعى عند pageshow/online بينما المؤقت الدوري موجود؛ لا
    // ننشئ ساعتين متوازيتين ولا نضاعف فحوص الإحياء.
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (tickPromise) return tickPromise;

    // بدء العمل في microtask يضمن تعيين tickPromise قبل دخول try/finally.
    tickPromise = Promise.resolve()
      .then(async () => {
        const online = typeof navigator === "undefined" ? true : navigator.onLine !== false;

        if (isEnabled() && online) {
          if (!isRealtimeConnected(supabase)) {
            misses += 1;
            ensureRealtimeConnected(supabase);

            if (misses >= lostThreshold) {
              misses = 0;
              try {
                onConnectionLost?.(diagnoseRealtime(supabase));
              } catch {
                /* تجاهل */
              }
              await revive("connection-lost");
            }
          } else {
            misses = 0;
            const report = diagnoseRealtime(supabase);
            if (report.unhealthy.length) {
              await revive("channel-unhealthy");
            } else {
              // كل شيء سليم ⇒ صفّر تراجع الإحياء
              reviveFailures = 0;
            }
          }
        }
      })
      .catch((error) => {
        console.warn("[realtime:watchdog] خطأ في النبضة:", error);
      })
      .finally(() => {
        tickPromise = null;
        schedule();
      });

    return tickPromise;
  }

  schedule();

  return {
    /** نبضة يدوية (تُستدعى عند العودة للمقدمة أو بعد المكالمات) */
    ping: tick,
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    get lastReviveAt() {
      return lastReviveAt;
    },
    get reviveFailures() {
      return reviveFailures;
    },
  };
}
