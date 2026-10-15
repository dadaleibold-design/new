/*
 * send-push-runtime.test.ts — اختبار تشغيلي فعلي لدالة send-push (v2.12)
 * -------------------------------------------------------------
 * يشغّل ملف `supabase/functions/send-push/index.ts` الحقيقي على Deno:
 *   • محاكي Cloudflare Worker على 127.0.0.1:8999 يسجّل كل طلب ويصادر الحالة.
 *   • عميل supabase-js وهمي عبر import-map (بديل محلي بلا شبكة).
 * ويتحقق من:
 *   1) عقد الطلب لكل جهاز: POST {token,title,body,data(,priority,ttlSeconds)}
 *      إلى رابط البوابة الواحد مع ترويستي المصادقة (Authorization + x-send-push-secret).
 *   2) بقاء قواعد الأمان: عزل المستلم (الطرف الآخر فقط)، رفض المرسل غير الطرف،
 *      رفض تعارض المستلم المصرَّح به، رفض السرّ الخاطئ 401.
 *   3) حذف التوكن الميّت (410) فقط، وتعليم delivered بعد النجاح.
 *   4) المسبار (probe) والإشعار الجماعي (new_user) وإعادة المحاولة بعد 429.
 *   5) ⛔ حارس الحلقة عبر عملية فرعية (loop-guard-check.ts).
 *
 * التشغيل:
 *   deno run --allow-all --import-map tests/deno/import-map.json \
 *     tests/deno/send-push-runtime.test.ts
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
const GATEWAY_PORT = 8999;
const FUNCTION_PORT = 8000; // Deno.serve الافتراضي في CLI
const GATEWAY_URL = `http://127.0.0.1:${GATEWAY_PORT}/`;
const FUNCTION_URL = `http://127.0.0.1:${FUNCTION_PORT}/`;

/* ---------- بيئة الدالة (قبل الاستيراد) ---------- */
Deno.env.set("SUPABASE_URL", "http://stub.supabase.co");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "stub-service-key");
Deno.env.set("SEND_PUSH_SECRET", "trigger-secret");
Deno.env.set("PUSH_GATEWAY_URL", GATEWAY_URL);
Deno.env.set("PUSH_GATEWAY_SECRET", "gw-secret");

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

/* ---------- محاكي بوابة الـ Worker ---------- */
type GatewayRequest = { url: string; method: string; headers: Record<string, string>; body: any };
const GW_LOG: GatewayRequest[] = [];
// مصدر الحالة: دالة تُقرأ في كل طلب (يضبطها الاختبار بين السيناريوهات)
(globalThis as any).__GW_STATUS__ = (_body: any) => 200;

Deno.serve({ port: GATEWAY_PORT }, async (req) => {
  const body = await req.json().catch(() => null);
  GW_LOG.push({
    url: req.url,
    method: req.method,
    headers: {
      authorization: req.headers.get("authorization") || "",
      "x-send-push-secret": req.headers.get("x-send-push-secret") || "",
      "content-type": req.headers.get("content-type") || "",
    },
    body,
  });
  const status = (globalThis as any).__GW_STATUS__(body);
  if (status >= 400) return new Response(JSON.stringify({ error: "gateway stub error" }), { status });
  return new Response(JSON.stringify({ name: "projects/demo/messages/1" }), { status });
});

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
GW_LOG.length = 0;
{
  const { status, json } = await post({ type: "test" }, { Authorization: "Bearer user-jwt" });
  check("test: استجابة 200 وأُرسل لجهازين", status === 200 && json?.sent === 2 && json?.total === 2, JSON.stringify(json?.error || ""));
  check("test: طلبي POST إلى رابط البوابة الواحد", GW_LOG.length === 2 && GW_LOG.every((r) => r.url === GATEWAY_URL && r.method === "POST"));

  const tokens = GW_LOG.map((r) => r.body?.token).sort();
  check("test: كل جهاز استلم توكنه الخاص", JSON.stringify(tokens) === JSON.stringify(["TOKEN_A", "TOKEN_DEAD"].sort()), tokens.join(","));

  const req = GW_LOG[0];
  check(
    "test: ترويستا المصادقة للبوابة (Authorization Bearer + x-send-push-secret)",
    req.headers.authorization === "Bearer gw-secret" && req.headers["x-send-push-secret"] === "gw-secret",
  );
  check("test: Content-Type: application/json", req.headers["content-type"].includes("application/json"));
  check(
    "test: جسم الطلب {token,title,body,data} — data مرآة للعرض (data-only)",
    typeof req.body?.token === "string" &&
      req.body?.title === "✅ الإشعارات تعمل" &&
      typeof req.body?.body === "string" &&
      req.body?.data?.title === req.body.title &&
      req.body?.data?.type === "test" &&
      Object.values(req.body?.data || {}).every((v) => typeof v === "string"),
  );
  check(
    "test: تلميحا الأولوية (high) والصلاحية (60s) لأولوية عالية",
    req.body?.priority === "high" && req.body?.ttlSeconds === 60,
    `priority=${req.body?.priority} ttl=${req.body?.ttlSeconds}`,
  );
}

/* ============================================================
 * السيناريو 2: رسالة جديدة — العزل والتسليم (delivered)
 * ============================================================ */
GW_LOG.length = 0;
resetStubCalls();
{
  const { status, json } = await post(
    { message_id: "m-1", conversation_id: "c-1", sender_id: "u-1111", content: "مرحبا" },
    { "x-send-push-secret": "trigger-secret" },
  );
  check("new_message: أُرسل لمستلمٍ واحد (الطرف الآخر)", status === 200 && json?.sent === 1 && json?.total === 1);
  check("new_message: وصل التوكن الخاص بالمشرف (a-2222)", GW_LOG[0]?.body?.token === "TOKEN_ADMIN");
  check(
    "new_message: أولوية رسالة الدردشة high بصلاحية يوم",
    GW_LOG[0]?.body?.priority === "high" && GW_LOG[0]?.body?.ttlSeconds === 86400,
  );
  check(
    "new_message: data تحمل مفاتيح التوجيه",
    GW_LOG[0]?.body?.data?.type === "new_message" &&
      GW_LOG[0]?.body?.data?.messageId === "m-1" &&
      GW_LOG[0]?.body?.data?.conversationId === "c-1" &&
      GW_LOG[0]?.body?.data?.senderId === "u-1111",
  );
  check(
    "new_message: العنوان من اسم المرسل والمحتوى من الرسالة",
    GW_LOG[0]?.body?.title === "سارة" && GW_LOG[0]?.body?.body === "مرحبا" &&
      GW_LOG[0]?.body?.data?.title === "سارة",
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
GW_LOG.length = 0;
{
  const a = await post(
    { message_id: "m-2", conversation_id: "c-2", sender_id: "u-1111" },
    { "x-send-push-secret": "trigger-secret" },
  );
  check(
    "العزل: المرسل غير طرف في المحادثة ⇒ رفض مكتوم بلا إرسال",
    a.status === 200 && a.json?.skipped === "sender is not a conversation party" && GW_LOG.length === 0,
  );

  const b = await post(
    { message_id: "m-3", conversation_id: "c-1", sender_id: "u-1111", recipient_id: "s-3333" },
    { "x-send-push-secret": "trigger-secret" },
  );
  check(
    "العزل: تعارض المستلم المصرَّح به ⇒ رفض 409 بلا إرسال",
    b.status === 409 && b.json?.skipped === "recipient mismatch" && GW_LOG.length === 0,
  );

  const c = await post({ message_id: "m-4", conversation_id: "c-1", sender_id: "u-1111" }, { "x-send-push-secret": "WRONG" });
  check("الأمان: سرّ خاطئ ⇒ 401 بلا إرسال", c.status === 401 && GW_LOG.length === 0);
}

/* ============================================================
 * السيناريو 5: حذف التوكن الميّت فقط (410 من البوابة)
 * ============================================================ */
GW_LOG.length = 0;
resetStubCalls();
(globalThis as any).__GW_STATUS__ = (body: any) => (body?.token === "TOKEN_DEAD" ? 410 : 200);
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
(globalThis as any).__GW_STATUS__ = (_body: any) => 200;

/* ============================================================
 * السيناريو 6: المسبار من قاعدة البيانات (probe)
 * ============================================================ */
GW_LOG.length = 0;
{
  const { status, json } = await post({ type: "probe", user_id: "a-2222" }, { "x-send-push-secret": "trigger-secret" });
  check("probe: أُرسل إشعار المسار الخلفي للمشرف", status === 200 && json?.sent === 1);
  check(
    "probe: نفس مسار البوابة (عقد الطلب نفسه)",
    GW_LOG.length === 1 && GW_LOG[0].body?.data?.type === "test" && GW_LOG[0].body?.ttlSeconds === 60,
  );
}

/* ============================================================
 * السيناريو 6b: ردّ المشرف العام في محادثة ليست طرفاً فيها (v2.13)
 * المستلم = المستخدم صاحب المحادثة حصراً (وليس المشرف المالك ولا غيره)
 * ============================================================ */
GW_LOG.length = 0;
resetStubCalls();
{
  const { status, json } = await post(
    { message_id: "m-9", conversation_id: "c-3", sender_id: "sup-4444", content: "رد المشرف العام", recipient_id: "u-4444" },
    { "x-send-push-secret": "trigger-secret" },
  );
  check("super reply: ردّ المشرف العام مقبول (بلا 403/رفض عزل)", status === 200 && json?.sent === 1, JSON.stringify(json));
  check("super reply: الإشعار ذهب للمستخدم صاحب المحادثة (TOKEN_CUSTOMER)", GW_LOG[0]?.body?.token === "TOKEN_CUSTOMER", GW_LOG[0]?.body?.token);
  check(
    "super reply: العنوان من اسم المشرف العام والمحتوى من ردّه",
    GW_LOG[0]?.body?.title === "السوبر المجيب" && GW_LOG[0]?.body?.body === "رد المشرف العام",
  );
  check(
    "super reply: data تحمل معرّفات المحادثة والمرسل",
    GW_LOG[0]?.body?.data?.conversationId === "c-3" && GW_LOG[0]?.body?.data?.senderId === "sup-4444",
  );
}

/* ============================================================
 * السيناريو 7: new_user — إشعار جماعي لكل المشرفين النشطين
 * ============================================================ */
GW_LOG.length = 0;
resetStubCalls();
{
  const { status, json } = await post(
    { type: "new_user", user_id: "u-1111", display_name: "سارة", email: "sara@example.test", created_at: "2026-10-15T00:00:00Z" },
    { "x-send-push-secret": "trigger-secret" },
  );
  check("new_user: أُشعر كل المشرفين النشطين الثلاثة (لثلاثة توكنات فقط)", status === 200 && json?.admins === 3 && json?.sent === 2, JSON.stringify(json));
  const tokens = GW_LOG.map((r) => r.body?.token).sort();
  check("new_user: توكن كل مشرف يملك جهازاً على حدة", JSON.stringify(tokens) === JSON.stringify(["TOKEN_ADMIN", "TOKEN_SUPER"].sort()));
  check(
    "new_user: العنوان يحمل الاسم ومفتاح التوجيه userId",
    GW_LOG[0]?.body?.data?.type === "new_user" &&
      GW_LOG[0]?.body?.data?.userId === "u-1111" &&
      String(GW_LOG[0]?.body?.title).includes("سارة"),
  );
}

/* ============================================================
 * السيناريو 8: إعادة المحاولة بعد 429 ثم نجاح
 * ============================================================ */
GW_LOG.length = 0;
let attempts = 0;
(globalThis as any).__GW_STATUS__ = (_body: any) => (++attempts === 1 ? 429 : 200);
{
  const { json } = await post({ type: "probe", user_id: "s-3333" }, { "x-send-push-secret": "trigger-secret" });
  check("إعادة المحاولة: 429 ثم نجاح ⇒ sent=1 بمحاولتين", json?.sent === 1 && GW_LOG.length === 2, `attempts=${attempts}`);
}
(globalThis as any).__GW_STATUS__ = (_body: any) => 200;

/* ============================================================
 * السيناريو 9: ⛔ حارس الحلقة (عملية فرعية)
 * ============================================================ */
{
  const deno = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-all",
      "--import-map",
      new URL("./import-map.json", import.meta.url).pathname,
      new URL("./loop-guard-check.ts", import.meta.url).pathname,
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout } = await deno.output();
  check("⛔ حارس الحلقة: رفض بوابة تشير إلى دالة Supabase نفسها", code === 0, new TextDecoder().decode(stdout).trim());
}

console.log(fails ? `\n❌ SEND-PUSH RUNTIME TESTS FAILED: ${fails}` : "\nSEND-PUSH RUNTIME TESTS PASSED");
Deno.exit(fails ? 1 : 0);
