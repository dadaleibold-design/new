/**
 * js/clientPush.js — إرسال الإشعارات من جهة العميل (Supabase Realtime → Edge Function)
 * ============================================================================
 * لماذا هذا الملف:
 *   حاوية قاعدة البيانات في هذا المشروع **معزولة شبكياً بالكامل** — `pg_net`
 *   لا يستطيع حتى تحليل أسماء المضيفات ("Couldn't resolve host name") ⇒ لا
 *   يمكن للقاعدة أن ترسل إشعاراً. البديل: المتصفح نفسه.
 *
 * المسار الجديد:
 *   INSERT في messages ──Realtime──► متصفح المرسل ──fetch──► Edge Function send-push
 *        ──FCM HTTP v1──► جهاز المستلِم ──Service Worker──► إشعار (التطبيق مغلق أو لا)
 *
 * الأمان:
 *   • لا سرّ مشترك في المتصفح إطلاقاً — المصادقة برمز المستخدم (JWT) من الجلسة.
 *   • الدالة على الخادم تُثبّت المُرسِل من الرمز (لا يُقبل sender_id من العميل)
 *     وتُشتقّ المستلَم من المحادثة ⇒ لا يمكن إرسال إشعار بالنيابة عن غيرك.
 *   • منع التكرار: قد يطلب أكثر من جهاز من أجهزة المرسل الإرسال نفسه ⇒
 *     الدالة (send-push) تتجاهل الرسالة المكرّرة.
 *
 * ملاحظة: يعمل هذا المسار عندما يكون تطبيق المرسل مفتوحاً (أو في الخلفية على
 * الجهاز). إن كان المرسل مغلقاً تماماً فلا يوجد من يطلق الإشعار — وهذا فرق
 * جوهري عن مسار القاعدة (الذي لا يعمل في هذا المشروع أصلاً).
 */

import { supabase } from "./supabaseClient.js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

/** رابط دالة send-push (نفسه الذي تستخدمه القاعدة) */
export const SEND_PUSH_FN_URL = `${SUPABASE_URL}/functions/v1/send-push`;

/** آخر خطأ من محاولة إرسال (للتشخيص) */
let lastError = null;
export function getClientPushLastError() {
  return lastError;
}

/**
 * نداء عام لدالة send-push بمصادقة رمز المستخدم.
 * @param {object} payload جسم الطلب (type: client_*)
 */
export async function sendClientPush(payload) {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  if (!token) throw new Error("سجّل الدخول أولاً.");
  const res = await fetch(SEND_PUSH_FN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = json?.error || json?.message || "";
    lastError = `HTTP ${res.status}${detail ? " — " + detail : ""}`;
    throw new Error(lastError);
  }
  lastError = null;
  return json;
}

/** إشعار رسالة جديدة — يطلقه جهاز المرسل (المستلَم يُشتقّ على الخادم) */
export function clientPushMessage({ messageId, conversationId, content, messageType }) {
  if (!messageId) return Promise.resolve({ skipped: "no message id" });
  return sendClientPush({
    type: "client_message",
    message_id: messageId,
    conversation_id: conversationId || "",
    content: content || "",
    message_type: messageType || "text",
  });
}

/** إشعار مكالمة واردة — يطلقه جهاز المتصل (المستلَم = callee من الغرفة) */
export function clientPushCall({ roomId, callType }) {
  if (!roomId) return Promise.resolve({ skipped: "no room id" });
  return sendClientPush({
    type: "client_call",
    room_id: roomId,
    call_type: callType || "audio",
  });
}

/** إشعار «مستخدم جديد» للمشرفين — يطلقه جهاز مشرف (الدالة تتحقّق من الصلاحية) */
export function clientPushNewUser({ userId, displayName }) {
  if (!userId) return Promise.resolve({ skipped: "no user id" });
  return sendClientPush({
    type: "client_new_user",
    user_id: userId,
    display_name: displayName || "",
  });
}

/**
 * فحص الاتصال من المتصفح إلى دالة send-push (بلا إشعار وبلا أثر).
 * يُستخدم في تقرير التشخيص: يثبت أن المتصفح نفسه يصل إلى الدالة.
 */
export async function clientPushProbe() {
  return sendClientPush({ type: "client_probe" });
}
