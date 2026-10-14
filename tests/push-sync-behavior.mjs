/*
 * اختبار سلوك syncPushToken الحقيقي (js/push.js) — بلا متصفح ولا Firebase
 * -------------------------------------------------------------
 * ينسخ push.js إلى مجلد مؤقت، ويستبدل استيراد Firebase/Supabase بمحاكيات،
 * ثم يشغّل السيناريوهات: تدوير التوكن، تبديل الحساب على نفس المتصفح،
 * فشل الكتابة ثم إعادتها، هوية الجهاز، الرجوع للـ upsert، وسجلات التتبّع.
 *
 * التشغيل: node tests/push-sync-behavior.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "push-sync-"));
fs.mkdirSync(path.join(TMP, "js"), { recursive: true });
fs.writeFileSync(path.join(TMP, "package.json"), '{"type":"module"}');
fs.copyFileSync(path.join(ROOT, "js/push-policy.js"), path.join(TMP, "js/push-policy.js"));
// push.js يستورد call-media.js (تمييز إشعارات المكالمات)
fs.copyFileSync(path.join(ROOT, "js/call-media.js"), path.join(TMP, "js/call-media.js"));
fs.writeFileSync(
  path.join(TMP, "js/push.js"),
  fs
    .readFileSync(path.join(ROOT, "js/push.js"), "utf8")
    .replaceAll('"https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js"', '"./fb-stub.js"')
    .replaceAll('"https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging.js"', '"./fb-stub.js"'),
);
fs.writeFileSync(
  path.join(TMP, "js/fb-stub.js"),
  `export const initializeApp = () => ({});
export const getApps = () => [{}];
export const getMessaging = () => ({ stub: true });
export const getToken = (...a) => globalThis.__getToken(...a);
export const onMessage = () => () => {};
`,
);
// push.js يقرأ إعدادات Firebase من متغيرات البيئة عبر ./config.js —
// نضع نسخة اختبارية بنفس الواجهة (القيم الحقيقية لا تُوضع في الكود إطلاقاً).
fs.writeFileSync(
  path.join(TMP, "js/config.js"),
  `export const FIREBASE_CONFIG = {
  apiKey: "test-firebase-api-key",
  projectId: "test-firebase-project",
  messagingSenderId: "1234567890",
  appId: "1:1234567890:web:test-app",
  authDomain: "test-firebase-project.firebaseapp.com",
  storageBucket: "test-firebase-project.firebasestorage.app",
};
export const VAPID_PUBLIC_KEY = "test-vapid-public-key";
export const isFirebaseConfigured = () => true;
export const missingEnvKeys = () => [];
export const SUPABASE_URL = "https://test.supabase.co";
export const SUPABASE_ANON_KEY = "test-anon-key";
`,
);

fs.writeFileSync(
  path.join(TMP, "js/supabaseClient.js"),
  `export const supabase = {
  rpc: (...a) => globalThis.__rpc(...a),
  from: (...a) => globalThis.__from(...a),
};
`,
);

// ---- browser globals ----
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
const reg = { active: { state: "activated" } };
Object.defineProperty(globalThis, "navigator", {
  value: {
    userAgent: "Mozilla/5.0 (Linux; Android 14) Chrome/120 Mobile",
    language: "ar-EG",
    serviceWorker: { getRegistration: async () => reg, register: async () => reg },
  },
  configurable: true,
});
globalThis.window = {
  isSecureContext: true,
  location: { origin: "https://app.example" },
  matchMedia: () => ({ matches: true }),
  addEventListener() {},
};
globalThis.Notification = { permission: "granted" };
window.Notification = globalThis.Notification;
globalThis.document = { visibilityState: "visible" };

// ---- logs ----
const logs = [];
for (const lvl of ["log", "info", "warn", "error"]) {
  console[lvl + "_orig"] = console[lvl];
  console[lvl] = (...a) => logs.push([lvl, a.map(String).join(" ")]);
}

// ---- fakes ----
let currentToken = "TOKEN-A-aaaaaaaa";
let rpcImpl;
const rpcCalls = [];
let upsertCalls = 0;
globalThis.__getToken = async () => currentToken;
globalThis.__rpc = async (name, args) => {
  rpcCalls.push({ name, args });
  return rpcImpl(args);
};
globalThis.__from = () => ({
  upsert: async () => {
    upsertCalls += 1;
    return { error: null };
  },
});

const push = await import(path.join(TMP, "js/push.js"));
const { syncPushToken, TOKEN_KEY, TOKEN_SYNC_KEY } = push;
const NOW = Date.now();
const ok = (action = "inserted") => async () => ({ data: { id: "x", action, rotated_removed: 0 }, error: null });

let pass = 0;
const t = async (name, fn) => {
  try {
    await fn();
    pass += 1;
    console.info_orig("✅", name);
  } catch (e) {
    console.info_orig("❌", name, e.message);
    process.exitCode = 1;
  }
};
const reset = () => {
  store.clear();
  rpcCalls.length = 0;
  logs.length = 0;
  upsertCalls = 0;
};

await t("تدوير التوكن مع مزامنة حديثة → يُكتب التوكن الجديد فوراً", async () => {
  reset();
  store.set(TOKEN_KEY, "TOKEN-OLD");
  store.set(TOKEN_SYNC_KEY, String(NOW - 60_000));
  store.set("fcm_user_id", "user-1");
  currentToken = "TOKEN-NEW";
  rpcImpl = ok("inserted");
  const r = await syncPushToken({ userId: "user-1" });
  assert.equal(r, true);
  assert.equal(rpcCalls.length, 1, "rpc must be called");
  assert.equal(rpcCalls[0].args.p_token, "TOKEN-NEW");
  assert.equal(store.get(TOKEN_KEY), "TOKEN-NEW");
});

await t("تسجيل الدخول بحساب آخر على نفس المتصفح → نقل التوكن (RPC) رغم حداثة المزامنة", async () => {
  reset();
  store.set(TOKEN_KEY, "TOKEN-NEW");
  store.set(TOKEN_SYNC_KEY, String(NOW - 60_000));
  store.set("fcm_user_id", "user-1");
  currentToken = "TOKEN-NEW";
  rpcImpl = ok("moved");
  await syncPushToken({ userId: "user-2" });
  assert.equal(rpcCalls.length, 1, "user change must force write");
  assert.equal(store.get("fcm_user_id"), "user-2");
  assert.ok(logs.some(([, m]) => m.includes("moved")), "action must be logged");
});

await t("بلا تغيير ومزامنة حديثة → لا RPC", async () => {
  reset();
  store.set(TOKEN_KEY, "TOKEN-NEW");
  store.set(TOKEN_SYNC_KEY, String(NOW - 60_000));
  store.set("fcm_user_id", "user-2");
  currentToken = "TOKEN-NEW";
  rpcImpl = ok();
  const r = await syncPushToken({ userId: "user-2" });
  assert.equal(r, true);
  assert.equal(rpcCalls.length, 0);
});

await t("فشل الكتابة → fcm_user_id لا يتحدّث، والمحاولة التالية تعيد الكتابة", async () => {
  reset();
  store.set(TOKEN_KEY, "TOKEN-NEW");
  store.set(TOKEN_SYNC_KEY, String(NOW - 60_000));
  store.set("fcm_user_id", "user-1");
  currentToken = "TOKEN-NEW";
  rpcImpl = async () => ({ data: null, error: { code: "08006", message: "network down" } });
  const r1 = await syncPushToken({ userId: "user-2" });
  assert.equal(r1, false);
  assert.equal(store.get("fcm_user_id"), "user-1", "must not advance on failure");
  rpcImpl = ok("moved");
  const r2 = await syncPushToken({ userId: "user-2" });
  assert.equal(r2, true);
  assert.equal(rpcCalls.length, 2, "retry must write again");
  assert.equal(store.get("fcm_user_id"), "user-2");
});

await t("الجهاز: wa_device_id ثابت ويُرسل مع device_info", async () => {
  reset();
  store.set(TOKEN_KEY, "TOKEN-NEW");
  currentToken = "TOKEN-NEW";
  rpcImpl = ok();
  await syncPushToken({ userId: "user-3", force: true });
  const id1 = store.get("wa_device_id");
  assert.ok(id1 && id1.length >= 8, "device id persisted");
  assert.equal(rpcCalls[0].args.p_device_id, id1);
  assert.equal(rpcCalls[0].args.p_platform, "android-pwa");
  assert.equal(rpcCalls[0].args.p_device_info.platform, "android-pwa");
  assert.equal(rpcCalls[0].args.p_device_info.standalone, true);
  assert.ok(!JSON.stringify(rpcCalls[0].args.p_device_info).includes("TOKEN"), "no token in device_info");
  await syncPushToken({ userId: "user-3", force: true });
  assert.equal(store.get("wa_device_id"), id1, "device id stable across syncs");
});

await t("جهاز جديد يسجّل صفاً جديداً (لا يستبدل): كل استدعاء يرسل p_token مختلفاً لجهاز مختلف", async () => {
  reset();
  // جهاز A
  store.set(TOKEN_KEY, "TOKEN-DEV-A");
  currentToken = "TOKEN-DEV-A";
  rpcImpl = ok("inserted");
  await syncPushToken({ userId: "user-4", force: true });
  const devA = rpcCalls[0].args.p_device_id;
  // جهاز B: متصفح جديد = localStorage جديد (لا wa_device_id ولا توكن)
  store.clear();
  currentToken = "TOKEN-DEV-B";
  await syncPushToken({ userId: "user-4" });
  const devB = rpcCalls[1].args.p_device_id;
  assert.equal(rpcCalls[1].args.p_token, "TOKEN-DEV-B");
  assert.notEqual(devA, devB, "each browser gets its own device id");
});

await t("RPC غير موجودة (قبل الهجرة) → رجوع إلى upsert مع تسجيل التحذير", async () => {
  reset();
  store.set(TOKEN_KEY, "TOKEN-OLD-SCHEMA");
  currentToken = "TOKEN-OLD-SCHEMA";
  rpcImpl = async () => ({ data: null, error: { code: "PGRST202", message: "Could not find the function" } });
  const r = await syncPushToken({ userId: "user-5", force: true });
  assert.equal(r, true);
  assert.equal(upsertCalls, 1, "legacy fallback used");
  assert.ok(logs.some(([l, m]) => l === "warn" && m.includes("رجوع")));
});

await t("سجل الاستلام/التسجيل: يُطبع الإجراء والجهاز والسبب", async () => {
  reset();
  store.set(TOKEN_KEY, "TOKEN-LOG-XYZ12345");
  currentToken = "TOKEN-LOG-XYZ12345";
  rpcImpl = ok("refreshed");
  await syncPushToken({ userId: "user-6", force: true });
  const info = logs.filter(([l]) => l === "info").map(([, m]) => m).join("\n");
  assert.ok(info.includes("token refreshed"), info);
  assert.ok(info.includes("device="), info);
  assert.ok(info.includes("12345"), "token suffix logged, not full token");
  assert.ok(!info.includes("TOKEN-LOG-XYZ12345"), "full token must not be logged");
});

console.info_orig(`\nPASSED ${pass}`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(process.exitCode || 0);
