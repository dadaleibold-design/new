/**
 * webhook.ts — تطبيع حمولة تريغر pg_net / Database Webhook إلى PushEvent
 * ==========================================================================
 * العقد القياسي:
 *   { type, table, schema, record, old_record }
 *
 * يدعم أيضاً الحمولة المسطّحة القديمة للاختبار اليدوي. الوحدة نقية ولا تنفّذ
 * شبكة أو قاعدة بيانات؛ كل مدخل غير صالح يعيد سبباً بدلاً من رمي استثناء.
 */

export const WEBHOOK_TABLES = ["messages", "call_rooms", "profiles"] as const;
export type WebhookTable = (typeof WEBHOOK_TABLES)[number];

export const TERMINAL_CALL_STATUSES = [
  "missed",
  "ended",
  "declined",
  "failed",
  "network_lost",
] as const;

export type PushKind = "new_message" | "incoming_call" | "call_ended" | "new_user";

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

/** هل يحمل الجسم غلاف حدث قاعدة (حتى لو كان record=null في DELETE)؟ */
export function isWebhookPayload(input: unknown): boolean {
  return isObject(input) && typeof input.table === "string";
}

/**
 * يحوّل الحمولة إلى حدث، أو يعيد ignored للعمليات غير المعنية، أو error للعقد
 * غير الصالح. لا تُثق أي قيمة recipient_id؛ recipients.ts يشتق المستلم من DB.
 */
export function normalizePayload(input: unknown): NormalizedEvent {
  if (!isObject(input)) {
    return { ok: false, error: "invalid payload: expected a JSON object" };
  }

  // ① غلاف pg_net / Database Webhook القياسي.
  if (isWebhookPayload(input)) {
    if (input.schema !== undefined && input.schema !== null && input.schema !== "public") {
      return { ok: false, ignored: `schema ${str(input.schema)} is not public` };
    }

    const table = str(input.table) as WebhookTable;
    if (!WEBHOOK_TABLES.includes(table)) {
      return { ok: false, error: `unsupported table: ${table || "(missing)"}` };
    }

    const op = str(input.type).toUpperCase();

    // قرّر أولاً إن كانت العملية معنية؛ DELETE قد يحمل record=null بصورة صحيحة.
    if (table === "messages" && op && op !== "INSERT" && op !== "NEW_MESSAGE") {
      return { ok: false, ignored: `messages ${op}: notifications only on INSERT` };
    }
    if (table === "profiles" && op && op !== "INSERT" && op !== "NEW_USER") {
      return { ok: false, ignored: `profiles ${op}: only INSERT notifies admins` };
    }
    if (
      table === "call_rooms" && op &&
      op !== "INSERT" && op !== "UPDATE" && op !== "INCOMING_CALL" && op !== "CALL_ENDED"
    ) {
      return { ok: false, ignored: `call_rooms ${op}: ignored` };
    }

    if (!isObject(input.record)) {
      return {
        ok: false,
        error: `invalid ${table} ${op || "event"} payload: record must be a JSON object`,
      };
    }

    const record = input.record;
    const oldRecord = isObject(input.old_record) ? input.old_record : null;

    if (table === "messages") {
      if (str(record.message_type) === "call") {
        return { ok: false, ignored: "call card message: its room notification owns the push" };
      }
      return { ok: true, event: { kind: "new_message", record } };
    }

    if (table === "profiles") {
      return { ok: true, event: { kind: "new_user", record } };
    }

    // call_rooms
    if (op === "INSERT" || op === "INCOMING_CALL") {
      if (str(record.status) !== "ringing") {
        return { ok: false, ignored: `call room inserted with status ${str(record.status) || "?"}` };
      }
      return { ok: true, event: { kind: "incoming_call", record } };
    }

    // UPDATE / CALL_ENDED / (op فارغ للتوافق القديم يُعامل كتحديث فقط إن كانت الحالة نهائية)
    const next = str(record.status);
    const previous = oldRecord ? str(oldRecord.status) : "";
    if (oldRecord && next === previous) {
      return { ok: false, ignored: "call status unchanged" };
    }
    if (!TERMINAL_CALL_STATUSES.includes(next as any)) {
      return { ok: false, ignored: `call status ${next || "?"} is not terminal` };
    }
    return { ok: true, event: { kind: "call_ended", record, oldRecord } };
  }

  // ② الحمولة المسطّحة القديمة أو {type: new_message, record: {...}}.
  const rawType = str(input.type);
  const kind: PushKind | undefined = FLAT_KIND_ALIASES[rawType] ??
    (!rawType && (input.message_id || input.conversation_id) ? "new_message" : undefined);

  if (!kind) {
    return {
      ok: false,
      error: "unsupported payload: expected {type, table, schema, record, old_record} or a supported flat push event",
    };
  }

  const {
    type: _type,
    record: _record,
    old_record: _oldRecord,
    table: _table,
    schema: _schema,
    ...flat
  } = input;
  const source = isObject(input.record) ? input.record : flat;
  const normalizedRecord: Record<string, any> = {
    ...source,
    id: source.id || source.message_id || source.room_id || source.user_id || "",
  };

  if (kind === "new_message" && str(normalizedRecord.message_type) === "call") {
    return { ok: false, ignored: "call card message: its room notification owns the push" };
  }

  return { ok: true, event: { kind, record: normalizedRecord } as PushEvent };
}

export function eventRefId(event: PushEvent): string {
  const r = event.record || {};
  return str(r.id || r.message_id || r.room_id || r.user_id);
}

export function dedupeKey(event: PushEvent): string {
  const id = eventRefId(event);
  return id ? `${event.kind}:${id}` : "";
}
