/*
 * send-push-runtime.test.ts — اختبار تشغيلي فعلي لدالة send-push (FCM المباشر).
 * يستخدم حساب خدمة RSA مولداً للاختبار، ويحاكي OAuth2 وFCM HTTP v1 دون شبكة.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
const FUNCTION_PORT = 8000;
const FUNCTION_URL = `http://127.0.0.1:${FUNCTION_PORT}/`;

const generated = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
);
const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", generated.privateKey));
let pemBody = "";
for (let i = 0; i < pkcs8.length; i++) pemBody += String.fromCharCode(pkcs8[i]);
const pemEncoded = btoa(pemBody).match(/.{1,64}/g)?.join("\n") || "";
Deno.env.set("SUPABASE_URL", "http://stub.supabase.co");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "stub-service-key");
Deno.env.set("SEND_PUSH_SECRET", "trigger-secret");
Deno.env.set("FIREBASE_SERVICE_ACCOUNT", JSON.stringify({
  project_id: "demo-project",
  client_email: "push-test@demo-project.iam.gserviceaccount.com",
  private_key: `-----BEGIN PRIVATE KEY-----\n${pemEncoded}\n-----END PRIVATE KEY-----\n`,
}));

/* ---------- محاكاة OAuth2 + FCM HTTP v1 ---------- */
type FcmRequest = { url: string; method: string; headers: Record<string, string>; body: any };
const FCM_LOG: FcmRequest[] = [];
(globalThis as any).__FCM_STATUS__ = (_body: any) => 200;
const originalFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url === "https://oauth2.googleapis.com/token") {
    const form = new URLSearchParams(String(init?.body || ""));
    const assertion = form.get("assertion") || "";
    const claimsPart = assertion.split(".")[1] || "";
    const claims = JSON.parse(atob(claimsPart.replace(/-/g, "+").replace(/_/g, "/")));
    (globalThis as any).__OAUTH_CLAIMS__ = claims;
    return new Response(JSON.stringify({ access_token: "fcm-access-token", expires_in: 3600 }), { status: 200 });
  }
  if (url.includes("fcm.googleapis.com/v1/projects/demo-project/messages:send")) {
    const body = JSON.parse(String(init?.body || "{}"));
    FCM_LOG.push({
      url,
      method: String(init?.method || "GET"),
      headers: {
        authorization: new Headers(init?.headers).get("authorization") || "",
        "content-type": new Headers(init?.headers).get("content-type") || "",
      },
      body,
    });
    const status = (globalThis as any).__FCM_STATUS__(body);
    if (status >= 400) {
      const errorCode = status === 404 ? "UNREGISTERED" : "INVALID_ARGUMENT";
      return new Response(JSON.stringify({ error: { code: status, message: "mock FCM error", details: [{ errorCode }] } }), { status });
    }
    return new Response(JSON.stringify({ name: "projects/demo-project/messages/1" }), { status });
  }
  return originalFetch(input, init);
}) as typeof fetch;

/* ---------- قاعدة بيانات وهمية ---------- */
const DB: Record<string, any[]> = {
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
    { id: "c-3", user_id: "u-4444", admin_id: "a-2222" }, // محادثة مستخدم مع مشرف عادي — المشرف العام سيردّ فيها
  ],
  profiles: [
    { id: "u-1111", display_name: "سارة", is_admin: false, is_super_admin: false, is_blocked: false },
    { id: "a-2222", display_name: "المشرف", is_admin: true, is_super_admin: false, is_blocked: false },
    { id: "s-3333", display_name: "السوبر", is_admin: false, is_super_admin: true, is_blocked: false },
    { id: "sup-4444", display_name: "السوبر المجيب", is_admin: true, is_super_admin: true, is_blocked: false },
    { id: "u-4444", display_name: "عميل المحادثة", is_admin: false, is_super_admin: false, is_blocked: false },
  ],
};
const USERS: Record<string, any> = { "user-jwt": { id: "u-1111" } };

(globalThis as any).__STUB_DB__ = DB;
(globalThis as any).__STUB_CALLS__ = [];
(globalThis as any).__STUB_USERS__ = USERS;
const STUB_CALLS: any[] = (globalThis as any).__STUB_CALLS__;

/* ---------- استيراد الدالة الحقيقية ---------- */
await import(new URL("../../supabase/functions/send-push/index.ts", import.meta.url).href);

/* ---------- انتظار جهوزية خادم الدالة ---------- */
let functionUp = false;
for (let i = 0; i < 50 && !functionUp; i++) {
  try {
    const res = await fetch(FUNCTION_URL, { method: "OPTIONS" });
    functionUp = res.ok;
  } catch {
    await new Promise((r) => setTimeout(r, 100));
  }
}
if (!functionUp) {
  console.error("FAIL: function server did not start on", FUNCTION_URL);
  Deno.exit(1);
}

/* ---------- أدوات الفحص ---------- */
let fails = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(ok ? "✅" : "❌", name, extra ? `— ${extra}` : "");
  if (!ok) fails += 1;
};
const post = async (payload: any, headers: Record<string, string> = {}) => {
  const res = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
  let json: any = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, json };
};
const resetStubCalls = () => { STUB_CALLS.length = 0; };

/* ============================================================
 * السيناريو 1: إشعار تجريبي (JWT مستخدم) — عقد الطلب لكل جهاز
 * ============================================================ */
FCM_LOG.length = 0;
{
  const { status, json } = await post({ type: "test" }, { Authorization: "Bearer user-jwt" });
  check("test: استجابة 200 وأُرسل لجهازين", status === 200 && json?.sent === 2 && json?.total === 2, JSON.stringify(json?.error || ""));
  check("test: طلبي POST إلى عنوان FCM HTTP v1 المباشر", FCM_LOG.length === 2 && FCM_LOG.every((r) => r.url === "https://fcm.googleapis.com/v1/projects/demo-project/messages:send" && r.method === "POST"));

  const tokens = FCM_LOG.map((r) => r.body?.message?.token).sort();
  check("test: كل جهاز استلم توكنه الخاص", JSON.stringify(tokens) === JSON.stringify(["TOKEN_A", "TOKEN_DEAD"].sort()), tokens.join(","));

  const req = FCM_LOG[0];
  check(
    "test: مصادقة FCM (Google OAuth Bearer، بلا سر Worker)",
    req.headers.authorization === "Bearer fcm-access-token",
  );
  check("test: Content-Type: application/json", req.headers["content-type"].includes("application/json"));
  check(
    "test: جسم الطلب {token,title,body,data} — data مرآة للعرض (data-only)",
    typeof req.body?.message?.token === "string" &&
      req.body?.message?.data?.title === "✅ الإشعارات تعمل" &&
      typeof req.body?.message?.data?.body === "string" &&
      req.body?.message?.data?.title === "✅ الإشعارات تعمل" &&
      req.body?.message?.data?.type === "test" &&
      Object.values(req.body?.message?.data || {}).every((v) => typeof v === "string"),
  );
  check(
    "test: تلميحا الأولوية (high) والصلاحية (60s) لأولوية عالية",
    req.body?.message?.android?.priority === "HIGH" && req.body?.message?.android?.ttl === "60s",
    `priority=${req.body?.message?.android?.priority} ttl=${req.body?.message?.android?.ttl}`,
  );
}

/* ============================================================
 * السيناريو 2: رسالة جديدة — العزل والتسليم (delivered)
 * ============================================================ */
FCM_LOG.length = 0;
resetStubCalls();
{
  const { status, json } = await post(
    { message_id: "m-1", conversation_id: "c-1", sender_id: "u-1111", content: "مرحبا" },
    { "x-send-push-secret": "trigger-secret" },
  );
  check("new_message: أُرسل لمستلمٍ واحد (الطرف الآخر)", status === 200 && json?.sent === 1 && json?.total === 1);
  check("new_message: وصل التوكن الخاص بالمشرف (a-2222)", FCM_LOG[0]?.body?.message?.token === "TOKEN_ADMIN");
  check(
    "new_message: أولوية رسالة الدردشة high بصلاحية يوم",
    FCM_LOG[0]?.body?.message?.android?.priority === "HIGH" && FCM_LOG[0]?.body?.message?.android?.ttl === "86400s",
  );
  check(
    "new_message: data تحمل مفاتيح التوجيه",
    FCM_LOG[0]?.body?.message?.data?.type === "new_message" &&
      FCM_LOG[0]?.body?.message?.data?.messageId === "m-1" &&
      FCM_LOG[0]?.body?.message?.data?.conversationId === "c-1" &&
      FCM_LOG[0]?.body?.message?.data?.senderId === "u-1111",
  );
  check(
    "new_message: العنوان من اسم المرسل والمحتوى من الرسالة",
    FCM_LOG[0]?.body?.message?.data?.title === "سارة" && FCM_LOG[0]?.body?.message?.data?.body === "مرحبا" &&
      FCM_LOG[0]?.body?.message?.data?.title === "سارة",
  );
  check("new_message: عُلّمت الرسالة delivered بعد النجاح", json?.delivered === true);
  const update = STUB_CALLS.find((c) => c.kind === "update" && c.table === "messages");
  const filters = JSON.stringify(update?.filters || []);
  check(
    "new_message: تحديث delivered مقصور على status='sent' وid الرسالة",
    Boolean(update) && update.values.status === "delivered" &&
      filters.includes("m-1") && filters.includes("sent"),
    filters,
  );
}

/* ============================================================
 * السيناريو 3+4: حراس العزل (بلا أي طلب شبكة)
 * ============================================================ */
FCM_LOG.length = 0;
{
  const a = await post(
    { message_id: "m-2", conversation_id: "c-2", sender_id: "u-1111" },
    { "x-send-push-secret": "trigger-secret" },
  );
  check(
    "العزل: المرسل غير طرف في المحادثة ⇒ رفض مكتوم بلا إرسال",
    a.status === 200 && a.json?.skipped === "sender is not a conversation party" && FCM_LOG.length === 0,
  );

  const b = await post(
    { message_id: "m-3", conversation_id: "c-1", sender_id: "u-1111", recipient_id: "s-3333" },
    { "x-send-push-secret": "trigger-secret" },
  );
  check(
    "العزل: تعارض المستلم المصرَّح به ⇒ رفض 409 بلا إرسال",
    b.status === 409 && b.json?.skipped === "recipient mismatch" && FCM_LOG.length === 0,
  );

  const c = await post({ message_id: "m-4", conversation_id: "c-1", sender_id: "u-1111" }, { "x-send-push-secret": "WRONG" });
  check("الأمان: سرّ خاطئ ⇒ 401 بلا إرسال", c.status === 401 && FCM_LOG.length === 0);
}

/* ============================================================
 * السيناريو 5: حذف التوكن الميّت فقط (404 UNREGISTERED من FCM)
 * ============================================================ */
FCM_LOG.length = 0;
resetStubCalls();
(globalThis as any).__FCM_STATUS__ = (body: any) => (body?.message?.token === "TOKEN_DEAD" ? 404 : 200);
{
  const { json } = await post({ type: "test" }, { Authorization: "Bearer user-jwt" });
  check(
    "توكن ميت: نجح السليم وفشل الميت (removed على صف التوكن الميت)",
    json?.sent === 1 && json?.total === 2 &&
      json?.results?.find((r: any) => r.tokenId === "tok-2")?.removed === true,
  );
  const del = STUB_CALLS.find((c) => c.kind === "delete" && c.table === "fcm_tokens");
  const filters = JSON.stringify(del?.filters || []);
  check("توكن ميت: حُذف صف التوكن الميت حصراً (tok-2)", Boolean(del) && filters.includes("tok-2"), filters);
}
(globalThis as any).__FCM_STATUS__ = (_body: any) => 200;

/* ============================================================
 * السيناريو 6: المسبار من قاعدة البيانات (probe)
 * ============================================================ */
FCM_LOG.length = 0;
{
  const { status, json } = await post({ type: "probe", user_id: "a-2222" }, { "x-send-push-secret": "trigger-secret" });
  check("probe: أُرسل إشعار المسار الخلفي للمشرف", status === 200 && json?.sent === 1);
  check(
    "probe: نفس مسار FCM المباشر بعقد data-only وTTL قصير",
    FCM_LOG.length === 1 && FCM_LOG[0].body?.message?.data?.type === "test" && FCM_LOG[0].body?.message?.android?.ttl === "60s",
  );
}

/* ============================================================
 * السيناريو 6b: ردّ المشرف العام في محادثة ليست طرفاً فيها (v2.13)
 * المستلم = المستخدم صاحب المحادثة حصراً (وليس المشرف المالك ولا غيره)
 * ============================================================ */
FCM_LOG.length = 0;
resetStubCalls();
{
  const { status, json } = await post(
    { message_id: "m-9", conversation_id: "c-3", sender_id: "sup-4444", content: "رد المشرف العام", recipient_id: "u-4444" },
    { "x-send-push-secret": "trigger-secret" },
  );
  check("super reply: ردّ المشرف العام مقبول (بلا 403/رفض عزل)", status === 200 && json?.sent === 1, JSON.stringify(json));
  check("super reply: الإشعار ذهب للمستخدم صاحب المحادثة (TOKEN_CUSTOMER)", FCM_LOG[0]?.body?.message?.token === "TOKEN_CUSTOMER", FCM_LOG[0]?.body?.message?.token);
  check(
    "super reply: العنوان من اسم المشرف العام والمحتوى من ردّه",
    FCM_LOG[0]?.body?.message?.data?.title === "السوبر المجيب" && FCM_LOG[0]?.body?.message?.data?.body === "رد المشرف العام",
  );
  check(
    "super reply: data تحمل معرّفات المحادثة والمرسل",
    FCM_LOG[0]?.body?.message?.data?.conversationId === "c-3" && FCM_LOG[0]?.body?.message?.data?.senderId === "sup-4444",
  );
}

/* ============================================================
 * السيناريو 7: new_user — إشعار جماعي لكل المشرفين النشطين
 * ============================================================ */
FCM_LOG.length = 0;
resetStubCalls();
{
  const { status, json } = await post(
    { type: "new_user", user_id: "u-1111", display_name: "سارة", email: "sara@example.test", created_at: "2026-10-15T00:00:00Z" },
    { "x-send-push-secret": "trigger-secret" },
  );
  check("new_user: أُشعر كل المشرفين النشطين الثلاثة (لثلاثة توكنات فقط)", status === 200 && json?.admins === 3 && json?.sent === 2, JSON.stringify(json));
  const tokens = FCM_LOG.map((r) => r.body?.message?.token).sort();
  check("new_user: توكن كل مشرف يملك جهازاً على حدة", JSON.stringify(tokens) === JSON.stringify(["TOKEN_ADMIN", "TOKEN_SUPER"].sort()));
  check(
    "new_user: العنوان يحمل الاسم ومفتاح التوجيه userId",
    FCM_LOG[0]?.body?.message?.data?.type === "new_user" &&
      FCM_LOG[0]?.body?.message?.data?.userId === "u-1111" &&
      String(FCM_LOG[0]?.body?.message?.data?.title).includes("سارة"),
  );
}

/* ============================================================
 * السيناريو 8: إعادة المحاولة بعد 429 ثم نجاح
 * ============================================================ */
FCM_LOG.length = 0;
let attempts = 0;
(globalThis as any).__FCM_STATUS__ = (_body: any) => (++attempts === 1 ? 429 : 200);
{
  const { json } = await post({ type: "probe", user_id: "s-3333" }, { "x-send-push-secret": "trigger-secret" });
  check("إعادة المحاولة: 429 ثم نجاح ⇒ sent=1 بمحاولتين", json?.sent === 1 && FCM_LOG.length === 2, `attempts=${attempts}`);
}
(globalThis as any).__FCM_STATUS__ = (_body: any) => 200;

/* ============================================================
 * السيناريو 9: OAuth service-account claims صحيحة ومباشرة
 * ============================================================ */
{
  const claims = (globalThis as any).__OAUTH_CLAIMS__;
  check(
    "JWT حساب الخدمة يحمل scope/audience الصحيحين لإرسال FCM",
    claims?.iss === "push-test@demo-project.iam.gserviceaccount.com" &&
      claims?.scope === "https://www.googleapis.com/auth/firebase.messaging" &&
      claims?.aud === "https://oauth2.googleapis.com/token" &&
      claims?.exp > claims?.iat,
  );
  check(
    "FCM يقبل طلباً مباشراً مع bearer OAuth وdata-only",
    FCM_LOG.every((r) => r.url.includes("fcm.googleapis.com/v1/projects/demo-project/messages:send") &&
      r.headers.authorization === "Bearer fcm-access-token"),
  );
}

console.log(fails ? `\n❌ SEND-PUSH RUNTIME TESTS FAILED: ${fails}` : "\nSEND-PUSH RUNTIME TESTS PASSED");
Deno.exit(fails ? 1 : 0);
