/**
 * webhook.ts — تطبيع حمولة Supabase Database Webhook إلى حدث إشعار واضح
 * ==========================================================================
 * Supabase ترسل هذا الشكل تلقائياً عند كل حدث مُعرَّف في لوحة التحكم:
 *
 *   {
 *     "type": "INSERT" | "UPDATE" | "DELETE",
 *     "table": "messages" | "call_rooms" | "profiles",
 *     "schema": "public",
 *     "record": { ...الصف الجديد... },
 *     "old_record": { ...الصف القديم أو null... }
 *   }
 *
 * هذه الوحدة **نقية** (بلا شبكة ولا قاعدة بيانات) لذلك تُختبر مباشرة في Node:
 *   node tests/notification-isolation.mjs
 *
 * كما تقبل — للاختبار اليدوي وcURL فقط — الشكل المسطّح القديم:
 *   { "type": "new_message", "message_id": "...", "conversation_id": "...", ... }
 * الذي يُغلَّف داخلياً إلى نفس الحدث. لا يوجد مسار عميل (client_*) بعد اليوم.
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

/** هل الحمولة حمولة Database Webhook القياسية؟ */
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

  // ① شكل Database Webhook القياسي
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
      if (op !== "INSERT") return { ok: false, ignored: `messages ${op || "?"}: notifications only on INSERT` };
      if (str(record.message_type) === "call") {
        return { ok: false, ignored: "call card message: its room notification owns the push" };
      }
      return { ok: true, event: { kind: "new_message", record } };
    }

    if (table === "call_rooms") {
      if (op === "INSERT") {
        if (str(record.status) !== "ringing") {
          return { ok: false, ignored: `call room inserted with status ${str(record.status) || "?"}` };
        }
        return { ok: true, event: { kind: "incoming_call", record } };
      }
      if (op === "UPDATE") {
        const next = str(record.status);
        const previous = oldRecord ? str(oldRecord.status) : "";
        if (next === previous) return { ok: false, ignored: "call status unchanged" };
        if (!TERMINAL_CALL_STATUSES.includes(next as any)) {
          return { ok: false, ignored: `call status ${next || "?"} is not terminal` };
        }
        return { ok: true, event: { kind: "call_ended", record, oldRecord } };
      }
      return { ok: false, ignored: `call_rooms ${op || "?"}: ignored` };
    }

    // profiles
    if (op !== "INSERT") return { ok: false, ignored: `profiles ${op || "?"}: only INSERT notifies admins` };
    return { ok: true, event: { kind: "new_user", record } };
  }

  // ② شكل مسطّح للاختبار اليدوي: { type: "new_message", message_id, ... }
  const kind = FLAT_KIND_ALIASES[str(input.type)];
  if (!kind) {
    return {
      ok: false,
      error: "unsupported payload: expected a Supabase Database Webhook body ({type, table, record})",
    };
  }
  const { type: _type, record: _record, ...flat } = input as Record<string, any>;
  return { ok: true, event: { kind, record: flat } as PushEvent };
}

/** معرّف الحدث المرجعي (message_id / room_id / profile_id) — للتسجيل والتشخيص. */
export function eventRefId(event: PushEvent): string {
  const r = event.record || {};
  if (event.kind === "new_message") return str(r.id);
  if (event.kind === "incoming_call" || event.kind === "call_ended") return str(r.id);
  return str(r.id);
}

/** مفتاح منع التكرار: نفس الحدث قد يصل أكثر من مرة (إعادة محاولة Webhook). */
export function dedupeKey(event: PushEvent): string {
  const id = eventRefId(event);
  return id ? `${event.kind}:${id}` : "";
}
