/*
 * send-push-runtime.mjs — اختبار تشغيلي فعلي لدالة send-push (Node، بلا Deno)
 * ==========================================================================
 * يشغّل `supabase/functions/send-push/index.ts` كما هي، مع:
 *   • بديل محلي لـ supabase-js (tests/deno/supabase-js-stub.ts)
 *   • محاكي OAuth2 + FCM HTTP v1 (fetch مُعترَض، بلا شبكة خارجية)
 *   • حساب خدمة RSA مولَّد لحظياً للتحقق من توقيع JWT
 *   • HTTPS محلي يستقبل طلبات الـ Webhook تماماً كما ترسلها Supabase
 *     { type, table, schema, record, old_record }
 *
 * يغطي: test · diagnostics · new_message (تسليم + delivered + تكرار)
 *        · حراس العزل (مرسل غريب، recipient mismatch، جدول غير مدعوم، سرّ خاطئ)
 *        · call_rooms (رنين/انتهاء) · profiles (new_user)
 *        · التوكنات الميتة · إعادة المحاولة على 429 · كتابة push_delivery_log
 *
 * التشغيل: node tests/send-push-runtime.mjs
 */
import { register } from "node:module";
import http from "node:http";

register("./hooks-send-push.mjs", import.meta.url);

const PORT = 8123;
const FUNCTION_URL = `http://127.0.0.1:${PORT}/`;
const SECRET = "webhook-secret-for-tests";

/* ---------- حساب خدمة RSA وهمي (لاختبار توقيع OAuth) ---------- */
const generated = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
);
const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", generated.privateKey));
let pemBody = "";
for (let i = 0; i < pkcs8.length; i++) pemBody += String.fromCharCode(pkcs8[i]);
const pemEncoded = btoa(pemBody).match(/.{1,64}/g)?.join("\n") || "";

/* ---------- بيئة Deno المصغّرة ---------- */
const env = new Map([
  ["SUPABASE_URL", "http://stub.supabase.co"],
  ["SUPABASE_SERVICE_ROLE_KEY", "stub-service-key"],
  ["SEND_PUSH_SECRET", SECRET],
  [
    "FIREBASE_SERVICE_ACCOUNT",
    JSON.stringify({
      project_id: "demo-project",
      client_email: "push-test@demo-project.iam.gserviceaccount.com",
      private_key: `-----BEGIN PRIVATE KEY-----\n${pemEncoded}\n-----END PRIVATE KEY-----\n`,
    }),
  ],
]);

let handler = null;
let notifyStarted;
const started = new Promise((resolve) => { notifyStarted = resolve; });

globalThis.Deno = {
  env: {
    get: (key) => env.get(key),
    set: (key, value) => { env.set(key, value); },
  },
  serve: (fn) => {
    handler = fn;
    const server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      let response;
      try {
        response = await fn(new Request(FUNCTION_URL, {
          method: req.method,
          headers: req.headers,
          body,
        }));
      } catch (error) {
        response = new Response(JSON.stringify({ error: String(error?.message || error) }), { status: 500 });
      }
      const text = await response.text();
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(text);
    });
    server.listen(PORT, "127.0.0.1", () => notifyStarted(server));
  },
  exit: (code) => { process.exitCode = code; },
};

/* ---------- محاكاة OAuth2 + FCM ---------- */
const FCM_LOG = [];
let fcmStatus = () => 200;
let oauthClaims = null;
const originalFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (url === "https://oauth2.googleapis.com/token") {
    const form = new URLSearchParams(String(init?.body || ""));
    const assertion = form.get("assertion") || "";
    const claimsPart = assertion.split(".")[1] || "";
    oauthClaims = JSON.parse(atob(claimsPart.replace(/-/g, "+").replace(/_/g, "/")));
    return new Response(JSON.stringify({ access_token: "fcm-access-token", expires_in: 3600 }), { status: 200 });
  }
  if (url.includes("fcm.googleapis.com/v1/projects/demo-project/messages:send")) {
    const body = JSON.parse(String(init?.body || "{}"));
    const headers = new Headers(init?.headers);
    FCM_LOG.push({
      url,
      method: String(init?.method || "GET"),
      headers: {
        authorization: headers.get("authorization") || "",
        "content-type": headers.get("content-type") || "",
      },
      body,
    });
    const status = fcmStatus(body);
    if (status >= 400) {
      const errorCode = status === 404 ? "UNREGISTERED" : "INVALID_ARGUMENT";
      return new Response(
        JSON.stringify({ error: { code: status, message: "mock FCM error", details: [{ errorCode }] } }),
        { status },
      );
    }
    return new Response(JSON.stringify({ name: "projects/demo-project/messages/1" }), { status });
  }
  return originalFetch(input, init);
};

/* ---------- قاعدة بيانات وهمية ---------- */
const DB = {
  fcm_tokens: [
    { id: "tok-1", token: "TOKEN_A", user_id: "u-1111", platform: "web", device_id: "dev-1" },
    { id: "tok-2", token: "TOKEN_DEAD", user_id: "u-1111", platform: "web", device_id: "dev-2" },
    { id: "tok-3", token: "TOKEN_ADMIN", user_id: "a-2222", platform: "web", device_id: "dev-3" },
    { id: "tok-4", token: "TOKEN_SUPER", user_id: "s-3333", platform: "web", device_id: "dev-4" },
    { id: "tok-5", token: "TOKEN_CUSTOMER", user_id: "u-4444", platform: "web", device_id: "dev-5" },
  ],
  conversations: [
    { id: "c-1", user_id: "u-1111", admin_id: "a-2222" },
    { id: "c-2", user_id: "x-0000", admin_id: "y-0000" },
    { id: "c-3", user_id: "u-4444", admin_id: "a-2222" },
  ],
  call_rooms: [
    {
      id: "r-1", conversation_id: "c-1", caller_id: "u-1111", callee_id: "a-2222",
      status: "ringing", call_type: "audio", started_at: new Date().toISOString(),
    },
    {
      id: "r-2", conversation_id: "c-1", caller_id: "u-1111", callee_id: "a-2222",
      status: "ended", call_type: "audio", started_at: new Date(Date.now() - 300000).toISOString(),
    },
  ],
  profiles: [
    { id: "u-1111", display_name: "سارة", is_admin: false, is_super_admin: false, is_blocked: false },
    { id: "a-2222", display_name: "المشرف", is_admin: true, is_super_admin: false, is_blocked: false },
    { id: "s-3333", display_name: "السوبر", is_admin: false, is_super_admin: true, is_blocked: false },
    { id: "sup-4444", display_name: "السوبر المجيب", is_admin: true, is_super_admin: true, is_blocked: false },
    { id: "u-4444", display_name: "عميل المحادثة", is_admin: false, is_super_admin: false, is_blocked: false },
  ],
  push_delivery_log: [],
};
const STUB_CALLS = [];
globalThis.__STUB_DB__ = DB;
globalThis.__STUB_CALLS__ = STUB_CALLS;
globalThis.__STUB_USERS__ = { "user-jwt": { id: "u-1111" }, "admin-jwt": { id: "a-2222" } };

/* ---------- استيراد الدالة الحقيقية ---------- */
await import("../supabase/functions/send-push/index.ts");
const server = await started;
if (!handler) {
  console.error("FAIL: Deno.serve لم يُسجّل معالجاً");
  process.exit(1);
}

/* ---------- أدوات ---------- */
let fails = 0;
const check = (name, ok, extra = "") => {
  console.log(ok ? "✅" : "❌", name, extra ? `— ${extra}` : "");
  if (!ok) fails += 1;
};
const post = async (payload, headers = {}) => {
  const res = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, json };
};
const webhook = (table, type, record, old_record = null) => ({
  type, table, schema: "public", record, old_record,
});
const resetCalls = () => { STUB_CALLS.length = 0; };

/* ============================================================
 * 1) اختبار تجريبي (JWT مستخدم) — عقد الطلب لكل جهاز
 * ============================================================ */
FCM_LOG.length = 0;
{
  const { status, json } = await post({ type: "test" }, { Authorization: "Bearer user-jwt" });
  check("test: 200 وأُرسل لجهازين", status === 200 && json?.sent === 2 && json?.total === 2, JSON.stringify(json ?? {}));
  check("test: POST مباشر إلى FCM HTTP v1",
    FCM_LOG.length === 2 && FCM_LOG.every((r) => r.url === "https://fcm.googleapis.com/v1/projects/demo-project/messages:send" && r.method === "POST"));
  check("test: كل جهاز استلم توكنه", JSON.stringify(FCM_LOG.map((r) => r.body.message.token).sort()) === JSON.stringify(["TOKEN_A", "TOKEN_DEAD"]));
  const req = FCM_LOG[0];
  check("test: مصادقة OAuth Bearer بلا أي سرّ مشترك", req.headers.authorization === "Bearer fcm-access-token");
  check("test: json + data-only بلا حقل notification",
    req.headers["content-type"].includes("application/json") &&
      req.body.message.notification === undefined &&
      req.body.message.data.type === "test");
  check("test: أولوية عالية وTTL 60s",
    req.body.message.android.priority === "HIGH" && req.body.message.android.ttl === "60s",
    `priority=${req.body.message.android.priority} ttl=${req.body.message.android.ttl}`);
  check("test: سجل التسليم مصدره manual",
    STUB_CALLS.some((c) => c.kind === "insert" && c.table === "push_delivery_log" && c.values.kind === "test" && c.values.source === "manual"));
}

/* ============================================================
 * 2) diagnostics
 * ============================================================ */
{
  const { status, json } = await post({ type: "diagnostics" }, { Authorization: "Bearer user-jwt" });
  check("diagnostics: 200 وتفعيل pg_net وتريگرات القاعدة البسيطة (بلا Vault)", status === 200 &&
    json?.database_notifications?.pg_net === true &&
    json?.database_notifications?.vault === false &&
    json?.database_notifications?.db_triggers === true &&
    Array.isArray(json?.database_notifications?.triggers) &&
    json.database_notifications.triggers.includes("send_fcm_on_new_message"), JSON.stringify(json?.database_notifications ?? null));
  check("diagnostics: معمارية pg_net + تريگرات القاعدة المتوقعة",
    json?.architecture === "pg_net-database-triggers" &&
      JSON.stringify(json?.webhook?.expected_hooks?.map((h) => h.table)) === JSON.stringify(["messages", "call_rooms", "profiles"]));
  check("diagnostics: سرّ التريگر مضبوط وأجهزة الحساب = 2",
    json?.checks?.webhook_secret_ready === true && json?.me?.devices === 2);
  check("diagnostics: بلا JWT ⇒ 401", (await post({ type: "diagnostics" })).status === 401);
}

/* ============================================================
 * 3) رسالة جديدة عبر Webhook — التسليم + delivered
 * ============================================================ */
FCM_LOG.length = 0;
resetCalls();
{
  const { status, json } = await post(
    webhook("messages", "INSERT", { id: "m-1", conversation_id: "c-1", sender_id: "u-1111", content: "مرحبا" }),
    { "x-send-push-secret": SECRET },
  );
  check("new_message: مُستلم واحد (الطرف الآخر)", status === 200 && json?.sent === 1 && json?.total === 1, JSON.stringify(json ?? {}));
  check("new_message: التوكن الخاص بالمشرف a-2222", FCM_LOG[0]?.body?.message?.token === "TOKEN_ADMIN");
  check("new_message: TTL يوم وأولوية عالية",
    FCM_LOG[0]?.body?.message?.android?.ttl === "86400s" && FCM_LOG[0]?.body?.message?.android?.priority === "HIGH");
  check("new_message: مفاتيح التوجيه في data",
    FCM_LOG[0]?.body?.message?.data?.type === "new_message" &&
      FCM_LOG[0]?.body?.message?.data?.messageId === "m-1" &&
      FCM_LOG[0]?.body?.message?.data?.conversationId === "c-1" &&
      FCM_LOG[0]?.body?.message?.data?.senderId === "u-1111");
  check("new_message: العنوان اسم المرسل والنص محتوى الرسالة",
    FCM_LOG[0]?.body?.message?.data?.title === "سارة" && FCM_LOG[0]?.body?.message?.data?.body === "مرحبا");
  check("new_message: عُلّمت delivered", json?.delivered === true);
  const update = STUB_CALLS.find((c) => c.kind === "update" && c.table === "messages");
  const filters = JSON.stringify(update?.filters || []);
  check("new_message: التحديث على id الرسالة وstatus='sent'",
    update?.values?.status === "delivered" && filters.includes("m-1") && filters.includes("sent"), filters);
  check("new_message: سجل التسليم مصدره webhook",
    STUB_CALLS.some((c) => c.kind === "insert" && c.table === "push_delivery_log" && c.values.kind === "new_message" && c.values.source === "webhook"));

  // نفس الحدث مرة أخرى (إعادة محاولة Webhook) ⇒ لا إرسال ثانٍ
  FCM_LOG.length = 0;
  const again = await post(
    webhook("messages", "INSERT", { id: "m-1", conversation_id: "c-1", sender_id: "u-1111", content: "مرحبا" }),
    { "x-send-push-secret": SECRET },
  );
  check("new_message: إعادة نفس الحدث تُتجاهل (dedupe)", again.status === 200 && FCM_LOG.length === 0 &&
    /duplicate/.test(String(again.json?.skipped)), String(again.json?.skipped));
}

/* ============================================================
 * 4) حراس العزل والأمان
 * ============================================================ */
FCM_LOG.length = 0;
{
  const stranger = await post(
    webhook("messages", "INSERT", { id: "m-2", conversation_id: "c-2", sender_id: "u-1111" }),
    { "x-send-push-secret": SECRET },
  );
  check("العزل: مرسل خارج أطراف المحادثة ⇒ تخطٍّ مكتوم",
    stranger.status === 200 && stranger.json?.skipped === "sender is not a conversation party" && FCM_LOG.length === 0,
    String(stranger.json?.skipped));

  const mismatch = await post(
    webhook("messages", "INSERT", { id: "m-3", conversation_id: "c-1", sender_id: "u-1111", recipient_id: "s-3333" }),
    { "x-send-push-secret": SECRET },
  );
  check("العزل: recipient_id مخالف ⇒ 409 بلا إرسال",
    mismatch.status === 409 && mismatch.json?.skipped === "recipient mismatch" && FCM_LOG.length === 0);

  const wrongSecret = await post(
    webhook("messages", "INSERT", { id: "m-4", conversation_id: "c-1", sender_id: "u-1111" }),
    { "x-send-push-secret": "WRONG" },
  );
  check("الأمان: سرّ خاطئ ⇒ 401 بلا إرسال", wrongSecret.status === 401 && FCM_LOG.length === 0);

  const wrongTable = await post(
    webhook("secrets", "INSERT", { id: "x-1" }),
    { "x-send-push-secret": SECRET },
  );
  check("الأمان: جدول غير مدعوم ⇒ 400", wrongTable.status === 400 && FCM_LOG.length === 0);

  const ignored = await post(
    webhook("messages", "UPDATE", { id: "m-5", conversation_id: "c-1", sender_id: "u-1111" }, { id: "m-5" }),
    { "x-send-push-secret": SECRET },
  );
  check("الأمان: UPDATE على messages يُتجاهل بلا خطأ", ignored.status === 200 && ignored.json?.ignored, JSON.stringify(ignored.json));
}

/* ============================================================
 * 5) ردّ المشرف العام في محادثة ليس طرفاً فيها
 * ============================================================ */
FCM_LOG.length = 0;
{
  const { status, json } = await post(
    webhook("messages", "INSERT", {
      id: "m-9", conversation_id: "c-3", sender_id: "sup-4444",
      content: "رد المشرف العام", recipient_id: "u-4444",
    }),
    { "x-send-push-secret": SECRET },
  );
  check("super reply: مقبول بلا رفض عزل", status === 200 && json?.sent === 1, JSON.stringify(json ?? {}));
  check("super reply: وصل لصاحب المحادثة فقط", FCM_LOG[0]?.body?.message?.token === "TOKEN_CUSTOMER");
  check("super reply: العنوان اسم المشرف العام",
    FCM_LOG[0]?.body?.message?.data?.title === "السوبر المجيب" &&
      FCM_LOG[0]?.body?.message?.data?.senderId === "sup-4444");
}

/* ============================================================
 * 6) المكالمات: رنين ⇒ callee فقط، وانتهاء ⇒ callee فقط
 * ============================================================ */
FCM_LOG.length = 0;
{
  const ring = await post(
    webhook("call_rooms", "INSERT", DB.call_rooms[0]),
    { "x-send-push-secret": SECRET },
  );
  check("incoming_call: أُرسل للـ callee وحده", ring.status === 200 && ring.json?.sent === 1 &&
    FCM_LOG.length === 1 && FCM_LOG[0].body.message.token === "TOKEN_ADMIN", JSON.stringify(ring.json ?? {}));
  check("incoming_call: TTL 60s ومفتاح roomId",
    FCM_LOG[0]?.body?.message?.android?.ttl === "60s" && FCM_LOG[0]?.body?.message?.data?.roomId === "r-1");

  FCM_LOG.length = 0;
  const ended = await post(
    webhook("call_rooms", "UPDATE", { ...DB.call_rooms[1], status: "missed" }, { status: "ringing" }),
    { "x-send-push-secret": SECRET },
  );
  check("call_ended: miss⇒ إشعار للـ callee", ended.status === 200 && ended.json?.sent === 1 &&
    FCM_LOG[0]?.body?.message?.data?.type === "call_ended", JSON.stringify(ended.json ?? {}));

  FCM_LOG.length = 0;
  const stale = await post(
    webhook("call_rooms", "INSERT", {
      ...DB.call_rooms[0], id: "r-old", started_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    }),
    { "x-send-push-secret": SECRET },
  );
  check("incoming_call: رنين قديم (10 دقائق) ⇒ لا إشعار", stale.status === 200 && FCM_LOG.length === 0,
    String(stale.json?.skipped));
}

/* ============================================================
 * 7) مستخدم جديد (profiles INSERT) — بث للمشرفين
 * ============================================================ */
FCM_LOG.length = 0;
{
  const { status, json } = await post(
    webhook("profiles", "INSERT", { id: "u-1111", display_name: "سارة", email: "sara@example.test" }),
    { "x-send-push-secret": SECRET },
  );
  check("new_user: أُشعر المشرفون الثلاثة (توكنان متاحان)", status === 200 && json?.admins === 3 && json?.sent === 2,
    JSON.stringify(json ?? {}));
  check("new_user: توكن كل مشرف على حدة",
    JSON.stringify(FCM_LOG.map((r) => r.body.message.token).sort()) === JSON.stringify(["TOKEN_ADMIN", "TOKEN_SUPER"].sort()));
  check("new_user: type + userId في data",
    FCM_LOG[0]?.body?.message?.data?.type === "new_user" && FCM_LOG[0]?.body?.message?.data?.userId === "u-1111");
}

/* ============================================================
 * 7b) diagnostics بعد أحداث حقيقية — السجل يثبت تدفّق الـ Webhook
 * ============================================================ */
{
  const { status, json } = await post({ type: "diagnostics" }, { Authorization: "Bearer admin-jwt" });
  const recent = json?.delivery_log?.recent || [];
  check("diagnostics: سجل التسليم يعرض أحداث Webhook الأخيرة", status === 200 && recent.length > 0 &&
    recent.every((row) => row.source === "webhook"), JSON.stringify(recent.slice(0, 2)));
  check("diagnostics: checks.webhook_flow_observed = true",
    json?.checks?.webhook_flow_observed === true && Number(json?.delivery_log?.webhook_events_seen) > 0);
}

/* ============================================================
 * 8) حذف التوكن الميت فقط (404 UNREGISTERED)
 * ============================================================ */
FCM_LOG.length = 0;
resetCalls();
fcmStatus = (body) => (body?.message?.token === "TOKEN_DEAD" ? 404 : 200);
{
  const { json } = await post({ type: "test" }, { Authorization: "Bearer user-jwt" });
  check("توكن ميت: نجح السليم وفشل الميت", json?.sent === 1 && json?.total === 2 &&
    json?.results?.find((r) => r.tokenId === "tok-2")?.removed === true, JSON.stringify(json?.results ?? []));
  const del = STUB_CALLS.find((c) => c.kind === "delete" && c.table === "fcm_tokens");
  check("توكن ميت: حُذف صف tok-2 فقط", JSON.stringify(del?.filters || []).includes("tok-2"), JSON.stringify(del?.filters || []));
}
fcmStatus = () => 200;

/* ============================================================
 * 9) إعادة المحاولة بعد 429
 * ============================================================ */
FCM_LOG.length = 0;
let attempts = 0;
fcmStatus = () => (++attempts === 1 ? 429 : 200);
{
  const { json } = await post({ type: "test" }, { Authorization: "Bearer user-jwt" });
  check("إعادة المحاولة: 429 ثم نجاح", json?.sent === 2 && FCM_LOG.length >= 3, `attempts=${attempts} logs=${FCM_LOG.length}`);
}
fcmStatus = () => 200;

/* ============================================================
 * 10) JWT حساب الخدمة
 * ============================================================ */
{
  check("OAuth: scope/audience/issuer صحيحة",
    oauthClaims?.iss === "push-test@demo-project.iam.gserviceaccount.com" &&
      oauthClaims?.scope === "https://www.googleapis.com/auth/firebase.messaging" &&
      oauthClaims?.aud === "https://oauth2.googleapis.com/token" &&
      oauthClaims?.exp > oauthClaims?.iat,
    JSON.stringify(oauthClaims ?? null));
}

server.close();
console.log(fails ? `\n❌ SEND-PUSH RUNTIME TESTS FAILED: ${fails}` : "\nSEND-PUSH RUNTIME TESTS PASSED");
process.exit(fails ? 1 : 0);
