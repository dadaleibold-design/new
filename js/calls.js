/* ============================================================
 * js/calls.js
 * مكالمات صوتية ومرئية عبر منصة Agora RTC.
 *
 * المعمارية:
 *   - الإشارات (Signaling): عبر Supabase Realtime Broadcast على قناة
 *     خاصة بكل مستخدم `calls:user:<uid>` + جدول `call_rooms` للحالة الدائمة.
 *   - الوسائط (Media): عبر Agora RTC Web SDK (يُحمَّل بشكل كسول Lazy
 *     عند أول مكالمة فقط، حتى لا يبطئ إقلاع التطبيق).
 *   - الأمان: كل شيء مغلّف بـ try/catch — أي فشل يُنهي المكالمة بلطف
 *     ولا يُسقط الواجهة.
 * ============================================================ */

import { AGORA, isAgoraConfigured, buildAgoraChannelName } from "./config.js";
import { safeAsync, safeQuery, safeDom, guard } from "./safety.js";
// عزل الرنين (v2.9): لا يرن إلا الجهاز الذي هو callee_id في غرفة المكالمة
import { shouldRingForInvite } from "./notification-scope.js";
// منطق وسائط نقي: الكاميرا الأمامية/الخلفية، ومخرج الصوت، ومنع تكرار الرنين
import {
  AUDIO_ROUTE_EARPIECE,
  AUDIO_ROUTE_SPEAKER,
  createExpiringSet,
  facingFromSettings,
  isCallPushType,
  nextFacingMode,
  normalizeFacing,
  pickAlternateCamera,
  pickOutputDevice,
  shouldMirrorLocalPreview,
  supportsAudioRouting,
} from "./call-media.js";
import {
  startRingtone,
  stopRingtone as stopRingtoneEngine,
  playConnectedTone,
  playEndedTone,
  playBusyTone,
  unlockAudio,
} from "./ringtone.js";

/* ------------------------------------------------------------
 * 1) تحميل Agora SDK بشكل كسول
 * ---------------------------------------------------------- */
let sdkPromise = null;

/**
 * يحمّل ملف SDK واحداً عبر وسم <script>.
 *
 * ⚠️ مهم: لا نضبط script.crossOrigin إطلاقاً. وسم <script> العادي يُحمَّل
 * عبر الأصول دون قيود، لكن ضبط crossOrigin يُفعّل فحص CORS فيرفض المتصفح
 * الملف ما لم يُرسل الخادم Access-Control-Allow-Origin — وهو ما لا يفعله
 * download.agora.io، فكان ذلك سبب خطأ "blocked by CORS policy".
 */
function loadSdkFrom(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = url;
    script.async = true;

    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      script.onload = null;
      script.onerror = null;
    };

    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      // أزل الوسم الفاشل حتى لا يتراكم في <head>
      try {
        script.remove();
      } catch {
        /* تجاهل */
      }
      reject(err);
    };

    const timer = setTimeout(
      () => fail(new Error(`انتهت مهلة تحميل مكتبة Agora من ${url}`)),
      timeoutMs
    );

    script.onload = () => {
      if (settled) return;
      settled = true;
      cleanup();

      if (window.AgoraRTC) {
        resolve(window.AgoraRTC);
      } else {
        reject(new Error("تم تحميل ملف Agora لكن الكائن AgoraRTC غير متاح."));
      }
    };

    script.onerror = () =>
      fail(new Error(`تعذّر تحميل مكتبة Agora RTC من ${url}`));

    document.head.appendChild(script);
  });
}

/**
 * يحمّل Agora SDK مع التنقّل بين عدة مصادر (CDN mirrors) بالتتابع،
 * فلا يُسقط مصدرٌ واحد معطّل (503) ميزة المكالمات بالكامل.
 */
function loadAgoraSdk() {
  if (window.AgoraRTC) return Promise.resolve(window.AgoraRTC);
  if (sdkPromise) return sdkPromise;

  const urls = AGORA.sdkUrls;

  sdkPromise = (async () => {
    const failures = [];

    for (const url of urls) {
      try {
        const sdk = await loadSdkFrom(url);

        try {
          sdk.setLogLevel?.(3); // أخطاء فقط
        } catch {
          /* تجاهل */
        }

        return sdk;
      } catch (err) {
        failures.push(`${url} → ${err.message}`);
        console.warn("[calls] فشل مصدر SDK، جارٍ تجربة التالي:", url, err.message);
      }
    }

    throw new Error(
      "تعذّر تحميل مكتبة Agora RTC من جميع المصادر. التفاصيل: " + failures.join(" | ")
    );
  })();

  // اسمح بإعادة المحاولة في المكالمة التالية بدل تخزين وعد مرفوض للأبد
  sdkPromise.catch(() => {
    sdkPromise = null;
  });

  return sdkPromise;
}

/* ------------------------------------------------------------
 * 2) حالة وحدة المكالمات
 * ---------------------------------------------------------- */
const callState = {
  ctx: null, // { supabase, getMe, getActiveConversation, notify, t }

  client: null,
  localAudioTrack: null,
  localVideoTrack: null,
  remoteUsers: new Map(),

  // المكالمة الجارية
  current: null, // { roomId, channel, callType, peer, direction, startedAt }
  incoming: null, // دعوة واردة قيد العرض

  signalChannel: null,
  ringTimer: null,
  durationTimer: null,
  ringtoneEl: null,

  micMuted: false,
  cameraOff: false,
  minimized: false,
  ringtoneKind: null,
  joining: false,
  onCallLogged: null, // callback يُستدعى بعد كتابة بطاقة المكالمة في المحادثة

  // مخرج الصوت: "speaker" | "earpiece" — الافتراضي حسب نوع المكالمة (تُضبط عند البدء)
  audioRoute: AUDIO_ROUTE_SPEAKER,
  // هل طلب المستخدم تغيير المخرج يدوياً؟ (لا نطبّق شيئاً تلقائياً قبل ذلك)
  audioRouteTouched: false,
  routeBusy: false,
  // الكاميرا الحالية: "user" (أمامية) | "environment" (خلفية)
  facingMode: "user",
  switchingCamera: false,

  // غرف رُنّ لها أو أُنهيت مؤخراً — تمنع تكرار الرنين عندما تصل الدعوة مرتين
  // (Realtime + Push) أو تصل متأخرة بعد الرفض/الانتهاء.
  handledRooms: createExpiringSet({ ttlMs: 120000 }),
};

function t(key, fallback) {
  const dict = callState.ctx?.t?.();
  return (dict && dict[key]) || fallback;
}

function notify(message) {
  try {
    callState.ctx?.notify?.(message);
  } catch {
    console.warn("[calls]", message);
  }
}

function uuid() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** Agora UID رقمي مشتق بثبات من UUID المستخدم (يبقى ثابتاً لكل مستخدم) */
function uidFromUserId(userId) {
  const str = String(userId || "");
  let hash = 0;
  for (let i = 0; i < str.length; i += 1) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) % 1000000000 || 1;
}

/* ------------------------------------------------------------
 * 3) واجهة المكالمة (Overlay) — تُبنى مرة واحدة عند الحاجة
 * ---------------------------------------------------------- */
function ensureCallOverlay() {
  let overlay = document.getElementById("call-overlay");
  if (overlay) return overlay;

  overlay = document.createElement("div");
  overlay.id = "call-overlay";
  overlay.className = "call-overlay hidden";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.innerHTML = `
    <div class="call-stage" id="call-stage" data-type="audio" data-phase="ringing">
      <div class="call-backdrop" id="call-backdrop"></div>
      <div id="call-remote-video" class="call-video call-video-remote"></div>
      <div id="call-local-video" class="call-video call-video-local hidden"></div>

      <header class="call-topbar">
        <button type="button" id="call-btn-minimize" class="call-top-btn" title="تصغير" aria-label="تصغير">⌄</button>
        <div class="call-topbar-center">
          <span class="call-secure">🔒 <span>مشفّرة من طرف إلى طرف</span></span>
        </div>
      </header>

      <div class="call-peer-card" id="call-peer-card">
        <div class="call-avatar-wrap">
          <span class="call-ring call-ring-1"></span>
          <span class="call-ring call-ring-2"></span>
          <span class="call-ring call-ring-3"></span>
          <div class="call-avatar"><img id="call-peer-avatar" src="" alt="" /><span id="call-peer-initial" class="call-avatar-initial"></span></div>
        </div>
        <div class="call-peer-name" id="call-peer-name"></div>
        <div class="call-status-text" id="call-status-text"><span class="call-status-label"></span><span class="call-dots"><i></i><i></i><i></i></span></div>
        <div class="call-timer" id="call-timer"></div>
        <div class="call-quality" id="call-quality" title="جودة الاتصال"><i></i><i></i><i></i><i></i></div>
      </div>

      <div class="call-controls" id="call-controls">
        <button type="button" id="call-btn-speaker" class="call-ctrl" title="مكبّر الصوت / سماعة الأذن" aria-label="تبديل مخرج الصوت بين مكبّر الصوت وسماعة الأذن" aria-pressed="false" data-label="السماعة">
          <span class="call-ctrl-icon">🔈</span><span class="call-ctrl-label">المخرج</span>
        </button>
        <button type="button" id="call-btn-cam" class="call-ctrl" title="إيقاف الكاميرا" aria-label="إيقاف الكاميرا">
          <span class="call-ctrl-icon">📷</span><span class="call-ctrl-label">الكاميرا</span>
        </button>
        <button type="button" id="call-btn-flip" class="call-ctrl hidden" title="تبديل الكاميرا بين الأمامية والخلفية" aria-label="تبديل الكاميرا بين الأمامية والخلفية">
          <span class="call-ctrl-icon">🔄</span><span class="call-ctrl-label">تبديل</span>
        </button>
        <button type="button" id="call-btn-mic" class="call-ctrl" title="كتم الصوت" aria-label="كتم الصوت">
          <span class="call-ctrl-icon">🎙️</span><span class="call-ctrl-label">كتم</span>
        </button>
        <button type="button" id="call-btn-end" class="call-ctrl call-ctrl-end" title="إنهاء" aria-label="إنهاء المكالمة">
          <span class="call-ctrl-icon">
            <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true"><path fill="currentColor" d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.29-.7.29-.28 0-.53-.11-.71-.29L.29 13.08c-.18-.17-.29-.42-.29-.7 0-.28.11-.53.29-.71C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71 0 .28-.11.53-.29.7l-2.48 2.49c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28-.79-.74-1.69-1.36-2.67-1.85-.33-.16-.56-.5-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z"/></svg>
          </span><span class="call-ctrl-label">إنهاء</span>
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay
    .querySelector("#call-btn-mic")
    ?.addEventListener("click", guard("call:mic", toggleMicrophone));
  overlay
    .querySelector("#call-btn-cam")
    ?.addEventListener("click", guard("call:cam", toggleCamera));
  overlay
    .querySelector("#call-btn-flip")
    ?.addEventListener("click", guard("call:flip", switchCamera));
  overlay
    .querySelector("#call-btn-speaker")
    ?.addEventListener("click", guard("call:speaker", toggleAudioRoute));
  overlay
    .querySelector("#call-btn-minimize")
    ?.addEventListener("click", guard("call:minimize", () => setMinimized(true)));
  overlay
    .querySelector("#call-btn-end")
    ?.addEventListener("click", guard("call:end", () => endCall("ended")));

  // النقر على الفيديو يُظهر/يُخفي الضوابط (كما في تطبيقات المكالمات)
  overlay.querySelector("#call-remote-video")?.addEventListener("click", () => {
    if (callState.current?.callType === "video" && callState.current.connected) {
      overlay.classList.toggle("controls-hidden");
    }
  });

  return overlay;
}

/** الفقاعة العائمة الصغيرة عند تصغير المكالمة */
function ensureMiniBar() {
  let bar = document.getElementById("call-mini");
  if (bar) return bar;
  bar = document.createElement("button");
  bar.type = "button";
  bar.id = "call-mini";
  bar.className = "call-mini hidden";
  bar.innerHTML = `<span class="call-mini-dot"></span><span id="call-mini-text">مكالمة جارية</span><span id="call-mini-timer" class="call-mini-timer"></span>`;
  bar.addEventListener("click", guard("call:restore", () => setMinimized(false)));
  document.body.appendChild(bar);
  return bar;
}

function setMinimized(min) {
  safeDom("call-minimize", () => {
    const overlay = ensureCallOverlay();
    const bar = ensureMiniBar();
    callState.minimized = Boolean(min) && Boolean(callState.current);
    overlay.classList.toggle("minimized", callState.minimized);
    bar.classList.toggle("hidden", !callState.minimized);
    document.body.classList.toggle("in-call", Boolean(callState.current) && !callState.minimized);
    const text = document.getElementById("call-mini-text");
    if (text && callState.current) {
      text.textContent = `${callState.current.peer?.display_name || "مكالمة"} · اضغط للعودة`;
    }
  });
}

function ensureIncomingDialog() {
  let box = document.getElementById("incoming-call");
  if (box) return box;

  box = document.createElement("div");
  box.id = "incoming-call";
  box.className = "incoming-call hidden";
  box.setAttribute("role", "alertdialog");
  box.innerHTML = `
    <div class="incoming-card">
      <div class="incoming-kind" id="incoming-kind">مكالمة صوتية واردة</div>
      <div class="call-avatar-wrap">
        <span class="call-ring call-ring-1"></span>
        <span class="call-ring call-ring-2"></span>
        <span class="call-ring call-ring-3"></span>
        <div class="call-avatar"><img id="incoming-avatar" src="" alt="" /><span id="incoming-initial" class="call-avatar-initial"></span></div>
      </div>
      <div class="incoming-name" id="incoming-name"></div>
      <div class="incoming-sub" id="incoming-sub"></div>
      <div class="incoming-actions">
        <div class="incoming-action">
          <button type="button" id="incoming-decline" class="call-ctrl call-ctrl-end" aria-label="رفض">
            <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true"><path fill="currentColor" d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.29-.7.29-.28 0-.53-.11-.71-.29L.29 13.08c-.18-.17-.29-.42-.29-.7 0-.28.11-.53.29-.71C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71 0 .28-.11.53-.29.7l-2.48 2.49c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28-.79-.74-1.69-1.36-2.67-1.85-.33-.16-.56-.5-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z"/></svg>
          </button>
          <span>رفض</span>
        </div>
        <div class="incoming-action">
          <button type="button" id="incoming-accept" class="call-ctrl call-ctrl-accept pulse" aria-label="قبول">
            <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true"><path fill="currentColor" d="M6.62 10.79a15.05 15.05 0 0 0 6.59 6.59l2.2-2.2a1 1 0 0 1 1.01-.24c1.12.37 2.33.57 3.58.57a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1.02l-2.2 2.2z"/></svg>
          </button>
          <span>قبول</span>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(box);

  box
    .querySelector("#incoming-accept")
    ?.addEventListener("click", guard("call:accept", acceptIncomingCall));
  box
    .querySelector("#incoming-decline")
    ?.addEventListener("click", guard("call:decline", declineIncomingCall));

  return box;
}

function setOverlayVisible(visible) {
  safeDom("call-overlay", () => {
    const overlay = ensureCallOverlay();
    overlay.classList.toggle("hidden", !visible);
    overlay.classList.remove("controls-hidden", "minimized");
    ensureMiniBar().classList.add("hidden");
    callState.minimized = false;
    document.body.classList.toggle("in-call", visible);
    if (!visible) setCallPhase("ringing");
  });
}

/** مرحلة المكالمة تتحكم بالأنيميشن (ringing | connecting | connected | ended) */
function setCallPhase(phase) {
  safeDom("call-phase", () => {
    const stage = document.getElementById("call-stage");
    if (stage) stage.dataset.phase = phase;
  });
}

function setCallStatus(text, { animated = false } = {}) {
  safeDom("call-status", () => {
    const el = document.getElementById("call-status-text");
    if (!el) return;
    const label = el.querySelector(".call-status-label");
    if (label) label.textContent = text || "";
    else el.textContent = text || "";
    el.classList.toggle("animated", Boolean(animated) && Boolean(text));
  });
}

function initialOf(name) {
  return String(name || "?").trim().charAt(0).toUpperCase() || "?";
}

function setPeerInfo(peer) {
  safeDom("call-peer", () => {
    const nameEl = document.getElementById("call-peer-name");
    const avatarEl = document.getElementById("call-peer-avatar");
    const initialEl = document.getElementById("call-peer-initial");
    const backdrop = document.getElementById("call-backdrop");
    if (nameEl) nameEl.textContent = peer?.display_name || "مستخدم";
    const hasAvatar = Boolean(peer?.avatar_url);
    if (avatarEl) {
      avatarEl.src = hasAvatar ? peer.avatar_url : "";
      avatarEl.classList.toggle("hidden", !hasAvatar);
    }
    if (initialEl) {
      initialEl.textContent = initialOf(peer?.display_name);
      initialEl.classList.toggle("hidden", hasAvatar);
    }
    if (backdrop) {
      backdrop.style.backgroundImage = hasAvatar ? `url("${peer.avatar_url}")` : "";
    }
  });
}

function formatDuration(secs) {
  const h = Math.floor(secs / 3600);
  const mm = String(Math.floor((secs % 3600) / 60)).padStart(2, "0");
  const ss = String(secs % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function startDurationTimer() {
  stopDurationTimer();
  const startedAt = callState.current?.startedAt || Date.now();
  const tick = () => {
    safeDom("call-timer", () => {
      const secs = Math.floor((Date.now() - startedAt) / 1000);
      const label = formatDuration(secs);
      const el = document.getElementById("call-timer");
      if (el) el.textContent = label;
      const mini = document.getElementById("call-mini-timer");
      if (mini) mini.textContent = label;
    });
  };
  tick();
  callState.durationTimer = setInterval(tick, 1000);
}

function stopDurationTimer() {
  if (callState.durationTimer) {
    clearInterval(callState.durationTimer);
    callState.durationTimer = null;
  }
}

/**
 * نغمة الرنين التفاعلية:
 *   - "outgoing": نغمة انتظار أثناء رنين الطرف الآخر
 *   - "incoming": لحن رنين + اهتزاز للمكالمة الواردة
 * تُولَّد عبر Web Audio (js/ringtone.js) مع الرجوع إلى ملف notify.mp3 كبديل.
 */
function playRingtone(kind = "outgoing") {
  safeDom("ringtone", () => {
    startRingtone(kind);
    callState.ringtoneKind = kind;
    // بديل لمتصفحات بلا Web Audio: كرّر صوت الإشعار
    if (!(window.AudioContext || window.webkitAudioContext)) {
      const audio = document.getElementById("notification-sound");
      if (!audio) return;
      callState.ringtoneEl = audio;
      audio.loop = true;
      const p = audio.play();
      if (p && typeof p.catch === "function") p.catch(() => {});
    }
  });
}

function stopRingtone() {
  safeDom("ringtone-stop", () => {
    stopRingtoneEngine();
    callState.ringtoneKind = null;
    const audio = callState.ringtoneEl;
    if (!audio) return;
    audio.loop = false;
    audio.pause();
    audio.currentTime = 0;
    callState.ringtoneEl = null;
  });
}

/* ------------------------------------------------------------
 * 4) الإشارات عبر Supabase Realtime
 * ---------------------------------------------------------- */
function signalChannelName(userId) {
  return `calls:user:${userId}`;
}

/**
 * قنوات الإرسال المُعاد استخدامها، مفتاحها اسم القناة.
 *
 * سبب الوجود: إنشاء قناة جديدة لكل إشارة ثم إزالتها بعد 1.5 ثانية كان
 * يُحدث تسابقاً — إرسال إشارتين متتاليتين لنفس الموضوع (مثل invite ثم end
 * عند فشل الاتصال) يُنشئ قناة ثانية بنفس الـ topic بينما الأولى قيد
 * الانضمام/الإزالة، فلا تصل الثانية أبداً إلى SUBSCRIBED وتنتهي بمهلة.
 */
const outboundChannels = new Map();

function getOutboundChannel(channelName) {
  const supabase = callState.ctx?.supabase;

  const existing = outboundChannels.get(channelName);
  if (existing) return existing;

  const channel = supabase.channel(channelName, {
    config: { broadcast: { ack: true, self: false } },
  });

  // وعد انضمام واحد مشترك بين كل المُرسِلين لنفس القناة
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("مهلة الاشتراك بقناة الإشارة")),
      10000
    );

    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        clearTimeout(timer);
        resolve(channel);
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        clearTimeout(timer);
        reject(new Error("تعذّر الاتصال بقناة الإشارة"));
      }
    });
  });

  const entry = { channel, ready };
  outboundChannels.set(channelName, entry);

  // عند الفشل، أزل القيد ليُعاد بناؤه نظيفاً في المحاولة التالية
  ready.catch(() => {
    outboundChannels.delete(channelName);
    try {
      supabase.removeChannel(channel);
    } catch {
      /* تجاهل */
    }
  });

  return entry;
}

/** يغلق كل قنوات الإرسال المؤقتة (يُستدعى عند انتهاء المكالمة) */
function closeOutboundChannels() {
  const supabase = callState.ctx?.supabase;

  outboundChannels.forEach(({ channel }) => {
    try {
      supabase?.removeChannel(channel);
    } catch {
      /* تجاهل */
    }
  });

  outboundChannels.clear();
}

async function sendSignal(targetUserId, event, payload) {
  const supabase = callState.ctx?.supabase;
  if (!supabase || !targetUserId) return false;

  return (
    await safeAsync(`calls:signal:${event}`, async () => {
      if (supabase.realtime.connectionState?.() === "disconnected") {
        supabase.realtime.connect();
      }
      const { channel, ready } = getOutboundChannel(signalChannelName(targetUserId));

      await ready;

      const result = await channel.send({ type: "broadcast", event, payload });

      if (result === "timed out" || result === "error") {
        throw new Error(`تعذّر إرسال إشارة ${event} (${result})`);
      }

      return true;
    }, { retries: 1, delayMs: 700 })
  ).ok;
}

/** يشترك في قناة الإشارات الخاصة بالمستخدم الحالي لاستقبال المكالمات */
export function subscribeToIncomingCalls() {
  const supabase = callState.ctx?.supabase;
  const me = callState.ctx?.getMe?.();
  if (!supabase || !me?.id) return;

  unsubscribeFromIncomingCalls();

  callState.signalChannel = supabase
    .channel(signalChannelName(me.id), { config: { broadcast: { self: false } } })
    .on("broadcast", { event: "call:invite" }, ({ payload }) => {
      handleIncomingInvite(payload).catch((e) => console.error("[calls] invite", e));
    })
    .on("broadcast", { event: "call:accept" }, ({ payload }) => {
      handlePeerAccepted(payload);
    })
    .on("broadcast", { event: "call:decline" }, ({ payload }) => {
      handlePeerDeclined(payload);
    })
    .on("broadcast", { event: "call:end" }, ({ payload }) => {
      handlePeerEnded(payload);
    })
    .subscribe();
}

/** هل قناة الإشارات الواردة حيّة (منضمّة/قيد الانضمام)؟ — لتجنّب إعادة بنائها بلا سبب */
export function isIncomingCallChannelAlive() {
  const state = callState.signalChannel?.state;
  return state === "joined" || state === "joining";
}

export function unsubscribeFromIncomingCalls() {
  const supabase = callState.ctx?.supabase;
  if (supabase && callState.signalChannel) {
    try {
      supabase.removeChannel(callState.signalChannel);
    } catch {
      /* تجاهل */
    }
  }
  callState.signalChannel = null;
}

/* ------------------------------------------------------------
 * 5) سجل المكالمات في قاعدة البيانات
 * ---------------------------------------------------------- */
async function persistCallRoom(room) {
  const supabase = callState.ctx?.supabase;
  if (!supabase) return false;
  const activeRoom = await supabase
    .from("call_rooms")
    .select("id,status")
    .eq("conversation_id", room.conversationId)
    .in("status", ["ringing", "active"])
    .limit(1)
    .maybeSingle();
  if (activeRoom.error) {
    notify("تعذّر التحقق من حالة المكالمة. طبّق سياسات RLS الخاصة بالمكالمات.");
    return false;
  }
  if (activeRoom.data) {
    notify("توجد مكالمة جارية في هذه المحادثة.");
    return false;
  }
  const result = await safeQuery("calls:insert-room", () =>
    supabase.from("call_rooms").insert({
      id: room.roomId,
      conversation_id: room.conversationId,
      channel_name: room.channel,
      call_type: room.callType,
      caller_id: room.callerId,
      callee_id: room.calleeId,
      status: "ringing",
    })
  );
  if (!result.ok) {
    if (result.error?.code === "23505") {
      notify("توجد مكالمة جارية في هذه المحادثة.");
    } else {
      notify("تعذّر إنشاء غرفة المكالمة. طبّق schema.sql ثم أعد المحاولة.");
    }
  }
  return result.ok;
}

async function updateCallRoom(roomId, patch) {
  const supabase = callState.ctx?.supabase;
  if (!supabase || !roomId) return;
  await safeQuery("calls:update-room", () =>
    supabase.from("call_rooms").update(patch).eq("id", roomId)
  );
}

async function logCallEvent(roomId, event, meta = {}) {
  const supabase = callState.ctx?.supabase;
  const me = callState.ctx?.getMe?.();
  if (!supabase || !roomId || !me?.id) return false;
  const result = await safeQuery("calls:log", () =>
    supabase.from("call_logs").insert({
      room_id: roomId,
      user_id: me.id,
      event,
      metadata: meta,
    })
  );
  return result.ok;
}

/**
 * بطاقات المكالمات داخل المحادثة = رسائل تلقائية تُنشأ دون إرسال يدوي من المستخدم.
 * أُلغيت بطلب المنتج؛ لإعادتها غيّر القيمة إلى true فقط.
 */
const CALL_CHAT_CARDS_ENABLED = false;

/**
 * يكتب بطاقة سجل المكالمة داخل المحادثة (تظهر للطرفين كرسالة نظامية).
 * status: 'ended' (تم الرد — مع المدة) | 'missed' | 'declined' | 'failed' | 'network_lost'
 */
async function writeCallMessage(call, status, durationSeconds = 0) {
  const supabase = callState.ctx?.supabase;
  const me = callState.ctx?.getMe?.();
  if (!supabase || !call?.conversationId || !me?.id) return;

  // لا تُنشأ أي رسالة تلقائية في المحادثة: بطاقات المكالمات معطّلة.
  // سجل المكالمات (call_logs) يبقى كما هو، ويُستدعى onCallLogged كالمعتاد.
  if (!CALL_CHAT_CARDS_ENABLED) {
    try {
      callState.onCallLogged?.({ call, status, durationSeconds });
    } catch {
      /* تجاهل */
    }
    return;
  }
  // كلا الطرفين قد يرسل حدث الإنهاء؛ لا تعرض بطاقة المكالمة مرتين.
  const { data: existing } = await supabase
    .from("messages")
    .select("id")
    .eq("call_id", call.roomId)
    .maybeSingle();
  if (existing?.id) return;

  const typeLabel = call.callType === "video" ? "مكالمة فيديو" : "مكالمة صوتية";
  let label = typeLabel;
  if (status === "missed") label = `مكالمة فائتة (${call.callType === "video" ? "فيديو" : "صوتية"})`;
  else if (status === "declined") label = `${typeLabel} مرفوضة`;
  else if (status === "failed" || status === "network_lost") label = `${typeLabel} لم تكتمل`;
  const duration = durationSeconds ? ` · المدة ${formatDuration(durationSeconds)}` : "";

  // المتصل هو "المرسل" المنطقي لبطاقة المكالمة حتى لو كتبها المستقبل،
  // لكن RLS تشترط sender_id = auth.uid()؛ لذا نخزّن caller_id في عمود مستقل.
  const result = await safeQuery("calls:chat-message", () =>
    supabase.from("messages").insert({
      conversation_id: call.conversationId,
      sender_id: me.id,
      content: `${label}${duration}`,
      message_type: "call",
      call_id: call.roomId,
      call_type: call.callType || "audio",
      call_status: status,
      call_caller_id: call.callerId || (call.direction === "outgoing" ? me.id : call.peer?.id) || me.id,
      call_duration_seconds: durationSeconds || null,
      status: "sent",
    })
  );
  if (!result.ok && result.error?.code !== "23505") {
    console.warn("[calls] تعذّر إنشاء بطاقة سجل المكالمة:", result.error);
    return;
  }
  try {
    callState.onCallLogged?.({ call, status, durationSeconds });
  } catch {
    /* تجاهل */
  }
}

async function setCallPresence(status) {
  const supabase = callState.ctx?.supabase;
  const me = callState.ctx?.getMe?.();
  if (!supabase || !me?.id) return;
  await safeQuery("calls:presence", () =>
    supabase
      .from("profiles")
      .update({ call_status: status, call_status_at: new Date().toISOString() })
      .eq("id", me.id)
  );
}

/* ------------------------------------------------------------
 * 5-ب) حالة الوسائط لكل مكالمة + تلميح جلسة الصوت
 * ---------------------------------------------------------- */

/** يضبط القيم الافتراضية لمكالمة جديدة: مكبّر للفيديو وسماعة أذن للصوت (كواتساب) */
function beginCallMediaState(callType) {
  callState.audioRoute = callType === "video" ? AUDIO_ROUTE_SPEAKER : AUDIO_ROUTE_EARPIECE;
  callState.audioRouteTouched = false;
  callState.routeBusy = false;
  callState.facingMode = "user";
  callState.switchingCamera = false;
  setAudioSessionType("play-and-record");
}

/**
 * تلميح لنظام التشغيل بأن الصفحة في مكالمة (تسجيل + تشغيل). مدعوم في Safari
 * (iOS 16.4+) فقط؛ وفي غيره يُتجاهل بصمت. لا نغيّره أثناء المكالمة لتفادي
 * مقاطعة الصوت.
 */
function setAudioSessionType(type) {
  try {
    if ("audioSession" in navigator && navigator.audioSession) {
      navigator.audioSession.type = type;
    }
  } catch {
    /* متصفح لا يسمح بالتغيير — تجاهل */
  }
}

/* ------------------------------------------------------------
 * 6) إدارة Agora RTC
 * ---------------------------------------------------------- */
async function fetchAgoraToken(channel, uid) {
  if (!AGORA.tokenEndpoint) {
    // A secured Agora project rejects tokenless joins with
    // CAN_NOT_GET_GATEWAY_SERVER / dynamic use static key. Fail before join
    // so the user gets an actionable message instead of a noisy SDK error.
    throw new Error(
      "Agora يحتاج إلى توكن أمان. فعّل نقطة AGORA_TOKEN_ENDPOINT أو عطّل App Certificate في Agora Console (Testing)."
    );
  }

  const result = await safeAsync("calls:token", async () => {
    const authResult = await callState.ctx?.supabase?.auth?.getSession?.();
    const accessToken = authResult?.data?.session?.access_token;
    const headers = { "Content-Type": "application/json" };
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

    const res = await fetch(AGORA.tokenEndpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ channelName: channel, uid }),
    });
    if (!res.ok) throw new Error(`خادم التوكن أعاد ${res.status}`);
    const json = await res.json();
    return json?.token || null;
  });

  if (!result.ok || !result.data) {
    throw result.error || new Error("لم يُرجع خادم Agora توكناً صالحاً.");
  }

  return result.data;
}

function attachClientHandlers(client) {
  client.on("user-published", async (user, mediaType) => {
    await safeAsync("calls:subscribe-remote", async () => {
      await client.subscribe(user, mediaType);
      callState.remoteUsers.set(user.uid, user);

      if (mediaType === "video") {
        safeDom("remote-video", () => {
          const container = document.getElementById("call-remote-video");
          if (container) {
            container.innerHTML = "";
            user.videoTrack?.play(container, { fit: "cover" });
            container.classList.add("has-video");
            document.getElementById("call-peer-card")?.classList.add("compact");
            document.getElementById("call-stage")?.classList.add("remote-video-on");
          }
        });
      }

      if (mediaType === "audio") {
        user.audioTrack?.play();
        // طبّق مخرج الصوت الذي اختاره المستخدم (إن اختار صراحةً)
        if (callState.audioRouteTouched) {
          applyAudioRoute(callState.audioRoute).catch(() => {});
        }
      }
    });
  });

  client.on("user-unpublished", (user, mediaType) => {
    if (mediaType === "video") {
      safeDom("remote-video-off", () => {
        const container = document.getElementById("call-remote-video");
        if (container) {
          container.innerHTML = "";
          container.classList.remove("has-video");
          document.getElementById("call-peer-card")?.classList.remove("compact");
          document.getElementById("call-stage")?.classList.remove("remote-video-on");
        }
      });
    }
  });

  client.on("network-quality", (stats) => {
    safeDom("call-quality", () => {
      const el = document.getElementById("call-quality");
      if (!el) return;
      // 0 غير معروف، 1 ممتاز ... 6 منقطع
      const q = Math.max(stats?.downlinkNetworkQuality || 0, stats?.uplinkNetworkQuality || 0);
      const bars = q === 0 ? 4 : q <= 2 ? 4 : q === 3 ? 3 : q === 4 ? 2 : 1;
      el.dataset.bars = String(bars);
      el.classList.toggle("poor", q >= 5);
    });
  });

  client.on("user-left", (user) => {
    callState.remoteUsers.delete(user.uid);
    if (callState.remoteUsers.size === 0 && callState.current) {
      notify("انتهت المكالمة — غادر الطرف الآخر.");
      endCall("ended", { silent: true });
    }
  });

  client.on("connection-state-change", (curr) => {
    if (curr === "DISCONNECTED" && callState.current) {
      setCallStatus("انقطع الاتصال", { animated: true });
    } else if (curr === "RECONNECTING") {
      setCallStatus("إعادة الاتصال", { animated: true });
    } else if (curr === "CONNECTED" && callState.current?.connected) {
      setCallStatus("");
    }
  });

  client.on("exception", (evt) => {
    if (evt?.code === 1003 || evt?.code === 3003) return;
    console.warn("[calls] Agora exception:", evt?.code, evt?.msg);
  });
}

async function joinAgoraChannel({ channel, callType }) {
  const AgoraRTC = await loadAgoraSdk();

  const me = callState.ctx?.getMe?.();
  const uid = uidFromUserId(me?.id);

  const client = AgoraRTC.createClient({ mode: AGORA.mode, codec: AGORA.codec });
  callState.client = client;
  attachClientHandlers(client);

  const token = await fetchAgoraToken(channel, uid);
  await client.join(AGORA.appId, channel, token || null, uid);

  // --- المسارات المحلية ---
  const tracks = [];

  const audioResult = await safeAsync("calls:mic-track", () =>
    AgoraRTC.createMicrophoneAudioTrack({
      encoderConfig: AGORA.audioProfile,
      AEC: true, // إلغاء الصدى
      ANS: true, // تقليل الضوضاء
      AGC: true, // تحكم تلقائي بمستوى الصوت
    })
  );

  if (audioResult.ok && audioResult.data) {
    callState.localAudioTrack = audioResult.data;
    tracks.push(audioResult.data);
  } else {
    notify("تعذّر الوصول إلى الميكروفون — تحقق من أذونات المتصفح.");
  }

  if (callType === "video") {
    const videoResult = await safeAsync("calls:cam-track", () =>
      AgoraRTC.createCameraVideoTrack({
        encoderConfig: AGORA.videoProfile,
        optimizationMode: "motion",
      })
    );

    if (videoResult.ok && videoResult.data) {
      callState.localVideoTrack = videoResult.data;
      tracks.push(videoResult.data);

      safeDom("local-video", () => {
        const container = document.getElementById("call-local-video");
        if (container) {
          container.innerHTML = "";
          container.classList.remove("hidden");
          videoResult.data.play(container, {
            fit: "cover",
            mirror: shouldMirrorLocalPreview(callState.facingMode),
          });
        }
      });
    } else {
      notify("تعذّر الوصول إلى الكاميرا — ستتم المتابعة بالصوت فقط.");
    }
  }

  if (tracks.length) {
    await safeAsync("calls:publish", () => client.publish(tracks));
  }

  return client;
}

async function releaseLocalTracks() {
  for (const key of ["localAudioTrack", "localVideoTrack"]) {
    const track = callState[key];
    if (!track) continue;
    try {
      track.stop();
      track.close();
    } catch (err) {
      console.warn("[calls] track release", err);
    }
    callState[key] = null;
  }
}

async function leaveAgoraChannel() {
  await releaseLocalTracks();

  if (callState.client) {
    await safeAsync("calls:leave", async () => {
      callState.client.removeAllListeners?.();
      await callState.client.leave();
    });
    callState.client = null;
  }

  callState.remoteUsers.clear();

  safeDom("clear-videos", () => {
    const remote = document.getElementById("call-remote-video");
    const local = document.getElementById("call-local-video");
    if (remote) {
      remote.innerHTML = "";
      remote.classList.remove("has-video");
    }
    if (local) {
      local.innerHTML = "";
      local.classList.add("hidden");
    }
    document.getElementById("call-peer-card")?.classList.remove("compact");
    document.getElementById("call-stage")?.classList.remove("remote-video-on");
  });
}

/** يحوّل أخطاء الانضمام التقنية إلى رسالة مفهومة وقابلة للتصرّف */
function describeJoinFailure(error) {
  const msg = String(error?.message || "");

  if (/Agora RTC|مكتبة Agora|AgoraRTC/i.test(msg)) {
    return "تعذّر تحميل مكتبة المكالمات — تحقق من الاتصال أو من حاجب الإعلانات ثم أعد المحاولة.";
  }

  // أخطاء أذونات الأجهزة من Agora
  if (/PERMISSION_DENIED|NotAllowedError/i.test(msg)) {
    return "تم رفض إذن الكاميرا/الميكروفون — فعّله من إعدادات المتصفح.";
  }

  if (/NotFoundError|DEVICE_NOT_FOUND/i.test(msg)) {
    return "لم يُعثر على كاميرا أو ميكروفون متصل بالجهاز.";
  }

  if (/AGORA يحتاج إلى توكن|CAN_NOT_GET_GATEWAY_SERVER|dynamic use static key|invalid token|INVALID_TOKEN/i.test(msg)) {
    return "تعذّر اتصال Agora لأن المشروع يستخدم App Certificate بدون توكن. اضبط AGORA_TOKEN_ENDPOINT أو عطّل الشهادة من Agora Console للاختبار.";
  }

  if (/INVALID_VENDOR_KEY/i.test(msg)) {
    return "معرّف مشروع Agora غير صحيح — راجع App ID في js/config.js.";
  }

  return "تعذّر بدء المكالمة: " + (msg || "خطأ غير معروف");
}

/* ------------------------------------------------------------
 * 7) تدفق المكالمة الصادرة
 * ---------------------------------------------------------- */
export async function startCall(callType = "audio") {
  if (callState.current || callState.joining) {
    notify("هناك مكالمة جارية بالفعل.");
    return;
  }

  if (!isAgoraConfigured()) {
    notify("مكالمات Agora غير مهيّأة بعد — أضف App ID في js/config.js.");
    return;
  }

  const me = callState.ctx?.getMe?.();
  const conv = callState.ctx?.getActiveConversation?.();

  if (!me?.id) {
    notify("يجب تسجيل الدخول أولاً.");
    return;
  }

  if (!conv?.id || !conv?.otherProfile?.id) {
    notify("افتح محادثة أولاً لبدء مكالمة.");
    return;
  }

  if (!navigator.onLine) {
    notify("لا يمكن إجراء مكالمة بدون اتصال بالإنترنت.");
    return;
  }

  callState.joining = true;

  const roomId = uuid();
  const channel = buildAgoraChannelName(conv.id);
  const peer = conv.otherProfile;

  callState.current = {
    roomId,
    channel,
    callType,
    peer,
    conversationId: conv.id,
    direction: "outgoing",
    callerId: me.id,
    calleeId: peer.id,
    connected: false,
  };

  unlockAudio();
  beginCallMediaState(callType);
  setPeerInfo(peer);
  setCallPhase("ringing");
  setCallStatus("جارٍ الاتصال", { animated: true });
  setOverlayVisible(true);
  updateControlsForType(callType);
  // تبدأ المكالمة من نقرة مستخدم، لذلك يسمح المتصفح بتشغيل النغمة هنا.
  playRingtone("outgoing");

  const roomCreated = await persistCallRoom({
    roomId,
    conversationId: conv.id,
    channel,
    callType,
    callerId: me.id,
    calleeId: peer.id,
  });
  if (!roomCreated) {
    callState.current = null;
    callState.joining = false;
    setOverlayVisible(false);
    return;
  }

  await logCallEvent(roomId, "initiated", { call_type: callType });
  await setCallPresence("in_call");

  const delivered = await sendSignal(peer.id, "call:invite", {
    roomId,
    channel,
    callType,
    conversationId: conv.id,
    // تصريح صريح بالمستهدف: المستقبل يرفض أي دعوة لا تحمل معرّفه (v2.9)
    calleeId: peer.id,
    caller: {
      id: me.id,
      display_name: me.display_name,
      avatar_url: me.avatar_url || null,
    },
  });

  if (!delivered) {
    notify("تعذّر إرسال دعوة المكالمة — قد يكون الطرف الآخر غير متصل.");
  } else {
    setCallStatus("يرن", { animated: true });
  }

  // انضم للقناة مباشرة حتى يسمع/يرى فوراً عند قبول الطرف الآخر
  const joined = await safeAsync("calls:join-outgoing", () =>
    joinAgoraChannel({ channel, callType })
  );

  callState.joining = false;

  if (!joined.ok) {
    notify(describeJoinFailure(joined.error));
    await endCall("failed");
    return;
  }

  // مهلة الرنين
  clearTimeout(callState.ringTimer);
  callState.ringTimer = setTimeout(() => {
    if (callState.current && !callState.current.connected) {
      notify("لم يرد الطرف الآخر على المكالمة.");
      endCall("missed");
    }
  }, AGORA.ringTimeoutMs);
}

/* ------------------------------------------------------------
 * 8) تدفق المكالمة الواردة
 *    مصدر الدعوة إما Realtime (التطبيق مفتوح) أو Push (التطبيق مغلق/في الخلفية
 *    أو Realtime متأخر). كلاهما يمر من هنا فيُطبَّق التحقق نفسه ومنع التكرار.
 * ---------------------------------------------------------- */
async function handleIncomingInvite(payload) {
  if (!payload?.roomId) return;

  const me = callState.ctx?.getMe?.();
  if (!me?.id) return;

  // 🔁 منع التكرار: الدعوة قد تصل مرتين (Realtime + Push) أو بعد أن رنّت/أُنهيت.
  //    نسجّل الغرفة فوراً (قبل أي await) حتى لا تمرّ النسختان معاً.
  if (callState.handledRooms.has(payload.roomId)) return;
  callState.handledRooms.add(payload.roomId);

  // ⛔ عزل الرنين: لا يرن هذا الجهاز إلا إذا كان هو callee_id الفعلي في غرفة
  //    المكالمة المسجَّلة في قاعدة البيانات. أي دعوة أخرى (بث خاطئ، مراقبة
  //    المشرف العام، دعوة أُلغيت) تُتجاهل تماماً بلا رنين ولا إشعار.
  const supabase = callState.ctx?.supabase;
  const { ok, data: room } = await safeQuery("calls:verify-invite", () =>
    supabase
      .from("call_rooms")
      .select("id, caller_id, callee_id, status, conversation_id, channel_name, call_type")
      .eq("id", payload.roomId)
      .maybeSingle()
  );

  const verdict = shouldRingForInvite({ payload, room, roomChecked: ok, meId: me.id });
  if (!verdict.ring) {
    console.warn("[calls] تجاهل دعوة مكالمة ليست موجّهة لهذا الجهاز:", verdict.reason);
    return;
  }

  // دعوة Push لا تحمل القناة ولا النوع (حمولة قصيرة): نكمّلها من الغرفة نفسها
  const invite = {
    ...payload,
    channel: payload.channel || room?.channel_name || "",
    callType: payload.callType || room?.call_type || "audio",
    conversationId: payload.conversationId || room?.conversation_id || null,
  };
  if (!invite.channel) {
    console.warn("[calls] دعوة بلا قناة صالحة — تعذّر الرنين");
    return;
  }

  // مشغول بمكالمة أخرى → ارفض تلقائياً
  if (callState.current || callState.incoming) {
    await sendSignal(invite.caller?.id, "call:decline", {
      roomId: invite.roomId,
      reason: "busy",
    });
    return;
  }

  callState.incoming = invite;

  safeDom("incoming-show", () => {
    const box = ensureIncomingDialog();
    const nameEl = box.querySelector("#incoming-name");
    const subEl = box.querySelector("#incoming-sub");
    const kindEl = box.querySelector("#incoming-kind");
    const avatarEl = box.querySelector("#incoming-avatar");
    const initialEl = box.querySelector("#incoming-initial");
    const isVideo = invite.callType === "video";

    if (nameEl) nameEl.textContent = invite.caller?.display_name || "مكالمة واردة";
    if (kindEl) kindEl.textContent = isVideo ? "🎥 مكالمة فيديو واردة" : "📞 مكالمة صوتية واردة";
    if (subEl) subEl.textContent = "🔒 مشفّرة من طرف إلى طرف";
    const hasAvatar = Boolean(invite.caller?.avatar_url);
    if (avatarEl) {
      avatarEl.src = hasAvatar ? invite.caller.avatar_url : "";
      avatarEl.classList.toggle("hidden", !hasAvatar);
    }
    if (initialEl) {
      initialEl.textContent = initialOf(invite.caller?.display_name);
      initialEl.classList.toggle("hidden", hasAvatar);
    }

    box.classList.remove("hidden");
  });

  playRingtone("incoming");
  showIncomingSystemNotification(invite);

  clearTimeout(callState.ringTimer);
  callState.ringTimer = setTimeout(() => {
    if (callState.incoming?.roomId === invite.roomId) {
      hideIncomingDialog();
      logCallEvent(invite.roomId, "missed", {});
      writeCallMessage({
        roomId: invite.roomId,
        conversationId: invite.conversationId,
        callType: invite.callType,
        callerId: invite.caller?.id,
        peer: invite.caller,
        direction: "incoming",
      }, "missed");
      callState.incoming = null;
    }
  }, AGORA.ringTimeoutMs);
}

/**
 * يعالج حدث Push للمكالمات (incoming_call / call_ended) القادم من:
 *   • Service Worker عندما يكون التطبيق ظاهراً (window event: wa-call-push)
 *   • onMessage لـ FCM في المقدمة (نفس الحدث)
 * الحمولة من send-push: { type, roomId, callerId, calleeId, callType, conversationId, title, icon }
 */
async function handleCallPushEvent(detail) {
  const type = String(detail?.type || "");
  const data = detail?.data || {};
  const roomId = String(data.roomId || "");
  if (!roomId || !isCallPushType(type)) return;

  if (type === "call_ended") {
    // إنهاء من الطرف الآخر: يُغلق الرنين أو المكالمة الجارية لهذه الغرفة فقط
    handlePeerEnded({ roomId });
    return;
  }

  const me = callState.ctx?.getMe?.();
  if (!me?.id) return;

  // 🔒 الحمولة تصرّح بالمستهدف: أي دعوة لغير هذا الحساب تُتجاهل فوراً
  if (data.calleeId && data.calleeId !== me.id) {
    console.warn("[calls] push مكالمة موجّه لحساب آخر — تجاهل");
    return;
  }

  await handleIncomingInvite({
    roomId,
    calleeId: me.id,
    callType: data.callType === "video" ? "video" : "audio",
    conversationId: data.conversationId || null,
    caller: {
      id: data.callerId || null,
      display_name: data.title || "مكالمة واردة",
      avatar_url: data.icon || null,
    },
  });
}

/**
 * يفتح شاشة الرنين لغرفة مكالمة محددة — يُستدعى عند النقر على إشعار المكالمة
 * (التطبيق كان مغلقاً فلم تصل دعوة Realtime أصلاً). يتحقق من الغرفة في قاعدة
 * البيانات: يجب أن يكون هذا الحساب callee والغرفة ما زالت «ringing».
 *
 * @returns {Promise<boolean>} true إن عُولج الطلب (رنين معروض أو رفض أُرسل)
 */
export async function presentIncomingCallFromRoom(roomId, { action = "answer" } = {}) {
  const supabase = callState.ctx?.supabase;
  const me = callState.ctx?.getMe?.();
  if (!supabase || !me?.id || !roomId) return false;

  if (callState.current?.roomId === roomId) return true;
  if (callState.incoming?.roomId === roomId) return true;

  const { ok, data: room } = await safeQuery("calls:route-room", () =>
    supabase
      .from("call_rooms")
      .select("id, caller_id, callee_id, status, conversation_id, channel_name, call_type")
      .eq("id", roomId)
      .maybeSingle()
  );
  if (!ok || !room) return false;
  // 🔒 عزل: لا يُعرض رنين إلا لـ callee الفعلي، وبشرط أن الغرفة ما زالت ترنّ
  if (room.callee_id !== me.id || room.status !== "ringing") return false;

  // حداثة الرنين تُحسب بساعة قاعدة البيانات (RPC) لا بساعة الجهاز.
  // إن لم تكن الهجرة v2.10 مُطبَّقة، يُكتفى بفحص الحالة أعلاه.
  const fresh = await safeQuery("calls:ring-fresh", () =>
    supabase.rpc("call_room_is_ringing", { p_room: roomId })
  );
  if (fresh.ok && fresh.data === false) return false;

  const { data: caller } = await safeQuery("calls:route-caller", () =>
    supabase
      .from("profiles")
      .select("id, display_name, avatar_url")
      .eq("id", room.caller_id)
      .maybeSingle()
  );

  const invite = {
    roomId,
    channel: room.channel_name,
    callType: room.call_type === "video" ? "video" : "audio",
    conversationId: room.conversation_id,
    calleeId: me.id,
    caller: {
      id: room.caller_id,
      display_name: caller?.display_name || "مكالمة واردة",
      avatar_url: caller?.avatar_url || null,
    },
  };

  if (action === "decline") {
    // الرفض من الإشعار: نفس مسار الرفض من الشاشة (يُرسل للمتصل ويحدّث الغرفة)
    callState.handledRooms.add(roomId);
    callState.incoming = invite;
    await declineIncomingCall();
    return true;
  }

  await handleIncomingInvite(invite);
  return callState.incoming?.roomId === roomId || callState.current?.roomId === roomId;
}

function hideIncomingDialog() {
  stopRingtone();
  clearTimeout(callState.ringTimer);
  if (callState.incoming?.roomId) closeIncomingSystemNotification(callState.incoming.roomId);
  safeDom("incoming-hide", () => {
    document.getElementById("incoming-call")?.classList.add("hidden");
  });
}

async function acceptIncomingCall() {
  const invite = callState.incoming;
  if (!invite) return;

  callState.incoming = null;
  hideIncomingDialog();

  if (!isAgoraConfigured()) {
    notify("مكالمات Agora غير مهيّأة على هذا الجهاز.");
    return;
  }

  callState.current = {
    roomId: invite.roomId,
    channel: invite.channel,
    callType: invite.callType,
    peer: invite.caller,
    conversationId: invite.conversationId,
    direction: "incoming",
    callerId: invite.caller?.id,
    calleeId: callState.ctx?.getMe?.()?.id,
    connected: true,
    startedAt: Date.now(),
  };

  unlockAudio();
  beginCallMediaState(invite.callType);
  setPeerInfo(invite.caller);
  setCallPhase("connecting");
  setCallStatus("جارٍ الانضمام", { animated: true });
  setOverlayVisible(true);
  updateControlsForType(invite.callType);

  await sendSignal(invite.caller?.id, "call:accept", { roomId: invite.roomId });
  await updateCallRoom(invite.roomId, {
    status: "active",
    answered_at: new Date().toISOString(),
  });
  await logCallEvent(invite.roomId, "answered", {});
  await setCallPresence("in_call");

  const joined = await safeAsync("calls:join-incoming", () =>
    joinAgoraChannel({ channel: invite.channel, callType: invite.callType })
  );

  if (!joined.ok) {
    notify(describeJoinFailure(joined.error));
    await endCall("failed");
    return;
  }

  setCallPhase("connected");
  setCallStatus("");
  playConnectedTone();
  startDurationTimer();
}

async function declineIncomingCall() {
  const invite = callState.incoming;
  callState.incoming = null;
  hideIncomingDialog();

  if (!invite) return;

  await sendSignal(invite.caller?.id, "call:decline", {
    roomId: invite.roomId,
    reason: "declined",
  });
  await updateCallRoom(invite.roomId, {
    status: "declined",
    ended_at: new Date().toISOString(),
  });
  await logCallEvent(invite.roomId, "declined", {});
}

/* ------------------------------------------------------------
 * 9) أحداث الطرف الآخر
 * ---------------------------------------------------------- */
function handlePeerAccepted(payload) {
  if (!callState.current || callState.current.roomId !== payload?.roomId) return;
  callState.current.connected = true;
  callState.current.startedAt = Date.now();
  clearTimeout(callState.ringTimer);
  stopRingtone();
  setCallPhase("connected");
  setCallStatus("");
  playConnectedTone();
  startDurationTimer();
  updateCallRoom(payload.roomId, {
    status: "active",
    answered_at: new Date().toISOString(),
  });
}

function handlePeerDeclined(payload) {
  if (payload?.roomId) callState.handledRooms.add(payload.roomId);
  if (!callState.current || callState.current.roomId !== payload?.roomId) return;
  notify(payload?.reason === "busy" ? "الطرف الآخر مشغول حالياً." : "تم رفض المكالمة.");
  setCallStatus(payload?.reason === "busy" ? "مشغول" : "تم الرفض");
  stopRingtone();
  playBusyTone();
  endCall("declined", { silent: true });
}

function handlePeerEnded(payload) {
  if (payload?.roomId) callState.handledRooms.add(payload.roomId);
  if (callState.current && callState.current.roomId === payload?.roomId) {
    endCall("ended", { silent: true });
    return;
  }
  if (callState.incoming && callState.incoming.roomId === payload?.roomId) {
    callState.incoming = null;
    hideIncomingDialog();
  }
}

/* ------------------------------------------------------------
 * 10) إنهاء المكالمة وتنظيف الموارد
 * ---------------------------------------------------------- */
export async function endCall(reason = "ended", { silent = false } = {}) {
  const call = callState.current;

  clearTimeout(callState.ringTimer);
  stopDurationTimer();
  stopRingtone();
  callState.joining = false;

  // إلغاء المتصل قبل الرد = مكالمة فائتة لدى الطرف الآخر
  let effectiveReason = reason;
  if (call && !call.connected && reason === "ended" && call.direction === "outgoing") {
    effectiveReason = "missed";
  }

  if (call) {
    setCallPhase("ended");
    setCallStatus(
      effectiveReason === "missed"
        ? "لم يتم الرد"
        : effectiveReason === "declined"
          ? "تم رفض المكالمة"
          : "انتهت المكالمة"
    );
    if (reason !== "declined") playEndedTone();
    // لحظة قصيرة ليقرأ المستخدم الحالة (كما في واتساب)
    await new Promise((r) => setTimeout(r, call.connected ? 900 : 700));
  }

  await leaveAgoraChannel();

  setOverlayVisible(false);
  setCallStatus("");
  safeDom("reset-timer", () => {
    const el = document.getElementById("call-timer");
    if (el) el.textContent = "";
  });

  callState.micMuted = false;
  callState.cameraOff = false;
  callState.current = null;
  callState.audioRouteTouched = false;
  callState.routeBusy = false;
  callState.switchingCamera = false;
  callState.facingMode = "user";
  setAudioSessionType("auto");
  safeDom("reset-ctrls", () => {
    document.getElementById("call-btn-mic")?.classList.remove("active");
    document.getElementById("call-btn-cam")?.classList.remove("active");
    const micIcon = document.querySelector("#call-btn-mic .call-ctrl-icon");
    if (micIcon) micIcon.textContent = "🎙️";
    const camIcon = document.querySelector("#call-btn-cam .call-ctrl-icon");
    if (camIcon) camIcon.textContent = "📷";
    setFlipBusy(false);
  });
  renderAudioRouteButton();

  await setCallPresence("available");

  if (!call) return;

  if (!silent) {
    await sendSignal(call.peer?.id, "call:end", { roomId: call.roomId });
  }

  await updateCallRoom(call.roomId, {
    status: effectiveReason,
    ended_at: new Date().toISOString(),
  });
  await logCallEvent(call.roomId, effectiveReason, { direction: call.direction });
  const durationSeconds = call.connected && call.startedAt
    ? Math.max(1, Math.floor((Date.now() - call.startedAt) / 1000))
    : 0;
  const messageStatus = call.connected ? "ended" : effectiveReason === "ended" ? "ended" : effectiveReason;
  await writeCallMessage(call, messageStatus, durationSeconds);

  // حرّر قنوات الإشارة بعد اكتمال إرسال call:end
  closeOutboundChannels();
}

/* ------------------------------------------------------------
 * 11) ضوابط واجهة المكالمة
 * ---------------------------------------------------------- */
function updateControlsForType(callType) {
  safeDom("call-controls", () => {
    const isVideo = callType === "video";
    document.getElementById("call-stage")?.setAttribute("data-type", isVideo ? "video" : "audio");
    document.getElementById("call-btn-cam")?.classList.toggle("hidden", !isVideo);
    // زر التبديل بين الأمامية والخلفية: للفيديو فقط
    document.getElementById("call-btn-flip")?.classList.toggle("hidden", !isVideo);
    // زر مخرج الصوت متاح للصوت والفيديو معاً
    document.getElementById("call-btn-speaker")?.classList.remove("hidden");
    // المعاينة المحلية تظهر فقط عند تشغيل مسار الفيديو فعلياً (renderLocalPreview)
    if (!isVideo) document.getElementById("call-local-video")?.classList.add("hidden");
  });
  renderAudioRouteButton();
}

/* ------------------------------------------------------------
 * مخرج الصوت: مكبّر الصوت ⇄ سماعة الأذن
 *
 * الآلية: Agora `IRemoteAudioTrack.setPlaybackDevice(deviceId)` بعد اختيار
 * جهاز الإخراج المناسب من `AgoraRTC.getPlaybackDevices()` بالاسم.
 * الدعم الفعلي يعتمد على المتصفح:
 *   • Chrome/Edge للحاسوب: يعمل (اختيار مخرج معيّن من القائمة).
 *   • Chrome/Firefox للأندرويد وأغلب متصفحات الهاتف: setSinkId غير متاح ⇒ «محدود».
 *   • Safari (iOS): setSinkId متاح من iOS 18.4 لكن قائمة الإخراج قد لا تحوي سماعة أذن.
 * عند عدم الدعم لا نخفّض الصوت كبديل (كان ذلك تمثيلاً زائفاً)، بل نُبلغ المستخدم.
 * ---------------------------------------------------------- */

/** هل يحتمل هذا المتصفح تغيير مخرج الصوت؟ (لتلوين الزر وشرح الحد) */
function audioRoutingSupported() {
  return supportsAudioRouting({
    hasSetSinkId:
      typeof window !== "undefined" &&
      Boolean(window.HTMLAudioElement?.prototype) &&
      "setSinkId" in window.HTMLAudioElement.prototype,
  });
}

/** يطبّق المخرج على كل مسارات الصوت البعيدة الحالية. يعيد { ok, reason } */
async function applyAudioRoute(route) {
  const tracks = [...callState.remoteUsers.values()]
    .map((user) => user.audioTrack)
    .filter(Boolean);

  if (!tracks.length) return { ok: true, reason: "pending" };
  if (!audioRoutingSupported()) return { ok: false, reason: "unsupported" };

  const AgoraRTC = await loadAgoraSdk();
  let devices = [];
  try {
    devices = await AgoraRTC.getPlaybackDevices();
  } catch {
    return { ok: false, reason: "unsupported" };
  }

  const deviceId = pickOutputDevice(devices, route);
  if (!deviceId) {
    return {
      ok: false,
      reason: route === AUDIO_ROUTE_EARPIECE ? "no-earpiece" : "no-speaker",
    };
  }

  let applied = 0;
  for (const track of tracks) {
    try {
      await track.setPlaybackDevice(deviceId);
      applied += 1;
    } catch (error) {
      if (/NOT_SUPPORTED/i.test(String(error?.code || error?.message || ""))) {
        return { ok: false, reason: "unsupported" };
      }
      console.warn("[calls] تعذّر تعيين مخرج الصوت:", error);
    }
  }
  return { ok: applied > 0, reason: applied > 0 ? "applied" : "failed" };
}

const ROUTE_MESSAGES = {
  unsupported:
    "هذا المتصفح لا يتيح للتطبيق تغيير مخرج الصوت. استخدم زر الصوت في جهازك، أو غيّر المخرج من مركز التحكم بالهاتف.",
  "no-earpiece": "لا توجد سماعة أذن منفصلة على هذا الجهاز — الصوت يعمل عبر المخرج الافتراضي.",
  "no-speaker": "لم يُعثر على مكبّر صوت منفصل على هذا الجهاز — الصوت يعمل عبر المخرج الافتراضي.",
  failed: "تعذّر تغيير مخرج الصوت الآن. حاول مرة أخرى.",
};

/** يبدّل المخرج بين السماعة وسماعة الأذن عند الضغط على الزر */
async function toggleAudioRoute() {
  if (!callState.current || callState.routeBusy) return;

  const next =
    callState.audioRoute === AUDIO_ROUTE_SPEAKER ? AUDIO_ROUTE_EARPIECE : AUDIO_ROUTE_SPEAKER;

  callState.routeBusy = true;
  renderAudioRouteButton();
  const result = await safeAsync("calls:audio-route", () => applyAudioRoute(next));
  callState.routeBusy = false;

  const outcome = result.ok && result.data ? result.data : { ok: false, reason: "failed" };

  if (outcome.ok) {
    callState.audioRoute = next;
    callState.audioRouteTouched = true;
    // لا توجد أجهزة بعد (الطرف الآخر لم ينشر صوته) ⇒ يُطبَّق عند وصوله
  } else {
    notify(ROUTE_MESSAGES[outcome.reason] || ROUTE_MESSAGES.failed);
  }
  renderAudioRouteButton();
}

/** يحدّث شكل زر المخرج: الحالة النشطة + الشرح عند عدم الدعم */
function renderAudioRouteButton() {
  safeDom("speaker-btn", () => {
    const btn = document.getElementById("call-btn-speaker");
    if (!btn) return;
    const supported = audioRoutingSupported();
    // لا نعرض حالة مخرج قبل أن يُطبَّق توجيه فعلي: قبل لمس الزر يبقى الصوت على
    // المخرج الافتراضي للمتصفح/الجهاز، فيكون الزر محايداً (لا «سماعة أذن» كاذبة).
    const applied = supported && callState.audioRouteTouched;
    const isSpeaker = callState.audioRoute === AUDIO_ROUTE_SPEAKER;
    const label = applied ? (isSpeaker ? "السماعة" : "سماعة الأذن") : "المخرج";
    const icon = applied ? (isSpeaker ? "🔊" : "📱") : "🔈";

    btn.classList.toggle("active", applied && isSpeaker);
    btn.classList.toggle("unsupported", !supported);
    btn.classList.toggle("busy", callState.routeBusy);
    btn.disabled = callState.routeBusy;
    btn.setAttribute("aria-pressed", String(applied && isSpeaker));
    btn.title = !supported
      ? "هذا المتصفح لا يتيح تغيير مخرج الصوت — يتحكم فيه نظام الجهاز"
      : !applied
        ? "المخرج الافتراضي للجهاز — اضغط لتغييره"
        : isSpeaker
          ? "المخرج: مكبّر الصوت — اضغط للتحويل إلى سماعة الأذن"
          : "المخرج: سماعة الأذن — اضغط للتحويل إلى مكبّر الصوت";

    const iconEl = btn.querySelector(".call-ctrl-icon");
    if (iconEl) iconEl.textContent = icon;
    const labelEl = btn.querySelector(".call-ctrl-label");
    if (labelEl) labelEl.textContent = label;
  });
}

/** يُظهر/يُخفي حالة «جارٍ التبديل» على زر الكاميرا */
function setFlipBusy(busy) {
  safeDom("flip-busy", () => {
    const btn = document.getElementById("call-btn-flip");
    if (!btn) return;
    btn.disabled = Boolean(busy);
    btn.classList.toggle("busy", Boolean(busy));
  });
}

/** يعيد عرض المعاينة المحلية بالاتجاه الحالي (مرآة للأمامية فقط) */
function renderLocalPreview(track) {
  safeDom("local-preview", () => {
    const container = document.getElementById("call-local-video");
    if (!container || !track) return;
    try {
      track.stop();
    } catch {
      /* تجاهل — قد لا يكون مُشغَّلاً بعد */
    }
    container.innerHTML = "";
    track.play(container, {
      fit: "cover",
      mirror: shouldMirrorLocalPreview(callState.facingMode),
    });
    container.classList.remove("hidden");
  });
}

/* ------------------------------------------------------------
 * تبديل الكاميرا: الأمامية ⇄ الخلفية دون قطع المكالمة
 *
 * الآلية الأساسية: ICameraVideoTrack.setDevice({ facingMode }) (مدعومة منذ
 * Agora 4.19) — تبدّل مصدر الفيديو على المسار نفسه، فلا يُعاد النشر ولا تنقطع
 * المكالمة. احتياطياً (متصفحات لا تدعم facingMode): التبديل بين الكاميرات بالمعرّف.
 * ---------------------------------------------------------- */
async function switchCamera() {
  const track = callState.localVideoTrack;
  if (!track || callState.switchingCamera || callState.cameraOff) {
    if (callState.cameraOff) notify("شغّل الكاميرا أولاً ثم بدّل بينها.");
    return;
  }

  callState.switchingCamera = true;
  setFlipBusy(true);

  try {
    const target = nextFacingMode(callState.facingMode);

    const result = await safeAsync("calls:switch-cam", async () => {
      try {
        await track.setDevice({ facingMode: target });
        return facingFromSettings(track.getMediaStreamTrack?.()?.getSettings?.()) || target;
      } catch (primaryError) {
        // احتياط: تبديل بالمعرّف بين الكاميرات المتاحة
        const AgoraRTC = await loadAgoraSdk();
        const cameras = await AgoraRTC.getCameras();
        const currentDeviceId = track.getMediaStreamTrack?.()?.getSettings?.()?.deviceId || "";
        const alt = pickAlternateCamera(cameras, currentDeviceId);
        if (!alt) {
          const err = new Error("NO_OTHER_CAMERA");
          err.cause = primaryError;
          throw err;
        }
        await track.setDevice(alt.deviceId);
        return facingFromSettings(track.getMediaStreamTrack?.()?.getSettings?.()) || target;
      }
    });

    if (result.ok && result.data) {
      callState.facingMode = normalizeFacing(result.data);
      renderLocalPreview(track);
    } else {
      const noOther = /NO_OTHER_CAMERA/.test(String(result.error?.message || ""));
      notify(
        noOther
          ? "لا توجد كاميرا أخرى متاحة على هذا الجهاز."
          : "تعذّر تبديل الكاميرا الآن. حاول مرة أخرى."
      );
    }
  } finally {
    callState.switchingCamera = false;
    setFlipBusy(false);
  }
}

/** يُظهر إشعار نظام للمكالمة الواردة عندما يكون التبويب في الخلفية */
async function showIncomingSystemNotification(payload) {
  try {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    if (document.visibilityState === "visible") return;
    const reg = await navigator.serviceWorker?.getRegistration?.();
    const title = `${payload.caller?.display_name || "مكالمة واردة"}`;
    const body = payload.callType === "video" ? "📹 مكالمة فيديو واردة — اضغط للرد" : "📞 مكالمة صوتية واردة — اضغط للرد";
    if (reg?.showNotification) {
      await reg.showNotification(title, {
        body,
        tag: `call-${payload.roomId}`,
        renotify: true,
        requireInteraction: true,
        icon: payload.caller?.avatar_url || "./icons/icon.png",
        badge: "./icons/icon.png",
        vibrate: [400, 200, 400, 200, 400],
        data: { type: "incoming_call", roomId: payload.roomId, conversationId: payload.conversationId },
      });
    }
  } catch {
    /* تجاهل */
  }
}

function closeIncomingSystemNotification(roomId) {
  navigator.serviceWorker?.getRegistration?.().then((reg) => {
    reg?.getNotifications?.({ tag: `call-${roomId}` }).then((list) => list.forEach((n) => n.close()));
  }).catch(() => {});
}

async function toggleMicrophone() {
  const track = callState.localAudioTrack;
  if (!track) return;

  callState.micMuted = !callState.micMuted;
  await safeAsync("calls:toggle-mic", () => track.setMuted(callState.micMuted));

  safeDom("mic-btn", () => {
    const btn = document.getElementById("call-btn-mic");
    if (!btn) return;
    const icon = btn.querySelector(".call-ctrl-icon");
    if (icon) icon.textContent = callState.micMuted ? "🔇" : "🎙️";
    btn.classList.toggle("active", callState.micMuted);
  });
}

async function toggleCamera() {
  const track = callState.localVideoTrack;
  if (!track) return;

  callState.cameraOff = !callState.cameraOff;
  await safeAsync("calls:toggle-cam", () => track.setMuted(callState.cameraOff));

  safeDom("cam-btn", () => {
    const btn = document.getElementById("call-btn-cam");
    if (btn) {
      const icon = btn.querySelector(".call-ctrl-icon");
      if (icon) icon.textContent = callState.cameraOff ? "🚫" : "📷";
      btn.classList.toggle("active", callState.cameraOff);
    }
    document.getElementById("call-local-video")?.classList.toggle("hidden", callState.cameraOff);
  });
}

/* ------------------------------------------------------------
 * 12) التهيئة العامة + ربط أزرار الواجهة
 * ---------------------------------------------------------- */
export function initCalls(ctx) {
  callState.ctx = ctx;
  callState.onCallLogged = typeof ctx?.onCallLogged === "function" ? ctx.onCallLogged : null;

  ensureCallOverlay();
  ensureIncomingDialog();
  ensureMiniBar();

  // فكّ قفل الصوت عند أول تفاعل حتى تعمل نغمة المكالمة الواردة
  const unlockOnce = () => {
    unlockAudio();
    document.removeEventListener("pointerdown", unlockOnce);
    document.removeEventListener("keydown", unlockOnce);
  };
  document.addEventListener("pointerdown", unlockOnce);
  document.addEventListener("keydown", unlockOnce);

  // إنهاء آمن عند إغلاق التبويب حتى لا تبقى غرفة معلّقة
  window.addEventListener("pagehide", () => {
    if (callState.current) {
      try {
        navigator.sendBeacon?.("about:blank");
      } catch {
        /* تجاهل */
      }
      leaveAgoraChannel();
    }
  });

  // Esc لإنهاء المكالمة
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && callState.current) endCall("ended");
  });

  // دفعات Push للمكالمات حين يكون التطبيق ظاهراً (يرسلها Service Worker أو onMessage)
  window.addEventListener("wa-call-push", (event) => {
    handleCallPushEvent(event?.detail).catch((error) =>
      console.error("[calls] push event", error)
    );
  });
}

/** بدء مكالمة مع مستخدم محدد (يُستخدم من زر "معاودة الاتصال" في سجل المكالمات) */
export async function startCallWith(peerProfile, conversationId, callType = "audio") {
  if (!peerProfile?.id || !conversationId) return;
  const conv = callState.ctx?.getActiveConversation?.();
  if (conv?.id === conversationId) {
    return startCall(callType);
  }
  // افتح المحادثة أولاً عبر التطبيق ثم ابدأ
  if (typeof callState.ctx?.openConversation === "function") {
    await callState.ctx.openConversation(peerProfile, conversationId);
    return startCall(callType);
  }
  notify("افتح المحادثة أولاً لبدء مكالمة.");
}

/** يربط أزرار المكالمة في رأس المحادثة (تُستدعى بعد حقن الـ partial) */
export function wireCallButtons() {
  const audioBtn = document.getElementById("chat-call-audio");
  const videoBtn = document.getElementById("chat-call-video");

  if (audioBtn && !audioBtn.dataset.wired) {
    audioBtn.dataset.wired = "1";
    audioBtn.addEventListener("click", guard("call:start-audio", () => startCall("audio")));
  }

  if (videoBtn && !videoBtn.dataset.wired) {
    videoBtn.dataset.wired = "1";
    videoBtn.addEventListener("click", guard("call:start-video", () => startCall("video")));
  }
}

export function isCallActive() {
  return Boolean(callState.current);
}
