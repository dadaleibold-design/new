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

// ① ملف الهجرة = قسم 17 في schema.sql (لا انحراف)
const marker = "-- ============================================================\n-- ① ";
const migBody = MIGRATION.slice(MIGRATION.indexOf(marker)).trimEnd();
const schemaBody = SCHEMA.slice(SCHEMA.indexOf(marker)).trimEnd();
check("schema.sql §17 = ملف الهجرة v2.9 حرفياً", migBody === schemaBody);

// ② آخر تعريف فعّال في schema.sql هو المشدّد (الترتيب مهم: last definition wins)
const lastIndexOf = (src, needle) => src.lastIndexOf(needle);
const lastDef = (name) => lastIndexOf(SCHEMA, `create or replace function public.${name}(`);
// نص آخر تعريف للدالة وحده (حتى التعريف التالي) — لا يشمل بقية الملف
const fnBlock = (name) => {
  const start = lastDef(name);
  const rest = SCHEMA.slice(start + 1);
  const next = rest.indexOf("\ncreate or replace function public.");
  return next === -1 ? SCHEMA.slice(start) : SCHEMA.slice(start, start + 1 + next);
};
check("آخر تعريف push_call_edge في schema.sql هو المشدّد (فيه بوابة العزل)",
  lastIndexOf(SCHEMA, "public.push_recipient_allowed(p_kind, p_ref, p_recipient, p_body)") > lastDef("push_call_edge"));
check("آخر تعريف notify_new_message هو المشدّد",
  lastDef("notify_new_message") > lastIndexOf(SCHEMA, "-- (أ) ---") && SCHEMA.slice(lastDef("notify_new_message")).includes("المرسل ليس طرفاً في المحادثة"));
check("آخر تعريف notify_call_room هو المشدّد (callee_id حصراً)",
  SCHEMA.slice(lastDef("notify_call_room"), lastDef("notify_call_room") + 1200).includes("v_recipient := new.callee_id"));
check("آخر تعريف push_diagnostics يحمل مؤشرات v2.9",
  fnBlock("push_diagnostics").includes("'isolation_version', 'v2.9'"));

// ③ المستلم المحدَّد حصرياً من أطراف المحادثة في دالة الرسائل
const notifyMessage = fnBlock("notify_new_message");
check("notify_new_message يقرأ user_id/admin_id من المحادثة",
  /select c\.user_id, c\.admin_id into v_user, v_admin/.test(notifyMessage));
check("notify_new_message لا يستعمل أي بديل خارج أطراف المحادثة",
  !/then c\.admin_id else c\.user_id end/.test(notifyMessage) && !notifyMessage.includes("admin_recipient_ids"));

// ④ المكالمات: callee_id فقط + لا بث لأي مشرف
const notifyCall = fnBlock("notify_call_room");
check("notify_call_room يستهدف callee_id فقط",
  /v_recipient := new\.callee_id/.test(notifyCall) && !notifyCall.includes("admin_recipient_ids"));
check("notify_call_room يرفض callee_id الفارغ أو المساوي للمتصل",
  /v_recipient is null or v_recipient = new\.caller_id/.test(notifyCall));
check("notify_call_room يتحقق أن طرفي المكالمة هما طرفا المحادثة",
  /c\.user_id = new\.caller_id or c\.admin_id = new\.caller_id/.test(notifyCall));

// ⑤ البوابة المركزية
check("البوابة المركزية تمنع new_user بمستلم فردي",
  /if p_kind = 'new_user' then\s*\n\s*return p_recipient is null;/.test(MIGRATION));
check("البوابة المركزية لا تسمح بمكالمة لغير callee",
  /r\.callee_id = p_recipient/.test(MIGRATION));
check("البوابة تمنح الاستثناء الوحيد: المشرف العام طرفاً مباشراً",
  /c\.user_id = v_sender and c\.admin_id = p_recipient/.test(MIGRATION));
check("push_call_edge يستدعي البوابة قبل أي طلب شبكة",
  MIGRATION.indexOf("push_recipient_allowed(p_kind, p_ref, p_recipient, p_body)") <
    MIGRATION.indexOf("net.http_post(url := v_url"));

// ⑥ الإشعار الجماعي الوحيد = المستخدم الجديد
const newUserCalls = [...MIGRATION.matchAll(/push_call_edge\(\s*'new_user'/g)].length;
check("نداء new_user واحد فقط (في دالة المستخدم الجديد)", newUserCalls === 1, `count=${newUserCalls}`);
const notifyAdmins = fnBlock("notify_admins_new_profile");
check("دالة المستخدم الجديد تستخدم push_call_edge('new_user', ..., null, ...)",
  /push_call_edge\(\s*'new_user',\s*\n\s*new\.id,\s*\n\s*null,/.test(notifyAdmins));
check("دالة المستخدم الجديد تحمل وسم admin_broadcast",
  notifyAdmins.includes("'category', 'admin_broadcast'"));
check("دالة المستخدم الجديد لا ترسل أي معرّف مكالمة/رسالة",
  !/room_id|message_id|conversation_id/.test(notifyAdmins));
check("دالة المستخدم الجديد تبقى مقصورة على INSERT في profiles",
  SCHEMA.slice(SCHEMA.indexOf("after insert on public.profiles")).includes("on_profile_created_notify_admins"));
check("لا يتقاطع منطق التوزيع: دالتا الرسائل والمكالمات لا تستدعيان قائمة المشرفين",
  !notifyMessage.includes("admin_recipient_ids") && !notifyCall.includes("admin_recipient_ids"));

// ⑦ سياسات RLS للمشرف العام (مراقبة كاملة بلا تنبيهات)
for (const policy of [
  "conversations read superadmin",
  "messages read superadmin",
  "call rooms read superadmin",
  "call logs superadmin",
  "push log superadmin read",
  "call history hidden superadmin read",
]) {
  check(`سياسة RLS موجودة: ${policy}`, MIGRATION.includes(policy));
}
check("سياسات المشرف العام مقيّدة بـ is_super_admin_user (قراءة فقط)",
  /for select using \(public\.is_super_admin_user\(\)\)/.test(MIGRATION));
// v2.11: المشرف العام مراقب للقراءة فقط — لا سياسة كتابة ALL له
check("لا سياسة ALL للمشرف العام (v2.11: قراءة فقط)",
  !/for all using \(public\.is_super_admin_user\(\)\)/.test(MIGRATION));

// ⑧ send-push: نفس قواعد العزل من جهة الدالة
check("send-push يعزل مستلم الرسالة عبر conversationCounterpart",
  SEND_PUSH.includes("function conversationCounterpart") && SEND_PUSH.includes("conversationCounterpart(conversation, senderId)"));
check("send-push يرفض المرسل غير الطرف (sender is not a conversation party)",
  SEND_PUSH.includes('refuse("sender is not a conversation party")'));
check("send-push يقرأ غرفة المكالمة من قاعدة البيانات (مصدر الحقيقة)",
  SEND_PUSH.includes('.from("call_rooms")') && SEND_PUSH.includes('.select("id, caller_id, callee_id, status")'));
check("send-push يرفض أي تعارض في callee (callee mismatch)",
  SEND_PUSH.includes('refuse("callee mismatch", 409)'));
check("send-push يرسل الرنين إلى callee_id المقروء من الغرفة",
  SEND_PUSH.includes("loadDeviceTokens(recipientId)") && SEND_PUSH.includes("const recipientId = String(room.callee_id"));
check("send-push لا يعتمد على صيغة الحمولة القديمة (ternary مباشر)",
  !/conversation\.user_id === senderId \? conversation\.admin_id : conversation\.user_id/.test(SEND_PUSH));
check("send-push يحتفظ بالإشعار الجماعي للمشرفين (new_user)",
  SEND_PUSH.includes('if (input.type === "new_user")') && SEND_PUSH.includes("loadDeviceTokensForUsers"));

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
