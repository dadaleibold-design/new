/**
 * js/notification-scope.js
 * منطق نقي (بلا DOM ولا شبكة) يحدّد من يستحق التنبيه فعلاً — قابل للاختبار في Node.
 *
 * القاعدة الحاكمة (v2.9):
 *   لا إشعار صوتي/مرئي ولا رنين إلا للطرف المباشر في الحدث:
 *     • رسالة  ⇒ المرسل أو المستلم في نفس صف المحادثة (user_id ⇄ admin_id).
 *     • مكالمة ⇒ callee_id المُعلن في غرفة المكالمة (المتصل لا يُنبَّه بالرنين).
 *
 * هذا المنطق مكمّل لقواعد قاعدة البيانات (Trigger + send-push)، وليس بديلاً عنها:
 * حتى لو وصل حدث Realtime أو push بالخطأ إلى جهاز لا يخصّه، لا يُصدر الجهاز
 * صوتاً ولا إشعاراً — وهذا هو «الوضع الصامت» للمشرف العام في وضع المراقبة.
 */

/** هل المستخدم طرف مباشر في المحادثة (user_id أو admin_id)؟ */
export function isConversationParty(conversation, userId) {
  if (!conversation || !userId) return false;
  return conversation.user_id === userId || conversation.admin_id === userId;
}

/** الطرف الآخر في المحادثة — أو null إن لم يكن المرسل أحد طرفيها */
export function conversationCounterpart(conversation, senderId) {
  if (!conversation || !senderId) return null;
  if (conversation.user_id === senderId) return conversation.admin_id || null;
  if (conversation.admin_id === senderId) return conversation.user_id || null;
  return null;
}

/**
 * قرار التنبيه برسالة واردة (Realtime أو FCM في المقدمة).
 *
 * @param {object}  args
 * @param {object}  args.message       صف الرسالة (sender_id / message_type مطلوبان)
 * @param {object} [args.conversation] صف المحادثة (user_id + admin_id) إن كان معروفاً
 * @param {string}  args.meId          معرّف المستخدم الحالي
 * @param {boolean}[args.isSuperAdmin] هل المستخدم مشرف عام؟ (وضع المراقبة)
 * @returns {{ alert: boolean, reason: string }}
 */
export function shouldAlertForMessage({ message, conversation, meId, isSuperAdmin = false } = {}) {
  if (!message || !meId) return { alert: false, reason: "no-message" };

  // رسائلي أنا (من جهاز آخر) ⇒ مزامنة صامتة بلا أي تنبيه
  if (message.sender_id === meId) return { alert: false, reason: "own-message" };

  // بطاقة مكالمة داخل المحادثة: إشعارها يأتي من مسار المكالمات حصراً
  if (message.message_type === "call") return { alert: false, reason: "call-card" };

  if (conversation) {
    if (!isConversationParty(conversation, meId)) {
      // مراقبة/مشاهدة (المشرف العام): تُحدَّث القائمة بلا صوت ولا إشعار
      return { alert: false, reason: "observer-silent" };
    }
    return { alert: true, reason: "direct-party" };
  }

  // محادثة غير معروفة محلياً: قائمة المشرف العام تضم كل المحادثات، فغيابها يعني
  // أنها ليست محادثة يخصّه ⇒ صمت. أما المستخدم العادي فـ RLS تضمن أن وارده له.
  if (isSuperAdmin) return { alert: false, reason: "observer-unknown-conversation" };
  return { alert: true, reason: "unverified-conversation" };
}

/**
 * قرار رنين المكالمة الواردة: لا يرن إلا الجهاز الذي هو callee_id فعلاً.
 *
 * @param {object}  args
 * @param {object}  args.payload    دعوة المكالمة (Realtime Broadcast)
 * @param {object} [args.room]      صف الغرفة من call_rooms إن تمّت قراءته
 * @param {boolean}[args.roomChecked] هل قرأنا الغرفة فعلاً؟ (يفرّق بين «غير موجودة» و«لم نقرأ»)
 * @param {string}  args.meId       معرّف المستخدم الحالي
 * @returns {{ ring: boolean, reason: string }}
 */
export function shouldRingForInvite({ payload, room, roomChecked = false, meId } = {}) {
  if (!payload?.roomId || !meId) return { ring: false, reason: "malformed-invite" };

  // دعوة أرسلتها أنا (انعكاس/تسريب) ⇒ لا رنين
  if (payload.caller?.id && payload.caller.id === meId) return { ring: false, reason: "self-invite" };

  // غرفة غير موجودة في قاعدة البيانات ⇒ دعوة مُلفَّقة أو ملغاة
  if (roomChecked && !room) return { ring: false, reason: "room-not-found" };

  // المستهدف المعلن في الدعوة أو في الغرفة — أي اختلاف عن هذا الجهاز ⇒ صمت
  const expectedCallee = payload.calleeId || payload.callee_id || room?.callee_id || null;
  if (expectedCallee && expectedCallee !== meId) return { ring: false, reason: "not-callee" };

  if (room) {
    if (room.callee_id && room.callee_id !== meId) return { ring: false, reason: "room-callee-mismatch" };
    if (room.caller_id && room.caller_id === meId) return { ring: false, reason: "self-invite" };
    if (room.status && room.status !== "ringing") return { ring: false, reason: "call-not-ringing" };
  }

  return { ring: true, reason: expectedCallee === meId ? "callee-confirmed" : "channel-targeted" };
}
