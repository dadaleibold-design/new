/* ============================================================
 * js/config.js — إعدادات التطبيق العامة (بدون أي أسرار ثابتة)
 * ------------------------------------------------------------
 * 🔐 كل المفاتيح والروابط تأتي من متغيرات البيئة عبر js/env.js:
 *      import.meta.env.VITE_* (Vite)  أو  self.__ENV__ (وقت التشغيل)
 *    لا تُكتب أي قيمة سرّية أو مفتاح مباشرة في هذا الملف.
 *
 *    المفاتيح السرّية للسيرفر (service role / private key / Agora certificate)
 *    ممنوعة هنا تماماً — مكانها أسرار Supabase Edge Functions فقط.
 * ============================================================ */

import {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  VAPID_PUBLIC_KEY,
  FIREBASE_CONFIG,
  AGORA_APP_ID,
  AGORA_TOKEN_ENDPOINT,
  missingEnvKeys,
  isSupabaseConfigured,
  isFirebaseConfigured,
  readEnvSnapshot,
} from "./env.js";

// إعادة تصدير قيم البيئة حتى تعتمد بقية الوحدات على مسار واحد
export {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  VAPID_PUBLIC_KEY,
  FIREBASE_CONFIG,
  missingEnvKeys,
  isSupabaseConfigured,
  isFirebaseConfigured,
  readEnvSnapshot,
};

/* ============================================================
 * إعدادات منصة Agora للمكالمات الصوتية والمرئية
 * ------------------------------------------------------------
 * ⚠️ ملاحظات أمنية مهمّة:
 *   1) App ID الخاص بـ Agora ليس سرّاً — يأتي من VITE_AGORA_APP_ID.
 *   2) App Certificate (المفتاح السري) يجب ألّا يوضع هنا إطلاقاً.
 *      لتوليد التوكن يُستدعى خادم آمن (دالة agora-token) التي تقرأ
 *      AGORA_APP_CERTIFICATE من Deno.env.
 *   3) يمكن تجاوز أي قيمة أثناء التشغيل دون تعديل الكود عبر:
 *        window.__AGORA_CONFIG__ = { appId: "...", tokenEndpoint: "..." }
 *      أو عبر localStorage: agora_app_id / agora_token_endpoint
 * ============================================================ */

const AGORA_DEFAULTS = {
  // من متغير البيئة VITE_AGORA_APP_ID (أو window.__ENV__ وقت التشغيل)
  appId: AGORA_APP_ID,

  // نقطة نهاية آمنة تُرجع { token, uid, expiresAt } — مشتقّة من SUPABASE_URL
  tokenEndpoint: AGORA_TOKEN_ENDPOINT,

  // مصادر SDK مرتّبة حسب الأفضلية، تُحمَّل بشكل كسول عند أول مكالمة فقط.
  // ملاحظة: وسم <script> العادي لا يخضع لسياسة CORS إطلاقاً، لذا يجب
  // عدم ضبط crossOrigin عليه (ضبطه يُفعّل فحص CORS ويُفشل التحميل).
  // نضع مرايا npm أولاً لأن download.agora.io يعطي 503 أحياناً.
  sdkUrls: [
    "https://cdn.jsdelivr.net/npm/agora-rtc-sdk-ng@4.20.2/AgoraRTC_N-production.js",
    "https://unpkg.com/agora-rtc-sdk-ng@4.20.2/AgoraRTC_N-production.js",
    "https://download.agora.io/sdk/release/AgoraRTC_N-4.20.2.js",
  ],

  // بادئة أسماء القنوات لتفادي التعارض بين المشاريع على نفس الـ App ID
  channelPrefix: "wa",

  // مهلة انتظار رد الطرف الآخر قبل اعتبار المكالمة "لم يُرد عليها" (ملّي ثانية)
  ringTimeoutMs: 45000,

  // إعدادات جودة الوسائط — محسّنة لتقليل استهلاك الشبكة والبطارية
  audioProfile: "speech_standard",
  videoProfile: "480p_1",

  // وضع الترميز: "vp8" أوسع توافقاً، "h264" أفضل لأجهزة iOS القديمة
  codec: "vp8",
  mode: "rtc",
};

/**
 * @param {string} key مفتاح التجاوز في window.__AGORA_CONFIG__
 * @param {string} storageKey مفتاح التجاوز في localStorage
 * @returns {string|null}
 */
function readAgoraOverride(key, storageKey) {
  try {
    const runtime = typeof window !== "undefined" ? window.__AGORA_CONFIG__ : null;
    if (runtime && runtime[key]) return String(runtime[key]);

    if (typeof localStorage !== "undefined") {
      const stored = localStorage.getItem(storageKey);
      if (stored) return stored;
    }
  } catch {
    /* بيئة بدون window/localStorage — تجاهل بأمان */
  }
  return null;
}

export const AGORA = {
  get appId() {
    return readAgoraOverride("appId", "agora_app_id") || AGORA_DEFAULTS.appId;
  },
  get tokenEndpoint() {
    return readAgoraOverride("tokenEndpoint", "agora_token_endpoint") || AGORA_DEFAULTS.tokenEndpoint;
  },
  /** قائمة مصادر SDK للمحاولة بالتتابع (التجاوز اليدوي يتصدّر القائمة) */
  get sdkUrls() {
    const override = readAgoraOverride("sdkUrl", "agora_sdk_url");
    const list = [...AGORA_DEFAULTS.sdkUrls];
    if (override) list.unshift(override);
    // أزل التكرار مع الحفاظ على الترتيب
    return [...new Set(list)];
  },
  channelPrefix: AGORA_DEFAULTS.channelPrefix,
  ringTimeoutMs: AGORA_DEFAULTS.ringTimeoutMs,
  audioProfile: AGORA_DEFAULTS.audioProfile,
  videoProfile: AGORA_DEFAULTS.videoProfile,
  codec: AGORA_DEFAULTS.codec,
  mode: AGORA_DEFAULTS.mode,
};

/** هل إعدادات Agora مكتملة بما يكفي لبدء مكالمة؟ */
export function isAgoraConfigured() {
  return typeof AGORA.appId === "string" && AGORA.appId.trim().length > 0;
}

/**
 * اسم قناة ثابت ومتطابق لدى الطرفين مشتق من معرّف المحادثة
 * @param {unknown} conversationId
 * @returns {string}
 */
export function buildAgoraChannelName(conversationId) {
  const safe = String(conversationId || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 48);
  return `${AGORA.channelPrefix}_${safe}`;
}

/* ============================================================
 * حدود ضغط الوسائط قبل الرفع إلى Supabase Storage
 * ============================================================ */
export const MEDIA_LIMITS = {
  // أقصى أبعاد للصور المرسلة كمرفقات
  imageMaxWidth: 1600,
  imageMaxHeight: 1600,
  imageQuality: 0.72,

  // الصورة الشخصية — مربّعة وصغيرة
  avatarMaxWidth: 512,
  avatarMaxHeight: 512,
  avatarQuality: 0.8,

  // خلفية الدردشة — عريضة لكن مضغوطة
  wallpaperMaxWidth: 1920,
  wallpaperMaxHeight: 1920,
  wallpaperQuality: 0.7,

  // أقصى حجم مسموح لأي ملف بعد الضغط (بايت) — 25MB
  maxUploadBytes: 25 * 1024 * 1024,

  // لا تُضغط الصور الأصغر من هذا الحجم (لا فائدة تُذكر)
  skipCompressionUnderBytes: 60 * 1024,
};

/* ============================================================
 * ملاحظة بخصوص قائمة المشرفين
 * ------------------------------------------------------------
 * أُزيلت القائمة الثابتة للبُرد الإلكتروني من الواجهة نهائياً.
 * المشرف هو من يمنحه السيرفر علامة `profiles.is_admin` /
 * `profiles.is_super_admin` — والقرار النهائي داخل قاعدة البيانات
 * (دالة is_admin_email / handle_new_user و سياسات RLS).
 * ============================================================ */
