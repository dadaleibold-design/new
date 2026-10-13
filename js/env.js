/* ============================================================
 * js/env.js — طبقة قراءة متغيرات البيئة للواجهة (مصدر وحيد)
 * ------------------------------------------------------------
 * هذا ملف مصدري يُتتبَّع في Git — وليس الملف المولَّد في الجذر.
 * (الملف المولَّد هو `/env.js` في جذر الموقع فقط، ويضبط
 *  `self.__ENV__`؛ أما `js/env.js` فهو الوحدة التي تستوردها
 *  بقية الوحدات. غيابه يُسقط رسم الاستيراد كاملاً فيتعذّر
 *  تشغيل js/app.js وتبقى شاشة التحميل إلى الأبد.)
 *
 * أولوية القراءة (لكل مفتاح على حدة):
 *   1) import.meta.env.VITE_*   — عند التشغيل/البناء عبر Vite
 *   2) self.__ENV__ / __ENV__   — وقت التشغيل (env.js المولَّد
 *      المحمَّل في index.html قبل الوحدات، أو ما يضبطه الاختبار)
 *
 * كل القراءات آمنة: أي غياب أو قيمة تالفة أو استثناء في الوصول
 * إلى النطاق العام يتحوّل إلى سلسلة فارغة بدل أن يرمي خطأً
 * يُسقط الوحدة — ويتولّى المستدعي عندها إظهار شاشة الإعداد.
 * لا توجد هنا أي قيمة حقيقية أو مفتاح ثابت.
 * ============================================================ */

/** المفاتيح المطلوبة لعمل التطبيق والإشعارات (VITE_AGORA_APP_ID إضافي اختياري) */
export const REQUIRED_ENV_KEYS = Object.freeze([
  "VITE_SUPABASE_URL",
  "VITE_SUPABASE_ANON_KEY",
  "VITE_FIREBASE_API_KEY",
  "VITE_FIREBASE_PROJECT_ID",
  "VITE_FIREBASE_MESSAGING_SENDER_ID",
  "VITE_FIREBASE_APP_ID",
  "VITE_VAPID_PUBLIC_KEY",
]);

/** كل المفاتيح المعروفة للواجهة (المطلوبة + الاختيارية) */
export const ENV_KEYS = Object.freeze([...REQUIRED_ENV_KEYS, "VITE_AGORA_APP_ID"]);

/**
 * تطبيع قيمة بيئة إلى سلسلة مقصوصة (غير السلاسل تتحول إلى فارغة بأمان)
 * @param {unknown} value
 * @returns {string}
 */
function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * قيم Vite إن وُجدت. في متصفح بلا Vite يكون import.meta.env غير معرّف،
 * وفي بيئات أخرى قد يرمي الوصول إليه — لذا القراءة محميّة دائماً.
 * @returns {Record<string, string>}
 */
function readViteEnv() {
  try {
    const viteEnv = import.meta.env || {};
    return {
      "VITE_SUPABASE_URL": clean(viteEnv["VITE_SUPABASE_URL"]),
      "VITE_SUPABASE_ANON_KEY": clean(viteEnv["VITE_SUPABASE_ANON_KEY"]),
      "VITE_FIREBASE_API_KEY": clean(viteEnv["VITE_FIREBASE_API_KEY"]),
      "VITE_FIREBASE_PROJECT_ID": clean(viteEnv["VITE_FIREBASE_PROJECT_ID"]),
      "VITE_FIREBASE_MESSAGING_SENDER_ID": clean(viteEnv["VITE_FIREBASE_MESSAGING_SENDER_ID"]),
      "VITE_FIREBASE_APP_ID": clean(viteEnv["VITE_FIREBASE_APP_ID"]),
      "VITE_VAPID_PUBLIC_KEY": clean(viteEnv["VITE_VAPID_PUBLIC_KEY"]),
      "VITE_AGORA_APP_ID": clean(viteEnv["VITE_AGORA_APP_ID"]),
    };
  } catch {
    return {};
  }
}

/**
 * قيم وقت التشغيل من self.__ENV__ (الملف المولَّد) أو النطاق العام.
 * @returns {Record<string, string>}
 */
function readRuntimeEnv() {
  try {
    /** @type {any} */
    const scope = globalThis;
    const runtime =
      scope.__ENV__ ||
      (typeof self !== "undefined" ? /** @type {any} */ (self).__ENV__ : null) ||
      (typeof window !== "undefined" ? /** @type {any} */ (window).__ENV__ : null);
    if (!runtime || typeof runtime !== "object") return {};

    /** @type {Record<string, string>} */
    const out = {};
    for (const key of ENV_KEYS) out[key] = clean(runtime[key]);
    return out;
  } catch {
    return {};
  }
}

/**
 * لقطة البيئة الحالية: قيمة Vite غير الفارغة تسبق قيمة وقت التشغيل.
 * تُحسب عند كل استدعاء حتى تعكس أي حقن متأخر لـ self.__ENV__.
 * @returns {Readonly<Record<string, string>>}
 */
export function readEnvSnapshot() {
  const runtime = readRuntimeEnv();
  const vite = readViteEnv();

  /** @type {Record<string, string>} */
  const snapshot = {};
  for (const key of ENV_KEYS) snapshot[key] = vite[key] || runtime[key] || "";
  return Object.freeze(snapshot);
}

const initialSnapshot = readEnvSnapshot();

/** عنوان مشروع Supabase (بلا شرطة أخيرة حتى لا تتضاعف المسارات المشتقة) */
export const SUPABASE_URL = (initialSnapshot["VITE_SUPABASE_URL"] || "").replace(/\/+$/, "");

/** المفتاح العام (anon) — مصمّم للظهور في المتصفح وتقيّده سياسات RLS */
export const SUPABASE_ANON_KEY = initialSnapshot["VITE_SUPABASE_ANON_KEY"] || "";

/** مفتاح VAPID العام لدفع الويب */
export const VAPID_PUBLIC_KEY = initialSnapshot["VITE_VAPID_PUBLIC_KEY"] || "";

/** معرّف مشروع Agora العام (اختياري — ليس سرّاً) */
export const AGORA_APP_ID = initialSnapshot["VITE_AGORA_APP_ID"] || "";

const FIREBASE_PROJECT_ID = initialSnapshot["VITE_FIREBASE_PROJECT_ID"] || "";

/** إعداد Firebase للويب — authDomain/storageBucket مشتقّان من معرّف المشروع */
export const FIREBASE_CONFIG = Object.freeze({
  apiKey: initialSnapshot["VITE_FIREBASE_API_KEY"] || "",
  authDomain: FIREBASE_PROJECT_ID ? `${FIREBASE_PROJECT_ID}.firebaseapp.com` : "",
  projectId: FIREBASE_PROJECT_ID,
  storageBucket: FIREBASE_PROJECT_ID ? `${FIREBASE_PROJECT_ID}.firebasestorage.app` : "",
  messagingSenderId: initialSnapshot["VITE_FIREBASE_MESSAGING_SENDER_ID"] || "",
  appId: initialSnapshot["VITE_FIREBASE_APP_ID"] || "",
});

/** نقطة توليد توكن Agora على Supabase Edge Functions — مشتقة من عنوان Supabase */
export const AGORA_TOKEN_ENDPOINT = SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/agora-token` : "";

/**
 * أسماء المتغيرات المطلوبة الغائبة أو الفارغة حالياً.
 * @returns {string[]}
 */
export function missingEnvKeys() {
  const snapshot = readEnvSnapshot();
  return REQUIRED_ENV_KEYS.filter((key) => !snapshot[key]);
}

/** هل إعداد Supabase مكتمل (العنوان + المفتاح العام)؟ */
export function isSupabaseConfigured() {
  const snapshot = readEnvSnapshot();
  return Boolean(snapshot["VITE_SUPABASE_URL"] && snapshot["VITE_SUPABASE_ANON_KEY"]);
}

/** هل إعداد Firebase مكتمل بما يكفي لتهيئة الإشعارات؟ */
export function isFirebaseConfigured() {
  const snapshot = readEnvSnapshot();
  return Boolean(
    snapshot["VITE_FIREBASE_API_KEY"] &&
      snapshot["VITE_FIREBASE_PROJECT_ID"] &&
      snapshot["VITE_FIREBASE_MESSAGING_SENDER_ID"] &&
      snapshot["VITE_FIREBASE_APP_ID"]
  );
}
