/*
 * اختبار عزل الإشعارات (v2.9) — منطق نقي + فحص المصادر
 * -------------------------------------------------------------
 * قسمان:
 *   (أ) اختبارات وحدة لمنطق العزل النقي (js/notification-scope.js):
 *       • رسالة من طرف آخر في محادثتي ⇒ تنبيه
 *       • رسالة في محادثة لست طرفاً فيها (مراقبة المشرف العام) ⇒ صامتة
 *       • بطاقة مكالمة/رسالتي أنا ⇒ بلا تنبيه
 *       • رنين المكالمة: callee_id فقط — لا للمتصل ولا لمن ليست له الغرفة
 *   (ب) فحص مصادر المشروع (بلا شبكة):
 *       • هجرة v2.9 = القسم 17 في schema.sql حرفياً (لا انحراف بين الملفين)
 *       • آخر تعريف فعّال للدوال في schema.sql هو النسخة المشدّدة
 *       • مسار المستخدم الجديد هو الإشعار الجماعي الوحيد (لا تقاطع مع الرسائل/المكالمات)
 *       • send-push والواجهة يتحققان من نفس القواعد
 *       • وضع المراقبة للقراءة فقط: القراءة/التسليم لأطراف المحادثة حصراً
 *
 * التشغيل:  node tests/notification-isolation.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

let fails = 0;
const check = (name, ok, extra = "") => {
  console.log(ok ? "✅" : "❌", name, extra || "");
  if (!ok) fails += 1;
};

const MIGRATION_FILE = "sql/migrations/2026-10-13_v2_9_notification_recipient_isolation.sql";
const MIGRATION = read(MIGRATION_FILE);
const SCHEMA = read("sql/schema.sql");
const SEND_PUSH = read("supabase/functions/send-push/index.ts");
const APP_JS = read("js/app.js");
const CALLS_JS = read("js/calls.js");
const SCOPE_JS = read("js/notification-scope.js");

/* ============================================================
 * (أ) منطق العزل النقي
 * ============================================================ */
const { shouldAlertForMessage, shouldRingForInvite, isConversationParty, conversationCounterpart } =
  await import("../js/notification-scope.js");

const ME = "user-me";
const OTHER = "user-other";
const SUPER = "user-super";
const CONV = { id: "c1", user_id: ME, admin_id: "admin-1" };
const MONITORED = { id: "c2", user_id: "user-x", admin_id: "admin-2" };

check("طرف مباشر: user_id", isConversationParty(CONV, ME) === true);
check("طرف مباشر: admin_id", isConversationParty(CONV, "admin-1") === true);
check("ليس طرفاً", isConversationParty(CONV, SUPER) === false);
check("الطرف الآخر من user_id ⇒ admin_id", conversationCounterpart(CONV, ME) === "admin-1");
check("الطرف الآخر من admin_id ⇒ user_id", conversationCounterpart(CONV, "admin-1") === ME);
check("مرسل خارج الأطراف ⇒ لا مقابل", conversationCounterpart(CONV, SUPER) === null);

check("رسالة من الطرف الآخر في محادثتي ⇒ تنبيه",
  shouldAlertForMessage({ message: { sender_id: "admin-1" }, conversation: CONV, meId: ME }).alert === true);
check("رسالة في محادثة مراقَبة (لست طرفاً) ⇒ صامتة",
  shouldAlertForMessage({ message: { sender_id: "user-x" }, conversation: MONITORED, meId: SUPER, isSuperAdmin: true }).alert === false);
check("سبب الصمت مُعلن (observer-silent)",
  shouldAlertForMessage({ message: { sender_id: "user-x" }, conversation: MONITORED, meId: SUPER, isSuperAdmin: true }).reason === "observer-silent");
check("رسالتي أنا (من جهاز آخر) ⇒ بلا تنبيه",
  shouldAlertForMessage({ message: { sender_id: ME }, conversation: CONV, meId: ME }).alert === false);
check("بطاقة مكالمة داخل الرسائل ⇒ بلا تنبيه رسالة",
  shouldAlertForMessage({ message: { sender_id: "admin-1", message_type: "call" }, conversation: CONV, meId: ME }).alert === false);
check("محادثة مجهولة + مشرف عام ⇒ صامتة",
  shouldAlertForMessage({ message: { sender_id: "user-x" }, conversation: null, meId: SUPER, isSuperAdmin: true }).alert === false);
check("محادثة مجهولة + مستخدم عادي ⇒ تنبيه (RLS تضمن أنها له)",
  shouldAlertForMessage({ message: { sender_id: "admin-1" }, conversation: null, meId: ME, isSuperAdmin: false }).alert === true);

const ROOM = { id: "r1", caller_id: "user-a", callee_id: ME, status: "ringing" };
check("دعوة موجّهة إليّ (callee_id = أنا) ⇒ رنين",
  shouldRingForInvite({ payload: { roomId: "r1", calleeId: ME, caller: { id: "user-a" } }, room: ROOM, roomChecked: true, meId: ME }).ring === true);
check("دعوة لمشرف عام ليس callee ⇒ لا رنين",
  shouldRingForInvite({ payload: { roomId: "r1", calleeId: "user-a", caller: { id: "user-a" } }, room: ROOM, roomChecked: true, meId: SUPER }).ring === false);
check("دعوة بتصريح calleeId مخالف ⇒ لا رنين",
  shouldRingForInvite({ payload: { roomId: "r1", calleeId: "user-b", caller: { id: "user-a" } }, room: null, roomChecked: false, meId: ME }).ring === false);
check("دعوة أرسلتها أنا (انعكاس) ⇒ لا رنين",
  shouldRingForInvite({ payload: { roomId: "r1", calleeId: ME, caller: { id: ME } }, room: ROOM, roomChecked: true, meId: ME }).reason === "self-invite");
check("غرفة غير موجودة في قاعدة البيانات ⇒ لا رنين",
  shouldRingForInvite({ payload: { roomId: "gone", caller: { id: "user-a" } }, room: null, roomChecked: true, meId: ME }).reason === "room-not-found");
check("غرفة انتهت حالتها (ليست ringing) ⇒ لا رنين",
  shouldRingForInvite({ payload: { roomId: "r1", calleeId: ME, caller: { id: "user-a" } }, room: { ...ROOM, status: "ended" }, roomChecked: true, meId: ME }).ring === false);
check("حتى مع تعذّر قراءة الغرفة: calleeId المخالف يُرفض",
  shouldRingForInvite({ payload: { roomId: "r1", calleeId: OTHER, caller: { id: "user-a" } }, room: null, roomChecked: false, meId: ME }).ring === false);
check("دعوة بلا معرّف غرفة ⇒ لا رنين",
  shouldRingForInvite({ payload: { calleeId: ME }, room: null, roomChecked: false, meId: ME }).ring === false);

/* ============================================================
 * (ب) فحص المصادر
 * ============================================================ */

const MIGRATIONS_DIR = path.join(ROOT, "sql/migrations");
const MIGRATION_FILES = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));
/** يزيل تعليقات SQL حتى لا تُحتسب «الممنوعات» المذكورة في التوثيق */
const stripSqlComments = (sql) => String(sql).replace(/--[^\n]*/g, " ");
const ALL_SQL = [SCHEMA, ...MIGRATION_FILES.map((f) => read(`sql/migrations/${f}`))]
  .map(stripSqlComments)
  .join("\n");
const SCHEMA_CODE = stripSqlComments(SCHEMA);

const { messageRecipient, callRecipient, callPartiesBelongToConversation, messagePreview } =
  await import("../supabase/functions/send-push/recipients.ts");
const { normalizePayload } = await import("../supabase/functions/send-push/webhook.ts");
const RECIPIENTS = read("supabase/functions/send-push/recipients.ts");
const WEBHOOK = read("supabase/functions/send-push/webhook.ts");

// أدوات فحص التعريفات (آخر تعريف يفوز في PostgreSQL)
const lastDef = (name) => SCHEMA.lastIndexOf(`create or replace function public.${name}(`);
const fnBlock = (name) => {
  const start = lastDef(name);
  if (start === -1) return "";
  const rest = SCHEMA.slice(start + 1);
  const next = rest.indexOf("\ncreate or replace function public.");
  return next === -1 ? SCHEMA.slice(start) : SCHEMA.slice(start, start + 1 + next);
};

// ① قاعدة البيانات: صفر مسار إشعارات داخلية
const LEGACY_FNS = [
  "push_call_edge", "trigger_send_push_notification", "push_probe", "push_probe_result",
  "push_gateway_check", "push_egress_check", "push_net_diagnostics", "push_path_verdict",
  "push_path_verdict_db", "push_delivery_url", "push_set_delivery_url", "push_mode",
  "push_set_mode", "push_recipient_allowed", "push_skip_note", "conversation_direct_recipient",
  "admin_recipient_ids", "notify_new_message", "notify_call_room", "notify_admins_new_profile",
  "push_diagnostics", "push_fire_probe", "push_await_probe", "push_probe_endpoint",
];
check("schema.sql لا يحوي تعريف أي دالة إشعارات قديمة",
  LEGACY_FNS.every((fn) => !new RegExp(`create (or replace )?function public\\.${fn}\\s*\\(`).test(SCHEMA)),
  LEGACY_FNS.filter((fn) => new RegExp(`create (or replace )?function public\\.${fn}\\s*\\(`).test(SCHEMA)).join(","));
check("schema.sql لا يطلب امتداد pg_net", !/create extension[^;]*pg_net/i.test(SCHEMA));
check("schema.sql لا يستدعي net.http_post", !/net\.http_post/.test(SCHEMA_CODE));
check("schema.sql لا يقرأ من Vault", !/vault\./i.test(SCHEMA_CODE) && !/from vault/i.test(SCHEMA_CODE));
check("schema.sql لا ينشئ تريگرات إشعارات",
  !/create trigger (on_message_inserted|on_call_room_notify|on_profile_created_notify_admins)/.test(SCHEMA));
check("لا create extension pg_net في أي ملف هجرة", !/create extension[^;]*pg_net/i.test(ALL_SQL));
check("لا net.http_post في أي ملف هجرة", !/net\.http_post/.test(ALL_SQL));
check("لا قراءة من Vault في أي ملف هجرة", !/vault\./i.test(ALL_SQL) && !/from vault/i.test(ALL_SQL));
check("هجرة v3.0 تلغي pg_net وتوثّق الـ Webhooks",
  /drop extension pg_net/.test(read("sql/migrations/2026-10-26_v3_0_database_webhooks_only.sql")) &&
  /Database Webhook/i.test(read("sql/migrations/2026-10-26_v3_0_database_webhooks_only.sql")));
check("سجل التسليم يُكتب من الدالة لا من تريگر (لا insert في SQL)",
  !/insert into public\.push_delivery_log/i.test(SCHEMA));

// ② قواعد الرسائل (recipients.ts)
const C = { id: "c1", user_id: "U1", admin_id: "A1" };
const MON = { id: "c2", user_id: "X1", admin_id: "A2" };
check("رسالة: user ⇒ admin (الطرف الآخر فقط)",
  messageRecipient(C, "U1").recipientId === "A1");
check("رسالة: admin ⇒ user",
  messageRecipient(C, "A1").recipientId === "U1");
check("رسالة: مرسل خارج الأطراف ⇒ مرفوض",
  messageRecipient(C, "Z9").allowed === false &&
    messageRecipient(C, "Z9").reason === "sender is not a conversation party");
check("رسالة: المشرف العام ليس طرفاً ⇒ تُوجَّه للعميل صاحب المحادثة",
  messageRecipient(MON, "S1", true).recipientId === "X1");
check("رسالة: محادثة غير موجودة ⇒ مرفوض",
  messageRecipient(null, "U1").allowed === false);
check("رسالة: معاينة المرفقات بلا محتوى",
  messagePreview({ attachment_type: "image" }) === "📷 صورة" &&
    messagePreview({ content: "نص" }) === "نص");

// ③ قواعد المكالمات (callee_id حصراً)
const NOW = Date.parse("2026-10-26T10:00:00Z");
const RINGING = {
  id: "r1", conversation_id: "c1", caller_id: "U1", callee_id: "A1",
  status: "ringing", started_at: "2026-10-26T09:59:30Z",
};
check("رنين: المستلم = callee_id حصراً",
  callRecipient("incoming_call", RINGING, NOW).recipientId === "A1");
check("رنين: لا رنين للمتصل نفسه",
  callRecipient("incoming_call", { ...RINGING, callee_id: "U1" }, NOW).allowed === false);
check("رنين: غرفة انتهت ⇒ لا إشعار",
  callRecipient("incoming_call", { ...RINGING, status: "ended" }, NOW).allowed === false);
check("رنين: نافذة الرنين دقيقتان",
  callRecipient("incoming_call", { ...RINGING, started_at: "2026-10-26T09:50:00Z" }, NOW).reason === "ring expired");
check("انتهاء المكالمة: يُرسل للـ callee من حالة نهائية",
  callRecipient("call_ended", { ...RINGING, status: "missed" }, NOW).recipientId === "A1");
check("انتهاء المكالمة: لا إشعار لحالة غير نهائية",
  callRecipient("call_ended", { ...RINGING, status: "active" }, NOW).allowed === false);
check("المكالمة: طرفا الغرفة يجب أن يكونا طرفي المحادثة",
  callPartiesBelongToConversation(C, "U1", "A1") === true &&
    callPartiesBelongToConversation(C, "U1", "Z9") === false);

// ④ تطبيع حمولة الـ Webhook
const msgEvent = normalizePayload({
  type: "INSERT", table: "messages", schema: "public",
  record: { id: "m1", conversation_id: "c1", sender_id: "U1", content: "hi" },
  old_record: null,
});
check("Webhook: messages INSERT ⇒ new_message",
  msgEvent.ok === true && msgEvent.event.kind === "new_message");
check("Webhook: بطاقة مكالمة داخل messages تُتجاهل",
  normalizePayload({ type: "INSERT", table: "messages", schema: "public",
    record: { id: "m2", message_type: "call", sender_id: "U1" } }).ok === false);
check("Webhook: messages UPDATE تُتجاهل",
  normalizePayload({ type: "UPDATE", table: "messages", schema: "public",
    record: { id: "m1" }, old_record: {} }).ok === false);
check("Webhook: call_rooms INSERT(ringing) ⇒ incoming_call",
  normalizePayload({ type: "INSERT", table: "call_rooms", schema: "public",
    record: { id: "r1", status: "ringing", caller_id: "U1", callee_id: "A1" } }).event.kind === "incoming_call");
check("Webhook: call_rooms UPDATE(ringing→missed) ⇒ call_ended",
  normalizePayload({ type: "UPDATE", table: "call_rooms", schema: "public",
    record: { id: "r1", status: "missed" }, old_record: { status: "ringing" } }).event.kind === "call_ended");
check("Webhook: call_rooms UPDATE(ringing→active) تُتجاهل",
  normalizePayload({ type: "UPDATE", table: "call_rooms", schema: "public",
    record: { id: "r1", status: "active" }, old_record: { status: "ringing" } }).ok === false);
check("Webhook: profiles INSERT ⇒ new_user",
  normalizePayload({ type: "INSERT", table: "profiles", schema: "public",
    record: { id: "p1", display_name: "سارة" } }).event.kind === "new_user");
check("Webhook: جدول غير مدعوم ⇒ خطأ صريح",
  normalizePayload({ type: "INSERT", table: "secrets", schema: "public", record: {} }).ok === false);
check("Webhook: مخطط غير public تُتجاهل",
  normalizePayload({ type: "INSERT", table: "messages", schema: "private", record: {} }).ok === false);
check("Webhook: الحمولة المسطّحة للاختبار اليدوي مدعومة",
  normalizePayload({ type: "new_message", message_id: "m9", conversation_id: "c1", sender_id: "U1" }).event.kind === "new_message");
check("webhook.ts نقي (بلا شبكة/قاعدة)", !/fetch\(|supabase|from\(/.test(WEBHOOK));
check("recipients.ts نقي (بلا شبكة/قاعدة)", !/fetch\(|supabase|from\(/.test(RECIPIENTS));

// ⑤ الإشعار الجماعي الوحيد = المستخدم الجديد
const newUserBlock = SEND_PUSH.slice(SEND_PUSH.indexOf("async function handleNewUser"));
const newUserFn = newUserBlock.slice(0, newUserBlock.indexOf("async function handleEvent"));
{
  const callSites = [...SEND_PUSH.matchAll(/await loadAdminIds\(\)/g)].map((m) => m.index);
  const newUserStart = SEND_PUSH.indexOf("async function handleNewUser");
  const newUserEnd = SEND_PUSH.indexOf("async function handleEvent");
  check("new_user يحمّل قائمة المشرفين فقط (الإشعار الجماعي الوحيد)",
    SEND_PUSH.includes("async function loadAdminIds") &&
      callSites.length === 1 &&
      callSites[0] > newUserStart && callSites[0] < newUserEnd,
    `callSites=${callSites.length}`);
}
check("new_user يستثني الحساب الجديد نفسه من البث",
  newUserFn.includes("filter((id) => id !== userId)"));
check("new_user لا يذكر رسالة/غرفة (فصل تام للمسارات)",
  !/room_id|message_id/.test(newUserFn));

// ⑦ سياسات RLS للمشرف العام (مراقبة كاملة بلا تنبيهات)
for (const policy of [
  "conversations read superadmin",
  "messages read superadmin",
  "call rooms read superadmin",
  "call logs superadmin",
  "call history hidden superadmin read",
]) {
  check(`سياسة RLS موجودة: ${policy}`, MIGRATION.includes(policy));
}
check("سياسة قراءة سجل التسليم موجودة في schema.sql (push log admin read)",
  SCHEMA.includes('create policy "push log admin read" on public.push_delivery_log'));
check("سياسات المشرف العام مقيّدة بـ is_super_admin_user (قراءة فقط)",
  /for select using \(public\.is_super_admin_user\(\)\)/.test(MIGRATION));
// v2.11: المشرف العام مراقب للقراءة فقط — لا سياسة كتابة ALL له
check("هجرة v2.9 بلا سياسة ALL للمشرف العام (الكتابة أُضيفت لاحقاً في v2.13)",
  !/for all using \(public\.is_super_admin_user\(\)\)/.test(MIGRATION));

// ⑧ send-push: نفس قواعد العزل من جهة الدالة
check("send-push يفوّض العزل إلى recipients.ts",
  SEND_PUSH.includes("messageRecipient(") && SEND_PUSH.includes("callRecipient(") &&
    SEND_PUSH.includes('from "./recipients.ts"'));
check("send-push يعالج أحداث الـ Webhook الثلاثة فقط",
  ["new_message", "incoming_call", "call_ended", "new_user"].every((k) => SEND_PUSH.includes(`"${k}"`)));
check("send-push لم يبق فيه أي مسار client_* (أُزيل في v3.0)", !/client_(message|call|new_user|probe)/.test(SEND_PUSH));
const SEND_PUSH_CODE = SEND_PUSH
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/(^|[^:])\/\/.*$/gm, "$1 ");
check("send-push لا يقرأ من Vault ولا يستخدم pg_net",
  !/net\.http_post|vault\.|from vault|create extension[^\n]*pg_net/i.test(SEND_PUSH_CODE));
check("send-push لا يعتمد على Worker وسيط", !/workers\.dev|PUSH_GATEWAY/.test(SEND_PUSH));
check("send-push يتطلب سرّ الـ Webhook", SEND_PUSH.includes("x-send-push-secret") && SEND_PUSH.includes("isWebhookAuthorized"));
check("send-push يسجّل كل حدث في push_delivery_log", SEND_PUSH.includes("push_delivery_log") && SEND_PUSH.includes("logDelivery"));
check("send-push يمنع تكرار نفس الحدث", SEND_PUSH.includes("isDuplicate(") && SEND_PUSH.includes("markSent("));
check("الواجهة لم تعد ترسل إشعارات (حُذف js/clientPush.js)",
  !fs.existsSync(path.join(ROOT, "js/clientPush.js")) && !/clientPush/.test(APP_JS));
check("تشخيص الواجهة يقرأ من دالة send-push",
  APP_JS.includes("getPushDiagnostics()") && !/rpc\("push_diagnostics"\)/.test(APP_JS));

// ⑪ التوثيق والاختبارات تعكس المعمارية الجديدة
const PKG = JSON.parse(read("package.json"));
const README = read("README.md");
check("npm test يشغّل اختبار التشغيل الفعلي للـ Webhook",
  /node tests\/send-push-runtime\.mjs/.test(PKG.scripts.test));
check("لا اختبارات Deno معلّقة على المعمارية القديمة",
  !fs.existsSync(path.join(ROOT, "tests/deno/send-push-runtime.test.ts")) &&
    !fs.existsSync(path.join(ROOT, "tests/deno/loop-guard-check.ts")));
check("README يوثّق إنشاء الـ Webhooks الثلاثة",
  /Database → Webhooks → Create a new hook/.test(README) &&
    README.includes("push_message") && README.includes("push_call") && README.includes("push_signup"));
check("README يوثّق ترويسة السرّ ورابط الدالة",
  README.includes("x-send-push-secret") && README.includes("/functions/v1/send-push"));
check("README لا يصف pg_net/Vault كمسار حالي",
  !/pg_net\.http_post|من قاعدة البيانات → pg_net → send-push|Vault يقرأ/.test(README));

// ⑨ الواجهة: نفس القاعدة قبل أي صوت/إشعار/رنين
check("app.js يستورد منطق العزل من وحدة العزل",
  /import \{ shouldAlertForMessage(, isConversationParty)? \} from "\.\/notification-scope\.js"/.test(APP_JS));
check("app.js يحفظ أطراف المحادثة (conversationParties)",
  APP_JS.includes("conversationParties: {}") && APP_JS.includes("function rememberConversationParties"));
check("قناة المراقبة العامة تتحقق قبل الصوت والإشعار",
  /const scope = shouldAlertForMessage\(\{[\s\S]{0,400}?if \(scope\.alert\) \{\s*\n\s*playNotificationSound\(\);\s*\n\s*void showLocalMessageNotification\(msg\);/.test(APP_JS));
check("قناة المحادثة المفتوحة تتحقق قبل الصوت",
  /const scope = shouldAlertForMessage\(\{[\s\S]{0,400}?if \(scope\.alert\) playNotificationSound\(\);/.test(APP_JS));
check("showLocalMessageNotification فيها بوابة عزل نهائية",
  /if \(!scope\.alert\) return;/.test(APP_JS));
check("app.js يصفّر أطراف المحادثات عند الخروج",
  APP_JS.includes("state.conversationParties = {}"));
check("calls.js يتحقق من الغرفة قبل الرنين",
  CALLS_JS.includes('safeQuery("calls:verify-invite"') && CALLS_JS.includes("shouldRingForInvite({ payload, room, roomChecked: ok, meId: me.id })"));
check("دعوة المكالمة تحمل calleeId صريحاً",
  /sendSignal\(peer\.id, "call:invite", \{[\s\S]{0,200}?calleeId: peer\.id,/.test(CALLS_JS));
// ⑩ وضع المراقبة للقراءة فقط (v2.9): اطلاع المراقب لا يغيّر حالة أصحاب المحادثة
const guardRe = (name) =>
  new RegExp(
    `create or replace function public\\.${name}\\(p_conversation_id uuid\\)[\\s\\S]{0,700}?c\\.user_id = auth\\.uid\\(\\) or c\\.admin_id = auth\\.uid\\(\\)`,
  );
check("الهجرة تُعيد تعريف mark_conversation_read بحراسة أطراف المحادثة", guardRe("mark_conversation_read").test(MIGRATION));
check("الهجرة تُعيد تعريف mark_messages_delivered بحراسة أطراف المحادثة", guardRe("mark_messages_delivered").test(MIGRATION));
check("آخر تعريف mark_conversation_read في schema.sql هو المحروس", guardRe("mark_conversation_read").test(fnBlock("mark_conversation_read")));
check("آخر تعريف mark_messages_delivered في schema.sql هو المحروس", guardRe("mark_messages_delivered").test(fnBlock("mark_messages_delivered")));
check("app.js يعرّف بوابة المراقب (isObserverOfConversation)",
  APP_JS.includes("function isObserverOfConversation"));
check("app.js يمنع القراءة والتسليم لمحادثة نراقبها (بوابتان قبل أي كتابة)",
  (APP_JS.match(/if \(isObserverOfConversation\(conversationId\)\) return false;/g) || []).length >= 2);

check("وحدة العزل نقية (بلا DOM/شبكة)",
  !/document\.|window\.|localStorage|fetch\(|supabase/.test(SCOPE_JS));

console.log(fails ? `\n❌ FAILED: ${fails}` : "\nALL ISOLATION CHECKS PASSED");
process.exit(fails ? 1 : 0);
