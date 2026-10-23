/**
 * send-push — Edge Function لإرسال إشعارات FCM في الخلفية
 * ============================================================================
 * المسار الوحيد (تريگرات قاعدة البيانات + pg_net):
 *
 *   INSERT/UPDATE على messages / call_rooms / profiles
 *        │
 *        ▼  Canonical Database Triggers
 *   net.http_post → POST /functions/v1/send-push
 *        │  Content-Type: application/json
 *        │  x-send-push-secret: <نفس SEND_PUSH_SECRET>
 *        ▼  هذه الدالة: تُحقّق، تُطبّع الحمولة، تُحدّد المستلم، تُرسل
 *   FCM HTTP v1 ──► firebase-messaging-sw.js ──► إشعار النظام
 *
 * المصادقة:
 *   • أحداث القاعدة: ترويسة x-send-push-secret فقط، ويجب أن تطابق
 *     SEND_PUSH_SECRET. لا يوجد سرّ افتراضي أو تجاوز عند غياب الإعداد.
 *   • يحتفظ SQL بنسخة التريغر في Vault بالاسم send_push_secret؛ لا سرّ في Git.
 *   • الاختبار اليدوي والتشخيص: رمز مستخدم (JWT) في Authorization.
 *   • verify_jwt=false على مستوى الدالة حتى لا ترفض البوابة طلب pg_net قبل وصوله.
 *
 * متغيرات البيئة (Supabase → Edge Functions → Secrets):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (يوفّرها Supabase تلقائياً)
 *   SEND_PUSH_SECRET                        (إلزامي — 32+ حرفاً، بلا قيمة افتراضية)
 *   FIREBASE_SERVICE_ACCOUNT                (JSON حساب الخدمة — مفضّل)
 *     أو: FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY
 *   PUSH_NORMAL_URGENCY=1                   (اختياري: أولوية عادية لرسائل الدردشة)
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

import { fitFcmData } from "./payload.ts";
import {
  callPartiesBelongToConversation,
  callRecipient,
  messagePreview,
  messageRecipient,
} from "./recipients.ts";
import {
  dedupeKey,
  eventRefId,
  normalizePayload,
  type PushEvent,
} from "./webhook.ts";

/* ══════════════════════════════════════════════════════════════════════════
 * 0) البيئة والإعدادات
 * ══════════════════════════════════════════════════════════════════════════ */

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const SEND_PUSH_SECRET = (Deno.env.get("SEND_PUSH_SECRET") ?? "").trim();
const PUSH_NORMAL_URGENCY = Deno.env.get("PUSH_NORMAL_URGENCY") === "1";
const SERVICE_VERSION = "3.1.0";

const FIREBASE_SERVICE_ACCOUNT = Deno.env.get("FIREBASE_SERVICE_ACCOUNT") ?? "";
let FIREBASE_PROJECT_ID = Deno.env.get("FIREBASE_PROJECT_ID") ?? "";
let FIREBASE_CLIENT_EMAIL = Deno.env.get("FIREBASE_CLIENT_EMAIL") ?? "";
let FIREBASE_PRIVATE_KEY = (Deno.env.get("FIREBASE_PRIVATE_KEY") ?? "").replace(/\\n/g, "\n");

if (FIREBASE_SERVICE_ACCOUNT) {
  try {
    const sa = JSON.parse(FIREBASE_SERVICE_ACCOUNT);
    FIREBASE_PROJECT_ID = FIREBASE_PROJECT_ID || sa.project_id || "";
    FIREBASE_CLIENT_EMAIL = FIREBASE_CLIENT_EMAIL || sa.client_email || "";
    FIREBASE_PRIVATE_KEY = FIREBASE_PRIVATE_KEY || (sa.private_key || "").replace(/\\n/g, "\n");
  } catch (error) {
    console.error("[send-push] FIREBASE_SERVICE_ACCOUNT is not valid JSON", error);
  }
}

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
}

const firebaseConfigured = Boolean(
  FIREBASE_PROJECT_ID && FIREBASE_CLIENT_EMAIL && FIREBASE_PRIVATE_KEY,
);

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const FCM_CONCURRENCY = 10;
const DEDUPE_TTL_MS = 60 * 1000;
const CALL_TTL_SECONDS = 60;
const MESSAGE_TTL_SECONDS = 86_400;

/* ══════════════════════════════════════════════════════════════════════════
 * 1) أدوات عامة
 * ══════════════════════════════════════════════════════════════════════════ */

function json(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      ...extraHeaders,
    },
  });
}

function methodNotAllowed(method: string): Response {
  // GET لا يمكن أن يكون طلب إشعار صالحاً. 405 + Allow يفرّق بوضوح بين
  // طلب وصل إلى الدالة وبين 401 الصادر من بوابة Supabase قبل الدالة.
  console.warn(`[send-push] rejected method=${method}; expected POST`);
  return json({ error: "Method not allowed: use POST" }, 405, { Allow: "POST, OPTIONS" });
}

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function skipped(kind: string, reason: string, status = 200): Response {
  console.warn(`[send-push] ${kind} skipped: ${reason}`);
  return json({ ok: true, kind, sent: 0, total: 0, skipped: reason }, status);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 2) منع التكرار (إعادة محاولات الـ Webhook + عدة أجهزة)
 * ══════════════════════════════════════════════════════════════════════════ */

const _seen = new Map<string, number>();

function isDuplicate(key: string): boolean {
  if (!key) return false;
  const now = Date.now();
  for (const [k, at] of _seen) if (now - at > DEDUPE_TTL_MS) _seen.delete(k);
  return _seen.has(key);
}

function markSent(key: string): void {
  if (key) _seen.set(key, Date.now());
}

/* ══════════════════════════════════════════════════════════════════════════
 * 3) مصادقة الطلب
 * ══════════════════════════════════════════════════════════════════════════ */

function isWebhookAuthorized(req: Request): boolean {
  if (SEND_PUSH_SECRET.length < 32) return false;
  const supplied = (req.headers.get("x-send-push-secret") ?? "").trim();
  // مسار أحداث القاعدة يقبل هذه الترويسة فقط. لا Bearer بديل، ولا service_role
  // بديل، ولا سرّ مدمج، ولا fail-open عندما يكون الإعداد ناقصاً.
  return supplied.length > 0 && supplied === SEND_PUSH_SECRET;
}

async function authenticatedUserId(req: Request): Promise<string | null> {
  const header = req.headers.get("authorization") ?? "";
  const token = header.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user?.id) return null;
  return String(data.user.id);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 4) Firebase: OAuth2 + FCM HTTP v1
 * ══════════════════════════════════════════════════════════════════════════ */

let _cachedAccessToken: string | null = null;
let _cachedExpiry = 0;

function base64Url(value: string): string {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlBytes(bytes: Uint8Array): string {
  let raw = "";
  for (let i = 0; i < bytes.length; i += 1) raw += String.fromCharCode(bytes[i]);
  return base64Url(raw);
}

async function getAccessToken(): Promise<string> {
  if (_cachedAccessToken && Date.now() < _cachedExpiry) return _cachedAccessToken;
  if (!firebaseConfigured) throw new Error("Firebase is not configured on send-push");

  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${
    base64Url(JSON.stringify({
      iss: FIREBASE_CLIENT_EMAIL,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }))
  }`;

  const pem = FIREBASE_PRIVATE_KEY
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    new TextEncoder().encode(unsigned),
  );
  const assertion = `${unsigned}.${base64UrlBytes(new Uint8Array(signature))}`;

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }).toString(),
  });
  const payload = await response.json();
  if (!payload?.access_token) throw new Error("Failed to obtain a Firebase access token");

  _cachedAccessToken = String(payload.access_token);
  _cachedExpiry = Date.now() + (payload.expires_in ? payload.expires_in * 1000 - 60_000 : 3_500_000);
  return _cachedAccessToken as string;
}

type FcmOptions = { priority?: "high" | "normal"; ttlSeconds?: number };
type FcmResult = { ok: boolean; status: number; details: any };

const RETRY_STATUS_CODES = [429, 500, 502, 503, 504];

async function sendToFcm(
  token: string,
  data: Record<string, string>,
  options: FcmOptions = {},
): Promise<FcmResult> {
  const priority = options.priority ?? "high";
  const ttlSeconds = options.ttlSeconds ??
    (data.type === "test" || data.type === "probe" ? 60 : MESSAGE_TTL_SECONDS);

  const message = {
    token,
    data: fitFcmData(data),
    android: {
      priority: priority === "high" ? "HIGH" : "NORMAL",
      ttl: `${ttlSeconds}s`,
    },
    webpush: {
      headers: { Urgency: priority, TTL: String(ttlSeconds) },
    },
  };

  let last: FcmResult = { ok: false, status: 0, details: null };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const accessToken = await getAccessToken();
      const response = await fetch(
        `https://fcm.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/messages:send`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ message }),
          signal: AbortSignal.timeout(10_000),
        },
      );
      const body = await response.text();
      let details: any = null;
      try {
        details = body ? JSON.parse(body) : null;
      } catch {
        details = { error: body.slice(0, 500) };
      }
      last = { ok: response.ok, status: response.status, details };
      if (response.ok || !RETRY_STATUS_CODES.includes(response.status)) return last;
    } catch (error: any) {
      // انقطاع الشبكة/Timeout لا يجب أن يُسقط Promise.all ويحوّل الحدث كله إلى 500.
      last = {
        ok: false,
        status: 0,
        details: { error: error?.message ?? String(error), retryable: true },
      };
    }
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
  }
  return last;
}

function isDeadToken(status: number, details: any): boolean {
  return /UNREGISTERED|registration-token-not-registered/i.test(JSON.stringify(details ?? {}));
}

/* ══════════════════════════════════════════════════════════════════════════
 * 5) قاعدة البيانات: توكنات + ملفات + سجل التسليم
 * ══════════════════════════════════════════════════════════════════════════ */

type DeviceRow = {
  id: string;
  token: string;
  platform?: string | null;
  device_id?: string | null;
  user_id?: string | null;
};

async function loadDeviceTokens(userId: string): Promise<DeviceRow[]> {
  if (!userId) return [];
  const { data, error } = await supabase
    .from("fcm_tokens")
    .select("id, token, platform, device_id, user_id")
    .eq("user_id", userId);
  if (error) throw error;
  const rows = (data ?? []) as DeviceRow[];
  console.log(`[send-push] recipient=${userId} devices=${rows.length}`);
  return rows;
}

async function loadDeviceTokensForUsers(userIds: string[]): Promise<DeviceRow[]> {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return [];
  const { data, error } = await supabase
    .from("fcm_tokens")
    .select("id, token, platform, device_id, user_id")
    .in("user_id", ids);
  if (error) throw error;
  return (data ?? []) as DeviceRow[];
}

async function loadConversation(conversationId: string) {
  if (!conversationId) return null;
  const { data, error } = await supabase
    .from("conversations")
    .select("id, user_id, admin_id")
    .eq("id", conversationId)
    .maybeSingle();
  if (error) throw error;
  return data as { id: string; user_id: string | null; admin_id: string | null } | null;
}

async function loadProfile(userId: string) {
  if (!userId) return null;
  const { data, error } = await supabase
    .from("profiles")
    .select("id, display_name, avatar_url, is_admin, is_super_admin")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw error;
  return data as {
    id: string;
    display_name?: string | null;
    avatar_url?: string | null;
    is_admin?: boolean | null;
    is_super_admin?: boolean | null;
  } | null;
}

async function loadAdminIds(): Promise<string[]> {
  const { data, error } = await supabase
    .from("profiles")
    .select("id, is_admin, is_super_admin")
    .or("is_admin.eq.true,is_super_admin.eq.true");
  if (error) throw error;
  return ((data ?? []) as any[])
    .filter((row) => row?.id && (row.is_admin || row.is_super_admin))
    .map((row) => String(row.id));
}

async function loadRecentDeliveries(userId: string, limit = 5): Promise<any[]> {
  try {
    const { data, error } = await supabase
      .from("push_delivery_log")
      .select("kind, source, sent, total, skipped, created_at")
      .eq("recipient_id", userId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return (data ?? []) as any[];
  } catch (error) {
    console.warn("[send-push] push_delivery_log read failed", error);
    return [];
  }
}

type DeliveryLog = {
  kind: string;
  refId?: string | null;
  recipientId?: string | null;
  source?: string;
  sent?: number;
  total?: number;
  skipped?: string | null;
  detail?: Record<string, unknown>;
};

/** تسجيل نتيجة كل حدث — يكتبه service_role فقط (لا سياسات كتابة في RLS). */
async function logDelivery(entry: DeliveryLog): Promise<void> {
  try {
    const { error } = await supabase.from("push_delivery_log").insert({
      kind: entry.kind,
      ref_id: entry.refId || null,
      recipient_id: entry.recipientId || null,
      source: entry.source ?? "trigger",
      sent: entry.sent ?? 0,
      total: entry.total ?? 0,
      skipped: entry.skipped ?? null,
      detail: entry.detail ?? {},
    });
    if (error) throw error;
  } catch (error) {
    // السجل تشخيصي فقط — لا يُفشل الإرسال أبداً.
    console.warn("[send-push] delivery log write failed", error);
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * 6) إرسال إلى كل أجهزة المستخدم + تنظيف التوكنات الميتة
 * ══════════════════════════════════════════════════════════════════════════ */

type SendSummary = {
  sent: number;
  total: number;
  results: Array<Record<string, unknown>>;
};

async function sendToAllDevices(
  rows: DeviceRow[],
  data: Record<string, string>,
  options: FcmOptions = {},
): Promise<SendSummary> {
  const results: SendSummary["results"] = [];
  for (let i = 0; i < rows.length; i += FCM_CONCURRENCY) {
    const batch = rows.slice(i, i + FCM_CONCURRENCY);
    const settled = await Promise.all(
      batch.map(async (row) => {
        let result: FcmResult;
        try {
          result = await sendToFcm(row.token, data, options);
        } catch (error: any) {
          // حارس أخير لكل جهاز: فشل جهاز لا يلغي نتائج بقية الأجهزة.
          result = {
            ok: false,
            status: 0,
            details: { error: error?.message ?? String(error) },
          };
        }

        const shouldRemove = !result.ok && isDeadToken(result.status, result.details);
        let removed = false;
        let cleanupError = "";
        if (shouldRemove) {
          try {
            const { error } = await supabase.from("fcm_tokens").delete().eq("id", row.id);
            if (error) throw error;
            removed = true;
          } catch (error: any) {
            cleanupError = error?.message ?? String(error);
          }
        }
        return {
          tokenId: row.id,
          ok: result.ok,
          status: result.status,
          removed,
          error: result.ok ? undefined : JSON.stringify(result.details),
          cleanupError: cleanupError || undefined,
        };
      }),
    );
    results.push(...settled);
  }
  return { sent: results.filter((r) => r.ok).length, total: results.length, results };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 7) معالجة الأحداث
 * ══════════════════════════════════════════════════════════════════════════ */

async function handleNewMessage(event: Extract<PushEvent, { kind: "new_message" }>): Promise<Response> {
  const record = event.record;
  const messageId = text(record.id || record.message_id);
  if (!messageId) return json({ error: "message record without id" }, 400);

  const key = dedupeKey(event);
  if (isDuplicate(key)) return skipped("new_message", "duplicate (already pushed)");

  const [conversation, sender] = await Promise.all([
    loadConversation(text(record.conversation_id)),
    loadProfile(text(record.sender_id)),
  ]);

  const decision = messageRecipient(
    conversation,
    text(record.sender_id),
    Boolean(sender?.is_super_admin),
  );

  // تعارض صريح في المستلم (اختبار يدوي/حمولة معدّلة) ⇒ 409 بدل الإرسال الخاطئ
  if (record.recipient_id && (!decision.allowed || text(record.recipient_id) !== decision.recipientId)) {
    await logDelivery({
      kind: "new_message",
      refId: messageId,
      recipientId: text(record.recipient_id),
      skipped: "recipient mismatch",
    });
    return skipped("new_message", "recipient mismatch", 409);
  }

  if (!decision.allowed) {
    await logDelivery({ kind: "new_message", refId: messageId, skipped: decision.reason });
    return skipped("new_message", decision.reason);
  }

  const tokens = await loadDeviceTokens(decision.recipientId);
  if (!tokens.length) {
    await logDelivery({
      kind: "new_message",
      refId: messageId,
      recipientId: decision.recipientId,
      skipped: "no fcm token",
    });
    return skipped("new_message", "no fcm token");
  }

  const summary = await sendToAllDevices(
    tokens,
    {
      type: "new_message",
      messageId,
      conversationId: text(record.conversation_id),
      senderId: text(record.sender_id),
      title: sender?.display_name || "رسالة جديدة",
      body: messagePreview(record),
      icon: text(sender?.avatar_url),
      timestamp: text(Date.now()),
      messageType: text(record.message_type) || "text",
    },
    {
      priority: PUSH_NORMAL_URGENCY ? "normal" : "high",
      ttlSeconds: MESSAGE_TTL_SECONDS,
    },
  );

  let delivered = false;
  if (summary.sent > 0) {
    delivered = true;
    markSent(key);
    // ✓✓ رمادي حتى لو كان المستقبِل مغلقاً (الإشعار وصل الجهاز)
    await supabase
      .from("messages")
      .update({ status: "delivered" })
      .eq("id", messageId)
      .eq("status", "sent");
  }

  await logDelivery({
    kind: "new_message",
    refId: messageId,
    recipientId: decision.recipientId,
    sent: summary.sent,
    total: summary.total,
  });

  return json({
    ok: true,
    kind: "new_message",
    recipient: decision.recipientId,
    sent: summary.sent,
    total: summary.total,
    delivered,
    results: summary.results,
  });
}

async function handleCall(
  event: Extract<PushEvent, { kind: "incoming_call" | "call_ended" }>,
): Promise<Response> {
  const kind = event.kind;
  const record = event.record;
  const roomId = text(record.id || record.room_id);

  const key = dedupeKey(event);
  if (isDuplicate(key)) return skipped(kind, "duplicate (already pushed)");

  const decision = callRecipient(kind, record);
  if (!decision.allowed) {
    await logDelivery({ kind, refId: roomId, skipped: decision.reason });
    return skipped(kind, decision.reason);
  }

  const conversation = await loadConversation(text(record.conversation_id));
  if (!callPartiesBelongToConversation(conversation, text(record.caller_id), decision.recipientId)) {
    const reason = "call parties are not the conversation parties";
    await logDelivery({ kind, refId: roomId, skipped: reason });
    return skipped(kind, reason);
  }

  const tokens = await loadDeviceTokens(decision.recipientId);
  if (!tokens.length) {
    await logDelivery({
      kind,
      refId: roomId,
      recipientId: decision.recipientId,
      skipped: "no fcm token",
    });
    return skipped(kind, "no fcm token");
  }

  const isVideo = text(record.call_type) === "video";
  const caller = kind === "incoming_call" ? await loadProfile(text(record.caller_id)) : null;

  const data: Record<string, string> = kind === "incoming_call"
    ? {
      type: "incoming_call",
      roomId,
      conversationId: text(record.conversation_id),
      callerId: text(record.caller_id),
      calleeId: decision.recipientId,
      callType: isVideo ? "video" : "audio",
      title: caller?.display_name || "مكالمة واردة",
      body: isVideo ? "📹 مكالمة فيديو واردة" : "📞 مكالمة صوتية واردة",
      icon: text(caller?.avatar_url),
    }
    : {
      type: "call_ended",
      roomId,
      conversationId: text(record.conversation_id),
      callerId: text(record.caller_id),
      calleeId: decision.recipientId,
      missed: String(text(record.status) === "missed"),
      title: text(record.status) === "missed" ? "مكالمة فائتة" : "انتهت المكالمة",
      body: text(record.status) === "missed" ? "مكالمة لم يتم الرد عليها" : "انتهت المكالمة",
    };

  const summary = await sendToAllDevices(tokens, data, {
    priority: "high",
    ttlSeconds: CALL_TTL_SECONDS,
  });
  if (summary.sent > 0) markSent(key);

  await logDelivery({
    kind,
    refId: roomId,
    recipientId: decision.recipientId,
    sent: summary.sent,
    total: summary.total,
    detail: { status: text(record.status), call_type: text(record.call_type) },
  });

  return json({
    ok: true,
    kind,
    recipient: decision.recipientId,
    sent: summary.sent,
    total: summary.total,
  });
}

async function handleNewUser(event: Extract<PushEvent, { kind: "new_user" }>): Promise<Response> {
  const record = event.record;
  const userId = text(record.id || record.user_id);
  if (!userId) return json({ error: "profile record without id" }, 400);

  const key = dedupeKey(event);
  if (isDuplicate(key)) return skipped("new_user", "duplicate (already pushed)");

  const adminIds = (await loadAdminIds()).filter((id) => id !== userId);
  if (!adminIds.length) {
    await logDelivery({ kind: "new_user", refId: userId, skipped: "no admins" });
    return skipped("new_user", "no admins");
  }

  const tokens = await loadDeviceTokensForUsers(adminIds);
  if (!tokens.length) {
    await logDelivery({ kind: "new_user", refId: userId, skipped: "no fcm token" });
    return skipped("new_user", "no fcm token");
  }

  const name = text(record.display_name).trim() || "مستخدم جديد";
  const summary = await sendToAllDevices(
    tokens,
    {
      type: "new_user",
      userId,
      title: `👤 مستخدم جديد: ${name}`,
      body: `الاسم: ${name} — اضغط لبدء محادثة`,
    },
    { priority: "high" },
  );
  if (summary.sent > 0) markSent(key);

  await logDelivery({
    kind: "new_user",
    refId: userId,
    sent: summary.sent,
    total: summary.total,
    detail: { admins: adminIds.length },
  });

  return json({
    ok: true,
    kind: "new_user",
    admins: adminIds.length,
    sent: summary.sent,
    total: summary.total,
  });
}

async function handleEvent(event: PushEvent): Promise<Response> {
  switch (event.kind) {
    case "new_message":
      return await handleNewMessage(event);
    case "incoming_call":
    case "call_ended":
      return await handleCall(event);
    case "new_user":
      return await handleNewUser(event);
    default:
      return json({ error: "unsupported event" }, 400);
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * 8) مسارات يدوية: اختبار + تشخيص
 * ══════════════════════════════════════════════════════════════════════════ */

async function handleTest(userId: string): Promise<Response> {
  const tokens = await loadDeviceTokens(userId);
  if (!tokens.length) return json({ error: "لا يوجد توكن مسجّل لهذا الحساب" }, 404);

  const summary = await sendToAllDevices(
    tokens,
    {
      type: "test",
      title: "✅ الإشعارات تعمل",
      body: "هذا إشعار تجريبي يعمل حتى وإن كان التطبيق مغلقاً.",
    },
    { priority: "high", ttlSeconds: 60 },
  );

  await logDelivery({
    kind: "test",
    refId: userId,
    recipientId: userId,
    source: "manual",
    sent: summary.sent,
    total: summary.total,
  });

  return json({ ok: true, sent: summary.sent, total: summary.total, results: summary.results });
}

async function handleDiagnostics(userId: string): Promise<Response> {
  const [me, tokens, deliveries] = await Promise.all([
    loadProfile(userId),
    loadDeviceTokens(userId),
    loadRecentDeliveries(userId),
  ]);

  const triggerDeliveries = deliveries.filter((row) => row?.source === "webhook" || row?.source === "trigger");
  const triggerSecretConfigured = SEND_PUSH_SECRET.length >= 32;

  return json({
    ok: true,
    service: "send-push",
    version: SERVICE_VERSION,
    architecture: "pg_net-database-triggers",
    database_notifications: {
      pg_net: true,
      vault: true,
      db_triggers: true,
      triggers: [
        "send_fcm_on_new_message",
        "on_call_room_notify",
        "on_profile_created_notify_admins",
      ],
      functions: [
        "send_push_post",
        "handle_new_message_notification",
        "notify_call_room",
        "notify_admins_new_profile",
      ],
      note: "المسار المتوقع: pg_net + التريغرات القانونية + Vault. نفّذ sql/send-push-audit.sql للتحقق من حالة قاعدة البيانات الفعلية.",
    },
    firebase: {
      configured: firebaseConfigured,
      project_id: FIREBASE_PROJECT_ID || null,
      service_account_email: FIREBASE_CLIENT_EMAIL || null,
    },
    // اسم الحقل webhook محفوظ لتوافق الواجهة؛ النقل الفعلي هو تريغر pg_net.
    webhook: {
      secret_configured: triggerSecretConfigured,
      endpoint: `${SUPABASE_URL}/functions/v1/send-push`,
      method: "POST",
      required_header: "x-send-push-secret",
      gateway_verify_jwt: false,
      expected_hooks: [
        { table: "messages", events: ["INSERT"], trigger: "send_fcm_on_new_message" },
        { table: "call_rooms", events: ["INSERT", "UPDATE"], trigger: "on_call_room_notify" },
        { table: "profiles", events: ["INSERT"], trigger: "on_profile_created_notify_admins" },
      ],
    },
    me: {
      user_id: userId,
      display_name: me?.display_name ?? null,
      is_admin: Boolean(me?.is_admin || me?.is_super_admin),
      devices: tokens.length,
    },
    delivery_log: {
      recent: deliveries,
      webhook_events_seen: triggerDeliveries.length,
    },
    checks: {
      firebase_ready: firebaseConfigured,
      webhook_secret_ready: triggerSecretConfigured,
      has_device: tokens.length > 0,
      webhook_flow_observed: triggerDeliveries.length > 0,
    },
    hint: !triggerSecretConfigured
      ? "⚠️ اضبط SEND_PUSH_SECRET (32+ حرفاً) في Edge Secrets وطابقه مع send_push_secret في Vault."
      : triggerDeliveries.length
      ? "✅ وُصلت إشعارات تلقائية من تريگر قاعدة البيانات — راجع نتيجة التسليم الأخيرة."
      : "ℹ️ اضبط Vault ونفّذ الهجرة، ثم أرسل رسالة من حساب آخر لتسجيل أول حدث تلقائي.",
  });
}

/* ══════════════════════════════════════════════════════════════════════════
 * 9) الخادم
 * ══════════════════════════════════════════════════════════════════════════ */

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-send-push-secret",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Max-Age": "86400",
        Allow: "POST, OPTIONS",
      },
    });
  }
  if (req.method !== "POST") return methodNotAllowed(req.method);

  try {
    let payload: unknown;
    try {
      payload = await req.json();
    } catch {
      return json({ error: "invalid JSON body: expected one JSON object" }, 400);
    }
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      return json({ error: "invalid payload: expected a JSON object" }, 400);
    }

    const type = text((payload as Record<string, unknown>).type);

    // ── مسارات المستخدم (JWT) ──────────────────────────────────────────
    if (type === "test" || type === "diagnostics") {
      const userId = await authenticatedUserId(req);
      if (!userId) return json({ error: "Unauthorized: a valid user JWT is required" }, 401);
      return type === "test" ? await handleTest(userId) : await handleDiagnostics(userId);
    }

    // ── مسار تريغر قاعدة البيانات (سرّ مشترك إلزامي) ─────────────────
    if (SEND_PUSH_SECRET.length < 32) {
      console.error("[send-push] SEND_PUSH_SECRET is missing or shorter than 32 characters");
      return json({ error: "SEND_PUSH_SECRET is not configured correctly on send-push" }, 503);
    }
    if (!isWebhookAuthorized(req)) {
      return json(
        { error: "Unauthorized: send x-send-push-secret matching SEND_PUSH_SECRET" },
        401,
      );
    }

    const normalized = normalizePayload(payload);
    if (!normalized.ok) {
      if ("ignored" in normalized) return json({ ok: true, ignored: normalized.ignored });
      return json({ error: normalized.error }, 400);
    }

    if (!firebaseConfigured) {
      return json({ error: "Firebase is not configured on send-push" }, 503);
    }

    const event = normalized.event;
    console.log(`[send-push] event=${event.kind} ref=${eventRefId(event)}`);
    return await handleEvent(event);
  } catch (error: any) {
    console.error("[send-push] failed", error);
    return json({ error: error?.message ?? String(error) }, 500);
  }
});
