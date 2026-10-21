/**
 * recipients.ts — قواعد عزل المستلمين (المصدر الوحيد للحقيقة)
 * ==========================================================================
 * هذه الوحدة تحلّ محل دوال قاعدة البيانات القديمة:
 *   push_recipient_allowed / push_skip_note / conversation_direct_recipient
 * لأن قاعدة البيانات لم تعد تُرسل إشعارات (لا pg_net)، وأصبح الحسم هنا قبل
 * أي طلب إلى FCM. الوحدة **نقية** (بلا شبكة) لتُختبر في Node مباشرة:
 *   node tests/notification-isolation.mjs
 *
 * القواعد:
 *   new_message   ⇒ الطرف الآخر في نفس صف المحادثة حصراً
 *                   (المشرف العام الذي يردّ في محادثة ليس طرفاً فيها ⇒ العميل)
 *                   المرسل ليس طرفاً ⇒ لا إشعار إطلاقاً.
 *   incoming_call ⇒ callee_id في غرفة المكالمة نفسها حصراً
 *                   (ولا رنين بعد انتهاء نافذة الرنين).
 *   call_ended    ⇒ callee_id نفسه، فقط من حالة انتهاء معروفة.
 *   new_user      ⇒ بث للمشرفين فقط (إشعار جماعي وحيد).
 */

export type ConversationRow = {
  id?: string | null;
  user_id?: string | null;
  admin_id?: string | null;
};

export type CallRoomRow = {
  id?: string | null;
  conversation_id?: string | null;
  caller_id?: string | null;
  callee_id?: string | null;
  status?: string | null;
  call_type?: string | null;
  started_at?: string | null;
};

export type Decision =
  | { allowed: true; recipientId: string }
  | { allowed: false; reason: string };

/** أقصى عمر لرنين قابل للإشعار (نفس حدّ الواجهة: دقيقتان). */
export const CALL_RING_MAX_AGE_MS = 2 * 60 * 1000;

const TERMINAL_CALL_STATUSES = ["missed", "ended", "declined", "failed", "network_lost"];

function s(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

/**
 * مستلم إشعار رسالة جديدة.
 * @param conversation صف المحادثة (user_id/admin_id)
 * @param senderId مُرسل الرسالة (من سجلّ الرسالة نفسه، لا من الحمولة الخارجية)
 * @param senderIsSuperAdmin مشرف عام؟ يسمح بمخاطبة العميل حتى لو لم يكن طرفاً
 */
export function messageRecipient(
  conversation: ConversationRow | null | undefined,
  senderId: string,
  senderIsSuperAdmin = false,
): Decision {
  if (!conversation) return { allowed: false, reason: "conversation not found" };
  const sender = s(senderId);
  if (!sender) return { allowed: false, reason: "sender_id missing" };

  const userId = s(conversation.user_id);
  const adminId = s(conversation.admin_id);

  let recipient = "";
  if (userId && userId === sender) recipient = adminId;
  else if (adminId && adminId === sender) recipient = userId;
  else if (senderIsSuperAdmin) recipient = userId; // ردّ المشرف العام ⇒ العميل
  else return { allowed: false, reason: "sender is not a conversation party" };

  if (!recipient) return { allowed: false, reason: "no direct counterpart in conversation" };
  if (recipient === sender) return { allowed: false, reason: "sender is the recipient" };
  return { allowed: true, recipientId: recipient };
}

/** هل طرفا المكالمة هما فعلاً طرفا المحادثة نفسها؟ (منع مكالمات بين غرباء) */
export function callPartiesBelongToConversation(
  conversation: ConversationRow | null | undefined,
  callerId: string,
  calleeId: string,
): boolean {
  if (!conversation) return false;
  const parties = [s(conversation.user_id), s(conversation.admin_id)].filter(Boolean);
  return parties.includes(s(callerId)) && parties.includes(s(calleeId));
}

/**
 * مستلم إشعار مكالمة (رنين أو انتهاء).
 * @param kind "incoming_call" | "call_ended"
 * @param room صف غرفة المكالمة
 * @param nowMs ساعة الاختبار (افتراضياً Date.now())
 */
export function callRecipient(
  kind: "incoming_call" | "call_ended",
  room: CallRoomRow | null | undefined,
  nowMs = Date.now(),
): Decision {
  if (!room) return { allowed: false, reason: "call room not found" };
  const caller = s(room.caller_id);
  const callee = s(room.callee_id);
  if (!callee) return { allowed: false, reason: "callee_id missing" };
  if (callee === caller) return { allowed: false, reason: "callee is the caller" };

  const status = s(room.status);

  if (kind === "incoming_call") {
    if (status !== "ringing") return { allowed: false, reason: `call not ringing (${status || "?"})` };
    const started = room.started_at ? Date.parse(s(room.started_at)) : NaN;
    if (!Number.isFinite(started)) return { allowed: false, reason: "call started_at missing" };
    if (nowMs - started > CALL_RING_MAX_AGE_MS) return { allowed: false, reason: "ring expired" };
  } else {
    if (!TERMINAL_CALL_STATUSES.includes(status)) {
      return { allowed: false, reason: `call status ${status || "?"} is not terminal` };
    }
  }

  return { allowed: true, recipientId: callee };
}

/** نص معاينة الرسالة عند غياب المحتوى (مرفق/بطاقة). */
export function messagePreview(record: Record<string, any>): string {
  const content = s(record.content);
  if (content) return content;
  const attachment = s(record.attachment_type);
  if (attachment === "image") return "📷 صورة";
  if (attachment === "audio") return "🎤 رسالة صوتية";
  if (attachment === "video") return "🎬 فيديو";
  if (attachment === "file") return "📎 ملف";
  return "📎 مرفق";
}
