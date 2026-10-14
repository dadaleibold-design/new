/*
 * اختبار أجهزة متعددة لكل مستخدم (FCM) — بلا متصفح ولا Supabase
 * -------------------------------------------------------------
 *   1) منطق قرار الكتابة (js/push-policy.js) — يشمل الحالتين اللتين كانتا معطّلتين:
 *      • تدوير التوكن أثناء مزامنة حديثة يجب أن يُكتب فوراً.
 *      • تغيّر المستخدم على نفس المتصفح يجب أن يُكتب فوراً.
 *   2) هوية الجهاز الثابتة ومعلومات الجهاز (حدود الحجم، لا أسرار).
 *   3) فحوص ثابتة: ترتيب القرار في push.js، عقد RPC، مخطط الجدول،
 *      والإرسال إلى كل توكنات المستخدم في send-push.
 *
 * التشغيل: node tests/multidevice-push.mjs
 * التحقق من دالة SQL نفسها على PostgreSQL حقيقي عبر tests/sql-v28-postgres.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  decideServerWrite,
  getOrCreateDeviceId,
  buildDeviceInfo,
  DEVICE_ID_KEY,
} from "../js/push-policy.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

let fails = 0;
const check = (name, ok, extra = "") => {
  console.log(ok ? "✅" : "❌", name, extra);
  if (!ok) fails += 1;
};

const MIN = 30 * 60 * 1000;
const NOW = 1_800_000_000_000;

/* ---------- 1) قرار الكتابة ---------- */
const d = (over) => decideServerWrite({ now: NOW, minIntervalMs: MIN, ...over });

check(
  "تدوير التوكن أثناء مزامنة حديثة → كتابة فوراً (انحدار: كانت تُتخطّى حتى 30 دقيقة)",
  d({ tokenChanged: true, hasCachedToken: true, lastSyncAt: NOW - 60_000 }).write === true,
);
check(
  "تغيّر المستخدم على نفس المتصفح مع مزامنة حديثة → كتابة (انحدار: التوكن بقي على الحساب القديم)",
  d({ userChanged: true, hasCachedToken: true, lastSyncAt: NOW - 60_000 }).write === true,
);
check(
  "أول تسجيل دخول لا يوجد فيه fcm_user_id بعد → كتابة",
  d({ userChanged: true, hasCachedToken: true, lastSyncAt: 0 }).reason === "user-changed",
);
check(
  "بلا تغيير ومزامنة حديثة → لا كتابة (توفير طلبات)",
  d({ hasCachedToken: true, lastSyncAt: NOW - 60_000 }).write === false,
);
check(
  "مزامنة قديمة (> 30 دقيقة) → كتابة دورية",
  d({ hasCachedToken: true, lastSyncAt: NOW - MIN - 1 }).reason === "stale-sync",
);
check(
  "force → كتابة دائماً",
  d({ force: true, hasCachedToken: true, lastSyncAt: NOW - 1 }).reason === "forced",
);
check(
  "لا توكن محلي → كتابة",
  d({ hasCachedToken: false, lastSyncAt: NOW - 1 }).reason === "no-local-token",
);
check(
  "ترتيب الأسباب: التدوير يسبق الدورية حتى مع مزامنة قديمة",
  d({ tokenChanged: true, hasCachedToken: true, lastSyncAt: NOW - MIN - 1 }).reason === "token-rotated",
);

/* ---------- 2) هوية الجهاز ---------- */
const makeStorage = (init = {}, { throws = false } = {}) => {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => {
      if (throws) throw new Error("denied");
      return m.has(k) ? m.get(k) : null;
    },
    setItem: (k, v) => {
      if (throws) throw new Error("denied");
      m.set(k, v);
    },
    _m: m,
  };
};

const st = makeStorage();
const id1 = getOrCreateDeviceId(st, () => "device-abc-12345678");
check("إنشاء هوية جهاز عند أول مرة", id1 === "device-abc-12345678" && st._m.get(DEVICE_ID_KEY) === id1);
check(
  "إعادة استخدام الهوية المخزّنة (لا تتغيّر بين الجلسات)",
  getOrCreateDeviceId(st, () => "other-id-99999999") === id1,
);
const bad = makeStorage({ [DEVICE_ID_KEY]: "x y" });
check(
  "قيمة مخزّنة غير صالحة تُستبدل",
  getOrCreateDeviceId(bad, () => "good-id-12345678") === "good-id-12345678",
);
check(
  "معرّف مولّد غير صالح → null (لا نرسل قيمة مشوّهة)",
  getOrCreateDeviceId(makeStorage(), () => "bad id!") === null,
);
check(
  "تخزين غير متاح (وضع خاص) → null بلا رمي",
  getOrCreateDeviceId(makeStorage({}, { throws: true }), () => "device-abc-12345678") === null,
);

const info = buildDeviceInfo({
  platform: "android-pwa",
  userAgent: "UA".repeat(200),
  standalone: 1,
  language: "ar-EG",
  timezone: "Asia/Aden",
  now: NOW,
});
check("device_info: المنصة والوضع واللغة والمنطقة", info.platform === "android-pwa" && info.standalone === true && info.language === "ar-EG" && info.timezone === "Asia/Aden");
check("device_info: حجم user-agent محدود (≤160)", info.ua.length === 160);
check("device_info: لا يحتوي توكناً", !JSON.stringify(info).includes("token"));
check("device_info: الطابع الزمني ISO", info.registered_at === new Date(NOW).toISOString());

/* ---------- 3) فحوص ثابتة ---------- */
const PUSH_JS = read("js/push.js");
const SEND_PUSH = read("supabase/functions/send-push/index.ts");
const SCHEMA = read("sql/schema.sql");
const MIG27 = read("sql/migrations/2026-10-13_v2_7_device_tokens.sql");

// ترتيب القرار داخل syncPushToken: التدوير قبل قرار الكتابة، وfcm_user_id بعد نجاح الكتابة
const iTokenChanged = PUSH_JS.indexOf("const tokenChanged = Boolean(obtained && obtained !== cached);");
const iDecide = PUSH_JS.indexOf("const decision = decideServerWrite({");
const iRpc = PUSH_JS.indexOf('supabase.rpc("register_fcm_token"');
const iUserSet = PUSH_JS.indexOf('localStorage.setItem("fcm_user_id", String(targetUser));');
check("push.js: كشف التدوير قبل قرار الكتابة", iTokenChanged > 0 && iTokenChanged < iDecide);
check("push.js: قرار الكتابة قبل RPC", iDecide > 0 && iDecide < iRpc);
check("push.js: fcm_user_id يُحدَّث بعد نجاح الكتابة (لا قبلها)", iUserSet > iRpc);
check("push.js: القرار يحسب userChanged من المستخدم السابق", /userChanged = Boolean\(userId\) && String\(userId\) !== previousUser/.test(PUSH_JS));
check("push.js: الاستيراد من push-policy.js", PUSH_JS.includes('from "./push-policy.js"'));
check("push.js: RPC تمرّر p_device_id و p_device_info", /p_device_id: deviceId,[\s\S]*p_device_info: deviceInfo/.test(PUSH_JS));
check("push.js: يُسجَّل الإجراء المُرجَع من الدالة (inserted/refreshed/moved)", PUSH_JS.includes('const action = rpcResult?.action || "upserted";'));
check("push.js: مسار الرجوع للـ upsert موجود (توافق رجعي)", PUSH_JS.includes('from("fcm_tokens").upsert('));
check("push.js: سجل تسجيل الجهاز للمستخدم", PUSH_JS.includes("[FCM] تسجيل جهاز للمستخدم"));
check("push.js: لا يوجد upsert مباشر قبل الـ RPC في المسار الجديد", (PUSH_JS.match(/from\("fcm_tokens"\)\.upsert\(/g) || []).length === 1);

check("schema.sql: device_id و device_info في جدول fcm_tokens", /device_id text,\s*\n\s*device_info jsonb not null default '\{\}'::jsonb/.test(SCHEMA));
check("schema.sql: فهرس (user_id, device_id)", SCHEMA.includes("idx_fcm_tokens_user_device on public.fcm_tokens (user_id, device_id)"));
check("schema.sql: دالة register_fcm_token v2.7 بأربعة معاملات", SCHEMA.includes("function public.register_fcm_token(") && SCHEMA.includes("p_device_info jsonb default '{}'::jsonb"));

check("migration v2.7: إسقاط الدالة القديمة قبل إعادة الإنشاء", MIG27.includes("drop function if exists public.register_fcm_token(text, text);"));
check("migration v2.7: حذف صف الجهاز القديم عند التدوير (نفس المستخدم فقط)", /delete from public\.fcm_tokens\s+where user_id = v_uid\s+and device_id = v_device\s+and token <> p_token/.test(MIG27));
check("migration v2.7: الإرجاع يحوي action", MIG27.includes("'action', v_action"));
check("migration v2.7: SECURITY DEFINER + search_path", MIG27.includes("security definer") && MIG27.includes("set search_path = public"));
check("migration v2.7: منح EXECUTE للمستخدم المسجّل فقط", MIG27.includes("grant execute on function public.register_fcm_token(text, text, text, jsonb) to authenticated;"));

check("send-push: يقرأ device_info و device_id", SEND_PUSH.includes('.select("id, token, platform, device_id, device_info")'));
check("send-push: سجل عدد أجهزة المستلم", SEND_PUSH.includes("[send-push] recipient="));
check("send-push: الإرسال إلى كل التوكنات (Promise.all لكل شريحة، لا أول توكن فقط)", SEND_PUSH.includes("const settled = await Promise.all(") && SEND_PUSH.includes("rows.slice(i, i + FCM_CONCURRENCY)"));
check("send-push: الحذف مقصور على التوكنات الميّتة", SEND_PUSH.includes("const removed = !result.ok && isDeadToken(result.status, result.details);"));

const failsBefore = fails;
console.log(fails === 0 ? "\nكل اختبارات الأجهزة المتعددة نجحت" : `\n${fails} فشل`);
process.exit(failsBefore === 0 ? 0 : 1);
