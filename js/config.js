export const SUPABASE_URL = "https://gqocavvhhfwgkzscrjms.supabase.co";
export const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdxb2NhdnZoaGZ3Z2t6c2Nyam1zIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg2MzE2MDMsImV4cCI6MjEwNDIwNzYwM30.x4HxOcAiusptsdflVje61wY8t9IfMOAGsCdUg3pIGaQ";

export const VAPID_PUBLIC_KEY = "BGKcsJH4YH7vV384UCmx_FKD0xGiWTNuMA7skLLUWzIodKXTSFLRleq1K0ttPMnXZfzQO42bQig8nSKTSIw1jts";

/* ============================================================
 * إعدادات منصة Agora للمكالمات الصوتية والمرئية
 * ------------------------------------------------------------
 * ⚠️ ملاحظات أمنية مهمّة:
 *   1) App ID الخاص بـ Agora ليس سرّاً — يُستخدم في العميل بشكل طبيعي.
 *   2) App Certificate (المفتاح السري) يجب ألّا يوضع هنا إطلاقاً.
 *      إن فعّلت وضع الشهادة (Secured mode) فيجب توليد التوكن من
 *      خادم آمن (Supabase Edge Function مثلاً) عبر AGORA_TOKEN_ENDPOINT.
 *   3) يمكن تجاوز أي قيمة أثناء التشغيل دون تعديل الكود عبر:
 *        window.__AGORA_CONFIG__ = { appId: "...", tokenEndpoint: "..." }
 *      أو عبر localStorage: agora_app_id / agora_token_endpoint
 * ============================================================ */

const AGORA_DEFAULTS = {
  // ضع App ID مشروعك من لوحة تحكم Agora (Console > Project Management)
  appId: "c72cf98bdff64feebd17688f95764943",

  // نقطة نهاية آمنة تُرجع { token, uid, expiresAt } — اتركها فارغة في وضع Testing
  tokenEndpoint: "",

  // نسخة SDK المحمّلة بشكل كسول (Lazy) عند أول مكالمة فقط لتوفير الأداء
  sdkUrl: "https://download.agora.io/sdk/release/AgoraRTC_N-4.20.2.js",

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
    return (
      readAgoraOverride("tokenEndpoint", "agora_token_endpoint") ||
      AGORA_DEFAULTS.tokenEndpoint
    );
  },
  get sdkUrl() {
    return readAgoraOverride("sdkUrl", "agora_sdk_url") || AGORA_DEFAULTS.sdkUrl;
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

/** اسم قناة ثابت ومتطابق لدى الطرفين مشتق من معرّف المحادثة */
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

export const ADMINS = [
  { email: "aabntlal680@gmail.com", name: "الوليد بن طلال" },
  { email: "almgawell17@gmail.com", name: "لمياء بنت ماجد" },
  { email: "almgawell@gmail.com", name: "ريم بنت الوليد" },
  { email: "almgawell1992@gmail.com", name: "ملاك العتيبي" },
  { email: "almgawell1121@gmail.com", name: "عبير الدوسري" },
  { email: "almgawell1212@gmail.com", name: "اسماء المليكي" },
  { email: "almgawell5@gmail.com", name: "لمياء بنت ماجد" },
  { email: "almgawell4@gmail.com", name: "ريم بنت الوليد" },
  { email: "almgawell3@gmail.com", name: "ملاك العتيبي" },
  { email: "almgawell2@gmail.com", name: "عبير الدوسري" },
  { email: "almgawell1@gmail.com", name: "اسماء المليكي" },
  { email: "almgawell6@gmail.com", name: "لمياء بنت ماجد" },
  { email: "almgawell7@gmail.com", name: "ريم بنت الوليد" },
  { email: "almgawell8@gmail.com", name: "ملاك العتيبي" },
  { email: "almgawell9@gmail.com", name: "عبير الدوسري" },
  { email: "almgawell10@gmail.com", name: "اسماء المليكي" },
  { email: "almgawell0@gmail.com", name: "عبير الدوسري" },
  { email: "almgawell11@gmail.com", name: "اسماء المليكي" },
];

export function isAdminEmail(email) {
  return ADMINS.some((a) => a.email.toLowerCase() === (email || "").toLowerCase());
}
