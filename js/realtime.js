/* ============================================================
 * js/realtime.js
 * طبقة موثوقية فوق Supabase Realtime.
 *
 * المشكلة التي تحلّها:
 *   متصفحات الجوال (Chrome/Android وSafari/iOS) تُجمّد (Freeze) التبويب
 *   الخلفي بعد نحو 5 دقائق من إخفائه، فيموت WebSocket بصمت:
 *     • لا حدث `offline` في الواجهة.
 *     • لا خطأ من مكتبة Realtime.
 *     • المؤقتات العادية (setInterval) تُخنَق إلى نبضة كل دقيقة.
 *   النتيجة: يتوقّف استقبال الرسائل الحقيقية (Realtime) حتى يعود المستخدم
 *   للتبويب، ويبدو التطبيق "ميتاً" في الخلفية.
 *
 * الحل هنا:
 *   • realtimeConnectionState / diagnoseRealtime : تشخيص فوري للحالة.
 *   • createResilientChannel : قناة تُعيد الاشتراك تلقائياً عند
 *     CHANNEL_ERROR / TIMED_OUT / CLOSED بخلفية تصاعدية (backoff مع jitter).
 *   • startRealtimeWatchdog : نبضة يقظة تكتشف موت الاتصال — حتى في الخلفية —
 *     وتستدعي onRevive لإعادة بناء الاشتراكات + مزامنة تفاضلية للبيانات.
 * ============================================================ */

/** حالة اتصال الـ WebSocket الأساسي: connected | connecting | disconnected | unknown */
export function realtimeConnectionState(supabase) {
  try {
    const value = supabase?.realtime?.connectionState?.();
    return typeof value === "string" && value ? value : "unknown";
  } catch {
    return "unknown";
  }
}

export function isRealtimeConnected(supabase) {
  return realtimeConnectionState(supabase) === "connected";
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

/**
 * ينشئ قناة Realtime تعيد الاشتراك تلقائياً عند أي خطأ/انقطاع.
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
 * @returns {{channel:any, ready:Promise<any>, rebuild:()=>Promise<any>, stop:()=>void, topic:string}}
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

  let channel = null;
  let stopped = false;
  let attempt = 0;
  let retryTimer = null;
  let queue = Promise.resolve();

  const handle = {
    topic,
    get channel() {
      return channel;
    },
    ready: null,
    rebuild: null,
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
      log(`توقّفت محاولات إعادة الاشتراك بعد ${maxRetries} محاولة — سيُعاد عند العودة للمقدمة`);
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

    // removeChannel غير متزامنة — لا تُنشئ قناة بنفس الـ topic قبل إغلاق القديمة
    const previous = channel;
    channel = null;
    if (previous) {
      try {
        await supabase.removeChannel(previous);
      } catch (error) {
        log("تعذّر إغلاق القناة القديمة", error);
      }
    }
    if (stopped) return null;

    const ch = supabase.channel(topic, config);
    channel = ch;
    attach(ch);

    ch.subscribe((status, error) => {
      try {
        onStatus?.(status, error, ch);
      } catch (callbackError) {
        log("خطأ داخل onStatus", callbackError);
      }

      if (status === "SUBSCRIBED") {
        attempt = 0;
        return;
      }
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        log(`حالة قناة غير سليمة (${status}) — جدولة إعادة اشتراك`, error || "");
        scheduleRetry();
      }
    });

    return ch;
  }

  handle.rebuild = () => {
    if (stopped) return Promise.resolve(null);
    attempt = 0;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    queue = queue.then(build, build);
    return queue;
  };

  handle.stop = () => {
    stopped = true;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    const ch = channel;
    channel = null;
    if (ch) {
      try {
        supabase.removeChannel(ch);
      } catch (error) {
        log("تعذّر إغلاق القناة", error);
      }
    }
  };

  handle.ready = build();

  return handle;
}

/**
 * نبضة يقظة (Watchdog) لاتصال Realtime.
 *
 * لا تعتمد على `visibilitychange` فقط، لأن التبويب المجمّد (Frozen) لا يستقبل
 * أحداثاً أصلاً. تعمل بمؤقت متكيّف: سريع في المقدمة، بطيء في الخلفية (حيث
 * تُخنَق المؤقتات إلى نبضة/دقيقة، لذا 45 ثانية عملية تماماً).
 *
 * @param {object} options
 * @param {object} options.supabase
 * @param {() => boolean} [options.isEnabled]
 * @param {(reason:string) => any} [options.onRevive]  إعادة بناء الاشتراكات + مزامنة
 * @param {(info:object) => void} [options.onConnectionLost]
 * @param {number} [options.visibleIntervalMs=20000]
 * @param {number} [options.hiddenIntervalMs=45000]
 * @param {number} [options.lostThreshold=2]           عدد النبضات قبل إعلان الفقد
 * @param {number} [options.reviveCooldownMs=30000]
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
  } = options;

  let timer = null;
  let stopped = false;
  let misses = 0;
  let lastReviveAt = 0;

  function schedule() {
    if (stopped) return;
    const delay = (typeof document !== "undefined" && document.hidden)
      ? hiddenIntervalMs
      : visibleIntervalMs;
    timer = setTimeout(tick, delay);
  }

  async function revive(reason) {
    if (typeof onRevive !== "function") return;
    if (Date.now() - lastReviveAt < reviveCooldownMs) return;
    lastReviveAt = Date.now();
    console.warn(`[realtime:watchdog] إحياء الاتصال (${reason})`);
    try {
      await onRevive(reason);
    } catch (error) {
      console.warn("[realtime:watchdog] فشل الإحياء:", error);
    }
  }

  async function tick() {
    if (stopped) return;
    timer = null;

    try {
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
          if (report.unhealthy.length) await revive("channel-unhealthy");
        }
      }
    } catch (error) {
      console.warn("[realtime:watchdog] خطأ في النبضة:", error);
    }

    schedule();
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
  };
}
