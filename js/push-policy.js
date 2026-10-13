/**
 * منطق تسجيل توكن FCM لكل جهاز — دوال نقية (بلا DOM ولا Supabase)
 * حتى تُختبر في Node عبر tests/multidevice-push.mjs.
 *
 * js/push.js يعتمد عليها في قرار: هل نكتب التوكن إلى قاعدة البيانات الآن؟
 */

export const DEVICE_ID_KEY = "wa_device_id";
const DEVICE_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

/**
 * قرار الكتابة إلى الخادم.
 *
 * ترتيب الأسباب مهم:
 *  - force: طلب صريح (إعادة تفعيل، تسجيل دخول).
 *  - tokenChanged: التوكن تدوّر الآن على هذا المتصفح → يجب الكتابة فوراً
 *    بغض النظر عن آخر مزامنة (وإلا يبقى التوكن الميت في الخادم حتى 30 دقيقة).
 *  - userChanged: المستخدم على هذا المتصفح تغيّر → يجب نقل التوكن للحساب الجديد.
 *  - غير ذلك: نكتب فقط إن لم يوجد توكن محلي أو لم نزامن منذ minIntervalMs.
 *
 * @returns {{ write: boolean, reason: string }}
 */
export function decideServerWrite({
  force = false,
  tokenChanged = false,
  userChanged = false,
  hasCachedToken = false,
  lastSyncAt = 0,
  now = Date.now(),
  minIntervalMs = 30 * 60 * 1000,
} = {}) {
  if (force) return { write: true, reason: "forced" };
  if (tokenChanged) return { write: true, reason: "token-rotated" };
  if (userChanged) return { write: true, reason: "user-changed" };
  if (!hasCachedToken) return { write: true, reason: "no-local-token" };
  if (!lastSyncAt) return { write: true, reason: "never-synced" };
  if (now - lastSyncAt > minIntervalMs) return { write: true, reason: "stale-sync" };
  return { write: false, reason: "unchanged" };
}

/**
 * يعيد هوية الجهاز الثابتة (تُخزَّن محلياً). لا تُحذف عند تسجيل الخروج،
 * لأنها تمثّل المتصفح نفسه لا الحساب.
 *
 * @param {{ getItem(k:string):string|null, setItem(k:string,v:string):void }} storage
 * @param {() => string} makeId
 * @returns {string|null} null إن تعذّر الوصول إلى التخزين
 */
export function getOrCreateDeviceId(storage, makeId) {
  try {
    const existing = storage.getItem(DEVICE_ID_KEY);
    if (existing && DEVICE_ID_PATTERN.test(existing)) return existing;
    const id = String(makeId());
    if (!DEVICE_ID_PATTERN.test(id)) return null;
    storage.setItem(DEVICE_ID_KEY, id);
    return id;
  } catch {
    return null;
  }
}

/**
 * معلومات وصفية عن الجهاز تُحفظ في device_info (لا أسرار، لا توكنات).
 * الحجم محدود حتى لا يتضخم الصف.
 */
export function buildDeviceInfo({
  platform = "web",
  userAgent = "",
  standalone = false,
  language = "",
  timezone = "",
  now = Date.now(),
} = {}) {
  return {
    platform: String(platform).slice(0, 40),
    standalone: Boolean(standalone),
    language: String(language).slice(0, 20),
    timezone: String(timezone).slice(0, 60),
    ua: String(userAgent).slice(0, 160),
    registered_at: new Date(now).toISOString(),
  };
}
