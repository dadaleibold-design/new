/**
 * webhook.ts — تطبيع حمولة تريگر pg_net أو Supabase Webhook إلى حدث إشعار واضح
 * ==========================================================================
 * يدعم كلاً من:
 *
 * 1) الشكل القياسي المرسل من تريگر pg_net (handle_new_message_notification /
 *    notify_new_message / notify_call_room / notify_admins_new_profile) أو Webhook:
 *   {
 *     "type": "INSERT" | "UPDATE" | "DELETE" | "new_message" | "incoming_call" | "call_ended" | "new_user",
 *     "table": "messages" | "call_rooms" | "profiles",
 *     "schema": "public",
 *     "record": { ...الصف الجديد... },
 *     "old_record": { ...الصف القديم أو null... }
 *   }
 *
 * 2) الشكل المسطّح المبسط (تريگر pg_net البسيط أو الاختبار اليدوي):
 *   { "message_id": "...", "conversation_id": "...", "sender_id": "...", "content": "..." }
 *   أو مع حقل "type": "new_message" | "incoming_call" | "call_ended" | "new_user"
 *
 * هذه الوحدة **نقية** (بلا شبكة ولا قاعدة بيانات) لذلك تُختبر مباشرة في Node:
 *   node tests/notification-isolation.mjs
 */

/** جداول الإشعارات المعتمدة (ما عداها يُرفض بـ 400). */
export const WEBHOOK_TABLES = ["messages", "call_rooms", "profiles"] as const;
export type WebhookTable = (typeof WEBHOOK_TABLES)[number];

/** حالات انتهاء المكالمة التي تستدعي إشعار «انتهت المكالمة/فائتة». */
export const TERMINAL_CALL_STATUSES = [
  "missed",
  "ended",
  "declined",
  "failed",
  "network_lost",
] as const;

export type PushKind =
  | "new_message"
  | "incoming_call"
  | "call_ended"
  | "new_user";

export type PushEvent =
  | { kind: "new_message"; record: Record<string, any>; oldRecord?: null }
  | { kind: "incoming_call"; record: Record<string, any>; oldRecord?: null }
  | { kind: "call_ended"; record: Record<string, any>; oldRecord?: Record<string, any> | null }
  | { kind: "new_user"; record: Record<string, any>; oldRecord?: null };

export type NormalizedEvent =
  | { ok: true; event: PushEvent }
  | { ok: false; ignored: string }
  | { ok: false; error: string };

const FLAT_KIND_ALIASES: Record<string, PushKind> = {
  new_message: "new_message",
  incoming_call: "incoming_call",
  call_ended: "call_ended",
  new_user: "new_user",
};

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

/** هل الحمولة تحمل record + table (تريگر pg_net أو Database Webhook)؟ */
export function isWebhookPayload(input: unknown): boolean {
  return isObject(input) && isObject(input.record) && typeof input.table === "string";
}

/**
 * يحوّل أي حمولة مدعومة إلى حدث إشعار، أو يشرح سبب تجاهلها/رفضها.
 * القاعدة الذهبية: لا نثق بأي `recipient_id` قادم من الحمولة — يُشتقّ
 * المستلم دائماً من سجلّ المحادثة/الغرفة عبر recipients.ts.
 */
export function normalizePayload(input: unknown): NormalizedEvent {
  if (!isObject(input)) return { ok: false, error: "invalid payload: expected a JSON object" };

  // ① شكل تريگر pg_net / Database Webhook القياسي (يحوي table + record)
  if (isWebhookPayload(input)) {
    if (input.schema && input.schema !== "public") {
      return { ok: false, ignored: `schema ${str(input.schema)} is not public` };
    }
    const table = str(input.table) as WebhookTable;
    if (!WEBHOOK_TABLES.includes(table)) {
      return { ok: false, error: `unsupported table: ${table || "(missing)"}` };
    }
    const op = str(input.type).toUpperCase();
    const record = input.record as Record<string, any>;
    const oldRecord = isObject(input.old_record) ? input.old_record : null;

    if (table === "messages") {
      if (op && op !== "INSERT" && op !== "NEW_MESSAGE") {
        return { ok: false, ignored: `messages ${op || "?"}: notifications only on INSERT` };
      }
      if (str(record.message_type) === "call") {
        return { ok: false, ignored: "call card message: its room notification owns the push" };
      }
      return { ok: true, event: { kind: "new_message", record } };
    }

    if (table === "call_rooms") {
      if (op === "INSERT" || op === "INCOMING_CALL") {
        if (str(record.status) !== "ringing") {
          return { ok: false, ignored: `call room inserted with status ${str(record.status) || "?"}` };
        }
        return { ok: true, event: { kind: "incoming_call", record } };
      }
      if (op === "UPDATE" || op === "CALL_ENDED") {
        const next = str(record.status);
        const previous = oldRecord ? str(oldRecord.status) : "";
        if (oldRecord && next === previous) return { ok: false, ignored: "call status unchanged" };
        if (!TERMINAL_CALL_STATUSES.includes(next as any)) {
          return { ok: false, ignored: `call status ${next || "?"} is not terminal` };
        }
        return { ok: true, event: { kind: "call_ended", record, oldRecord } };
      }
      return { ok: false, ignored: `call_rooms ${op || "?"}: ignored` };
    }

    // profiles
    if (op && op !== "INSERT" && op !== "NEW_USER") {
      return { ok: false, ignored: `profiles ${op || "?"}: only INSERT notifies admins` };
    }
    return { ok: true, event: { kind: "new_user", record } };
  }

  // ② شكل مسطّح من تريگر pg_net البسيط أو الاختبار اليدوي:
  //    { message_id, conversation_id, sender_id, content } أو مع حقل type
  const rawType = str(input.type);
  const kind: PushKind | undefined = FLAT_KIND_ALIASES[rawType] ??
    (!rawType && (input.message_id || input.conversation_id) ? "new_message" : undefined);

  if (!kind) {
    return {
      ok: false,
      error: "unsupported payload: expected a database trigger or webhook body ({type, table, record} or {message_id, conversation_id, sender_id})",
    };
  }
  const { type: _type, record: _record, ...flat } = input as Record<string, any>;
  const normalizedRecord: Record<string, any> = {
    ...flat,
    id: flat.id || flat.message_id || flat.room_id || flat.user_id || "",
  };
  if (kind === "new_message" && str(normalizedRecord.message_type) === "call") {
    return { ok: false, ignored: "call card message: its room notification owns the push" };
  }
  return { ok: true, event: { kind, record: normalizedRecord } as PushEvent };
}

/** معرّف الحدث المرجعي (message_id / room_id / profile_id) — للتسجيل والتشخيص. */
export function eventRefId(event: PushEvent): string {
  const r = event.record || {};
  return str(r.id || r.message_id || r.room_id || r.user_id);
}

/** مفتاح منع التكرار: نفس الحدث قد يصل أكثر من مرة. */
export function dedupeKey(event: PushEvent): string {
  const id = eventRefId(event);
  return id ? `${event.kind}:${id}` : "";
}
