/* ============================================================
 * js/call-media.js
 * منطق نقي لوسائط المكالمات (بلا DOM ولا Agora ولا شبكة) — قابل للاختبار في Node.
 *
 * يغطي ثلاثة أمور:
 *   1) تبديل الكاميرا: الأمامية ⇄ الخلفية (facingMode) + مسار احتياطي بالمعرّف.
 *   2) مخرج الصوت: اختيار جهاز «مكبّر الصوت» أو «سماعة الأذن» من قائمة أجهزة الإخراج.
 *   3) مجموعة صغيرة زمنية لمنع تكرار الرنين لنفس الغرفة (Realtime + Push معاً).
 *
 * ⚠️ حدود الويب (تُوثَّق في docs/calls-agora-upgrade-ar.md):
 *   لا يستطيع المتصفح دائماً اختيار سماعة الأذن على الهاتف. هذه الوحدة تحدد
 *   الجهاز المناسب إن وُجد؛ والقرار النهائي للمتصفح/نظام التشغيل.
 * ============================================================ */

export const FACING_USER = "user";
export const FACING_ENVIRONMENT = "environment";

export const AUDIO_ROUTE_SPEAKER = "speaker";
export const AUDIO_ROUTE_EARPIECE = "earpiece";

/** يُطبّع أي قيمة إلى اتجاه كاميرا صالح. الافتراضي (غير المعلَن) أمامية. */
export function normalizeFacing(value) {
  return value === FACING_ENVIRONMENT ? FACING_ENVIRONMENT : FACING_USER;
}

/** الاتجاه التالي عند الضغط على زر التبديل */
export function nextFacingMode(current) {
  return normalizeFacing(current) === FACING_USER ? FACING_ENVIRONMENT : FACING_USER;
}

/**
 * يستخرج اتجاه الكاميرا من إعدادات MediaStreamTrack.getSettings().
 * يعيد null إن لم يُعلن المتصفح الاتجاه (شائع على الحاسوب).
 * @param {{ facingMode?: string } | null | undefined} settings
 * @returns {"user" | "environment" | null}
 */
export function facingFromSettings(settings) {
  const mode = settings && typeof settings.facingMode === "string" ? settings.facingMode : "";
  if (mode === FACING_USER || mode === FACING_ENVIRONMENT) return mode;
  return null;
}

/**
 * المعاينة المحلية تُعرض معكوسة (mirror) للكاميرا الأمامية فقط — كما يرى
 * المستخدم نفسه في المرآة. الخلفية تُعرض كما هي لتطابق ما يراه الطرف الآخر.
 */
export function shouldMirrorLocalPreview(facing) {
  return normalizeFacing(facing) === FACING_USER;
}

/**
 * كاميرا بديلة لمسار الاحتياط (عندما يرفض المتصفح facingMode).
 * يعيد null إذا لم تتوفر كاميرا ثانية مختلفة.
 * @param {Array<{ deviceId?: string }>} cameras
 * @param {string} currentDeviceId
 */
export function pickAlternateCamera(cameras, currentDeviceId) {
  const list = Array.isArray(cameras) ? cameras.filter((c) => c && c.deviceId) : [];
  if (list.length < 2) return null;
  const index = list.findIndex((c) => c.deviceId === currentDeviceId);
  const candidate = list[(index + 1) % list.length];
  return candidate && candidate.deviceId !== currentDeviceId ? candidate : null;
}

const BLUETOOTH_RE = /bluetooth|بلوتوث/i;
const EARPIECE_RE = /earpiece|receiver|handset|سماع[ةه]\s*ال[أا]ذن/i;
// «مكبّر» تُكتب بشدّة أو بدونها — نطابق الجذر «مكب»
const SPEAKER_RE = /speaker|loud|مكب|السماعة الخارجية|سماعة خارجية/i;

/**
 * يصنّف اسم جهاز الإخراج (label) إلى فئة.
 * @returns {"earpiece" | "speaker" | "bluetooth" | "other"}
 */
export function classifyOutputLabel(label) {
  const text = String(label || "");
  // البلوتوث أولاً: «Bluetooth Speaker» تُعد بلوتوث لا مكبّراً داخلياً
  if (BLUETOOTH_RE.test(text)) return "bluetooth";
  if (EARPIECE_RE.test(text)) return "earpiece";
  if (SPEAKER_RE.test(text)) return "speaker";
  return "other";
}

/**
 * يختار deviceId لمخرج الصوت المطلوب من قائمة الأجهزة، أو null إن لم يوجد.
 * لا يختار أبداً جهازاً غير مُصنَّف (تفادياً لكتم الصوت عن طريق الخطأ).
 * @param {Array<{ deviceId?: string, kind?: string, label?: string }>} devices
 * @param {"speaker" | "earpiece"} route
 * @returns {string | null}
 */
export function pickOutputDevice(devices, route) {
  const list = Array.isArray(devices) ? devices : [];
  const wanted = route === AUDIO_ROUTE_EARPIECE ? "earpiece" : "speaker";
  const hit = list.find(
    (d) =>
      d &&
      d.deviceId &&
      (!d.kind || d.kind === "audiooutput") &&
      classifyOutputLabel(d.label) === wanted
  );
  return hit ? hit.deviceId : null;
}

/**
 * هل يحتمل المتصفح تغيير مخرج الصوت؟
 * setSinkId غير موجود في Chrome للأندرويد وفي معظم متصفحات الهاتف، لذلك
 * نعرض الزر بحالة «محدود» بدل أن نَعِد بتبديل لن يحدث.
 */
export function supportsAudioRouting({ hasSetSinkId = false } = {}) {
  return Boolean(hasSetSinkId);
}

/**
 * مجموعة بمفاتيح تنتهي صلاحيتها بعد ttlMs — تُستخدم لمنع تكرار رنين نفس الغرفة
 * (تصل الدعوة مرتين: عبر Realtime وعبر Push).
 * @param {{ ttlMs?: number, now?: () => number }} [options]
 */
export function createExpiringSet({ ttlMs = 120000, now = () => Date.now() } = {}) {
  const items = new Map();

  const prune = () => {
    const t = now();
    for (const [key, at] of items) {
      if (t - at > ttlMs) items.delete(key);
    }
  };

  return {
    has(key) {
      prune();
      return items.has(key);
    },
    add(key) {
      prune();
      items.set(key, now());
    },
    delete(key) {
      items.delete(key);
    },
    get size() {
      prune();
      return items.size;
    },
  };
}

/** أنواع إشعارات المكالمات القادمة من Push (send-push) */
const CALL_PUSH_TYPES = new Set(["incoming_call", "call_ended"]);

export function isCallPushType(type) {
  return CALL_PUSH_TYPES.has(String(type || ""));
}
