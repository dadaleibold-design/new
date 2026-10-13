/* ============================================================
 * types/frontend-globals.d.ts
 * ------------------------------------------------------------
 * تعريفات النطاق العام للواجهة (Vanilla JS + Vite env) — تستخدمها
 * `npm run typecheck` للتحقق من الأنواع في طبقة الإعداد فقط.
 * الأسماء هنا مطابقة للأسماء المعتمدة في js/env.js و .env.example.
 * ============================================================ */

/** كائن Vite: يُستبدل وقت البناء، ويكون undefined في متصفح بلا Vite */
interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  readonly VITE_FIREBASE_API_KEY?: string;
  readonly VITE_FIREBASE_PROJECT_ID?: string;
  readonly VITE_FIREBASE_MESSAGING_SENDER_ID?: string;
  readonly VITE_FIREBASE_APP_ID?: string;
  readonly VITE_VAPID_PUBLIC_KEY?: string;
  readonly VITE_AGORA_APP_ID?: string;
  // قيم Vite المدمجة
  readonly MODE?: string;
  readonly DEV?: boolean;
  readonly PROD?: boolean;
  readonly BASE_URL?: string;
}

interface ImportMeta {
  readonly env?: ImportMetaEnv;
}

/** متغيرات البيئة المحقونة وقت التشغيل (env.js المولَّد) */
declare var __ENV__: Record<string, string> | undefined;

interface Window {
  __ENV__?: Record<string, string>;
  /** تجاوزات إعدادات Agora وقت التشغيل (انظر js/config.js) */
  __AGORA_CONFIG__?: Record<string, string>;
  /** مكتبة Supabase المحمَّلة من CDN */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase?: any;
}

declare var self: Window & typeof globalThis;
