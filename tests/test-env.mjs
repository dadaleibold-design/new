/*
 * tests/test-env.mjs — متغيرات بيئة اختبارية للواجهة
 * -------------------------------------------------------------
 * التطبيق لم يعد يحمل أي مفتاح ثابت: القيم تُقرأ من `import.meta.env`
 * (Vite) أو من `self.__ENV__` وقت التشغيل. اختبارات jsdom تحاكي الحالة
 * الثانية عبر هذه الوحدة، فتُختبر نفس مسارات الإنتاج (بلا build).
 *
 * الاستخدام قبل تحميل js/app.js:
 *     import { installTestEnv } from "./test-env.mjs";
 *     installTestEnv(window);
 */

export const TEST_ENV = Object.freeze({
  VITE_SUPABASE_URL: "https://test.supabase.co",
  VITE_SUPABASE_ANON_KEY: "test-anon-key",
  VITE_FIREBASE_API_KEY: "test-firebase-api-key",
  VITE_FIREBASE_PROJECT_ID: "test-firebase-project",
  VITE_FIREBASE_MESSAGING_SENDER_ID: "1234567890",
  VITE_FIREBASE_APP_ID: "1:1234567890:web:test-app",
  VITE_VAPID_PUBLIC_KEY: "test-vapid-public-key",
  VITE_AGORA_APP_ID: "test-agora-app-id",
});

/** يضبط __ENV__ في النطاق العام وفي نافذة jsdom (قبل تحميل الوحدات) */
export function installTestEnv(win = globalThis) {
  const values = { ...TEST_ENV };
  globalThis.__ENV__ = values;
  if (win && typeof win === "object" && win !== globalThis) win.__ENV__ = values;
  return values;
}
