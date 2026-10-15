/**
 * Helpers for FCM HTTP v1 data payloads.
 *
 * FCM data messages have a strict byte-size limit. Message bodies are user
 * content and are not naturally bounded by the database, so a long UTF-8
 * message must be shortened before sending rather than silently rejecting the
 * whole push. We keep a safety margin below FCM's 4096-byte limit.
 */
export const MAX_FCM_DATA_BYTES = 3500;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const REQUIRED_ROUTE_FIELDS = new Set([
  "type",
  "messageId",
  "conversationId",
  "roomId",
  "userId",
]);
const PREFERRED_TRIM_FIELDS = [
  "body",
  "title",
  "icon",
  "email",
  "phone",
  "createdAt",
  "timestamp",
  "messageType",
];

function utf8ByteLength(value: string): number {
  return encoder.encode(value).length;
}

function dataByteLength(data: Record<string, string>): number {
  return Object.entries(data).reduce(
    (size, [key, value]) => size + utf8ByteLength(key) + utf8ByteLength(value),
    0,
  );
}

/** Returns a prefix that ends on a complete UTF-8 code point. */
function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = encoder.encode(value);
  const limit = Math.max(0, Math.floor(maxBytes));
  if (bytes.length <= limit) return value;

  let end = Math.min(limit, bytes.length);
  while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  return decoder.decode(bytes.subarray(0, end));
}

function shortenField(data: Record<string, string>, key: string, currentBytes: number): void {
  const value = data[key];
  if (value === undefined || !value) return;

  const overBy = dataByteLength(data) - MAX_FCM_DATA_BYTES;
  const ellipsisBytes = utf8ByteLength("…");
  const retainedBytes = Math.max(0, currentBytes - overBy - ellipsisBytes);
  const prefix = truncateUtf8(value, retainedBytes);
  data[key] = prefix === value ? prefix : `${prefix}…`;
}

/**
 * Makes an FCM data map safe for the 4 KB transport limit (including UTF-8).
 * Route identifiers and event type are preserved; user-facing text is clipped
 * at a code-point boundary. Returns a fresh object and never mutates input.
 */
export function fitFcmData(input: Record<string, string>): Record<string, string> {
  const data: Record<string, string> = {};
  for (const [key, value] of Object.entries(input || {})) {
    if (!key || value === undefined || value === null) continue;
    data[String(key)] = String(value);
  }

  let size = dataByteLength(data);
  if (size <= MAX_FCM_DATA_BYTES) return data;

  for (const key of PREFERRED_TRIM_FIELDS) {
    if (size <= MAX_FCM_DATA_BYTES) break;
    const value = data[key];
    if (value === undefined) continue;
    shortenField(data, key, utf8ByteLength(value));
    size = dataByteLength(data);
  }

  // Future payload fields may also contain user-supplied values. Keep known
  // routing fields, and remove optional metadata only if clipping text was not
  // enough to fit the transport limit.
  if (size > MAX_FCM_DATA_BYTES) {
    for (const key of Object.keys(data)) {
      if (size <= MAX_FCM_DATA_BYTES) break;
      if (REQUIRED_ROUTE_FIELDS.has(key)) continue;
      delete data[key];
      size = dataByteLength(data);
    }
  }

  if (size > MAX_FCM_DATA_BYTES) {
    throw new RangeError(`FCM route data exceeds ${MAX_FCM_DATA_BYTES} UTF-8 bytes`);
  }
  return data;
}
