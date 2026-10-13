/* ============================================================
 * js/supabaseClient.js — عميل Supabase (إعداد كامل من متغيرات البيئة)
 * ------------------------------------------------------------
 * لا مفاتيح ثابتة هنا: العنوان والمفتاح العام (anon) يأتيان من
 * `import.meta.env` / `self.__ENV__` عبر js/config.js → js/env.js.
 *
 * ⚠️ المفتاح العام (anon) مصمَّم للظهور في المتصفح، لكن الوصول الفعلي
 *    محدود بسياسات RLS. المفتاح السري (service_role) ممنوع هنا تماماً.
 * ============================================================ */

import {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  isSupabaseConfigured,
  missingEnvKeys,
} from "./config.js";

/**
 * يقرأ مكتبة Supabase من النطاق العام (المتصفح أو بيئة اختبار)
 * @returns {{ createClient?: Function }|null}
 */
function readSupabaseLibrary() {
  try {
    /** @type {any} */
    const scope = globalThis;
    return scope.supabase || (typeof window !== "undefined" ? window.supabase : null);
  } catch {
    return null;
  }
}

/** localStorage قد يرمي عند الوصول إليه (حظر التخزين) — عندها نكمل بدونه */
function readSafeStorage() {
  try {
    return typeof window !== "undefined" ? window.localStorage : undefined;
  } catch {
    return undefined;
  }
}

/** يُنشئ العميل بأمان ويعيد سبب الفشل بدل إسقاط التطبيق كاملاً */
function createSupabaseClient() {
  const factory = readSupabaseLibrary()?.createClient;

  if (typeof factory !== "function") {
    return {
      client: null,
      error: "مكتبة Supabase لم تُحمَّل (script CDN مفقود أو محجوب).",
    };
  }

  if (!isSupabaseConfigured()) {
    return {
      client: null,
      error:
        "إعدادات Supabase غير مضبوطة: " +
        missingEnvKeys().join(", ") +
        " — راجع ملف .env.example وشغّل `npm run env:generate`.",
    };
  }

  try {
    return {
      client: factory(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          storage: readSafeStorage(),
          storageKey: "wa_browser_session",
          detectSessionInUrl: false,
        },
        realtime: { params: { eventsPerSecond: 10 } },
      }),
      error: null,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      client: null,
      error: `تعذّر تهيئة عميل Supabase: ${reason}`,
    };
  }
}

const { client, error } = createSupabaseClient();

/** عميل Supabase — أو null إذا كان الإعداد ناقصاً (تظهر شاشة إعداد عندها) */
export const supabase = client;

/** سبب فشل التهيئة (null عندما كل شيء سليم) */
export const supabaseInitError = error;

/** هل التطبيق جاهز للعمل (عميل متاح + إعدادات مضبوطة)؟ */
export function isSupabaseReady() {
  return Boolean(supabase) && isSupabaseConfigured();
}
