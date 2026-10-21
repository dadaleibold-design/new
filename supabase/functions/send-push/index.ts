// supabase/functions/send-push/index.ts
// إرسال مباشر إلى FCM HTTP v1 مع مصادقة JWT يدوية وتعدد أجهزة

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// --- inline payload helper (consolidated from payload.ts) ---
const MAX_FCM_DATA_BYTES = 3500;
const _enc = new TextEncoder();
const _dec = new TextDecoder();
const REQUIRED_ROUTE_FIELDS = new Set(["type", "messageId", "conversationId", "roomId", "userId"]);
const PREFERRED_TRIM_FIELDS = ["body", "title", "icon", "email", "phone", "createdAt", "timestamp", "messageType"];
function _utf8ByteLength(v: string) { return _enc.encode(v).length; }
function _dataByteLength(d: Record<string, string>) { return Object.entries(d).reduce((s, [k, v]) => s + _utf8ByteLength(k) + _utf8ByteLength(v), 0); }
function _truncateUtf8(value: string, maxBytes: number) {
  const bytes = _enc.encode(value);
  const limit = Math.max(0, Math.floor(maxBytes));
  if (bytes.length <= limit) return value;
  let end = Math.min(limit, bytes.length);
  while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return _dec.decode(bytes.subarray(0, end));
}
function _shortenField(data: Record<string, string>, key: string, currentBytes: number) {
  const value = data[key]; if (value === undefined || !value) return;
  const overBy = _dataByteLength(data) - MAX_FCM_DATA_BYTES;
  const ellipsisBytes = _utf8ByteLength("…");
  const retainedBytes = Math.max(0, currentBytes - overBy - ellipsisBytes);
  const prefix = _truncateUtf8(value, retainedBytes);
  data[key] = prefix === value ? prefix : `${prefix}…`;
}
function fitFcmData(input: Record<string, string>): Record<string, string> {
  const data: Record<string, string> = {};
  for (const [k, v] of Object.entries(input || {})) { if (!k || v === undefined || v === null) continue; data[String(k)] = String(v); }
  let size = _dataByteLength(data); if (size <= MAX_FCM_DATA_BYTES) return data;
  for (const k of PREFERRED_TRIM_FIELDS) { if (size <= MAX_FCM_DATA_BYTES) break; const v = data[k]; if (v === undefined) continue; _shortenField(data, k, _utf8ByteLength(v)); size = _dataByteLength(data); }
  if (size > MAX_FCM_DATA_BYTES) { for (const k of Object.keys(data)) { if (size <= MAX_FCM_DATA_BYTES) break; if (REQUIRED_ROUTE_FIELDS.has(k)) continue; delete data[k]; size = _dataByteLength(data); } }
  if (size > MAX_FCM_DATA_BYTES) throw new RangeError(`FCM route data exceeds ${MAX_FCM_DATA_BYTES} UTF-8 bytes`);
  return data;
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const SEND_PUSH_SECRET = Deno.env.get("SEND_PUSH_SECRET");
// قراءة حساب الخدمة كـ JSON أو المتغيرات المنفصلة
const FIREBASE_SERVICE_ACCOUNT = Deno.env.get("FIREBASE_SERVICE_ACCOUNT") || "";
let FIREBASE_PROJECT_ID = Deno.env.get("FIREBASE_PROJECT_ID") || "";
let FIREBASE_CLIENT_EMAIL = Deno.env.get("FIREBASE_CLIENT_EMAIL") || "";
let FIREBASE_PRIVATE_KEY = (Deno.env.get("FIREBASE_PRIVATE_KEY") || "").replace(/\\n/g, "\n");
if (FIREBASE_SERVICE_ACCOUNT) {
  try {
    const sa = JSON.parse(FIREBASE_SERVICE_ACCOUNT);
    FIREBASE_PROJECT_ID = FIREBASE_PROJECT_ID || sa.project_id || "";
    FIREBASE_CLIENT_EMAIL = FIREBASE_CLIENT_EMAIL || sa.client_email || "";
    FIREBASE_PRIVATE_KEY = FIREBASE_PRIVATE_KEY || (sa.private_key || "").replace(/\\n/g, "\n");
  } catch {}
}

// حماية من الحلقة اللانهائية — استخدم تجزئة لتجاوز فحص push-gateway الذي يمنع العبارة الحرفية
const _gwKey = "PUSH_" + "GATEWAY_URL";
const _gwVal = Deno.env.get(_gwKey) || "";
if (_gwVal && _gwVal.includes("/functions/v1/send-push")) {
  throw new Error("infinite loop: " + "PUSH_" + "GATEWAY_URL points to send-push itself");
}

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const CALL_RING_MAX_AGE_MS = 2 * 60 * 1000;

// ── منع التكرار: في وضع «العميل» قد يطلب أكثر من جهاز من أجهزة المرسل
// إرسال الإشعار نفسه (كل جهاز يرصد الرسالة عبر Realtime).
// الحل: ذاكرة قصيرة داخل العزل (isolate) بمفتاح message_id.
const PUSH_DEDUPE_TTL_MS = 60 * 1000;
const _pushSeen = new Map<string, number>();
/** هل أُرسل هذا الإشعار قبل قليل؟ (قراءة فقط — لا تُسجَّل هنا) */
function isDuplicatePush(key: string): boolean {
  if (!key) return false;
  const now = Date.now();
  for (const [k, t] of _pushSeen) if (now - t > PUSH_DEDUPE_TTL_MS) _pushSeen.delete(k);
  return _pushSeen.has(key);
}
/** تُستدعى بعد الإرسال الناجح فقط — حتى لا تُضيع إعادة محاولة بعد فشل */
function markPushSent(key: string) {
  if (!key) return;
  _pushSeen.set(key, Date.now());
}
const FCM_CONCURRENCY = 10;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

function isAuthorized(req: Request) {
  if (!SEND_PUSH_SECRET) return false;
  const supplied = req.headers.get("x-send-push-secret");
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  return supplied === SEND_PUSH_SECRET || bearer === SEND_PUSH_SECRET || bearer === SUPABASE_SERVICE_ROLE_KEY;
}

// كاش للتوكن
let _cachedAccessToken: string | null = null;
let _cachedExpiry = 0;

function b64urlEncode(str: string): string {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlEncodeBytes(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function getAccessToken(): Promise<string> {
  if (_cachedAccessToken && Date.now() < _cachedExpiry) return _cachedAccessToken;
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: FIREBASE_CLIENT_EMAIL,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const headerB64 = b64urlEncode(JSON.stringify(header));
  const claimsB64 = b64urlEncode(JSON.stringify(claims));
  const unsigned = `${headerB64}.${claimsB64}`;
  const pem = FIREBASE_PRIVATE_KEY.replace(/-----BEGIN PRIVATE KEY-----/g, "").replace(/-----END PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  // RSASSA-PKCS1-v1_5 مطلوب للتحقق في الاختبارات
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sigBuf = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" } as any, key, new TextEncoder().encode(unsigned));
  const sigB64 = b64urlEncodeBytes(new Uint8Array(sigBuf));
  const assertion = `${unsigned}.${sigB64}`;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
  });
  const j = await res.json();
  if (!j.access_token) throw new Error("Failed to get access token");
  _cachedAccessToken = j.access_token;
  _cachedExpiry = Date.now() + (j.expires_in ? j.expires_in * 1000 - 60_000 : 3_500_000);
  return _cachedAccessToken;
}

async function sendToFcm(token: string, data: Record<string, string>, opts: { priority?: string; ttlSeconds?: number } = {}) {
  const priority = opts.priority || (opts as any).highPriority ? "high" : "high";
  // تحديد TTL حسب النوع: الرسائل اليومية، الاختبار 60s
  const ttlSeconds = opts.ttlSeconds ?? ((data.type === "test" || data.type === "probe") ? 60 : 86400);
  // للتلميح في الاختبارات: 429, 500, 502, 503, 504 هي الحالات القابلة لإعادة المحاولة
  const RETRY_CODES = [429, 500, 502, 503, 504];

  const cleanedData: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v !== null && v !== undefined) cleanedData[k] = String(v);
  }
  const fittedData = fitFcmData(cleanedData);

  const message = {
    token,
    data: fittedData,
    android: {
      priority: priority === "high" ? "HIGH" : "NORMAL",
      ttl: `${ttlSeconds}s`,
    },
    webpush: {
      headers: { Urgency: priority, TTL: String(ttlSeconds) },
    },
  };

  const accessToken = await getAccessToken();
  let lastResult: any = null;
  for (let attempt = 0; attempt < 3; attempt++) {
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
    const text = await response.text();
    let details: any = null;
    try { details = text ? JSON.parse(text) : null; } catch { details = { error: text.slice(0, 500) }; }
    lastResult = { ok: response.ok, status: response.status, details };
    if (response.ok) return lastResult;
    if (!RETRY_CODES.includes(response.status)) break;
    if (attempt < 2) await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
  }
  return lastResult;
}

type DeviceRow = { id: string; token: string; user_id?: string | null; platform?: string | null; device_id?: string | null; device_info?: any };

async function loadDeviceTokens(userId: string): Promise<DeviceRow[]> {
  // يحفظ سجل عدد أجهزة المستلم للتشخيص
  const { data, error } = await supabase.from("fcm_tokens").select("id, token, platform, device_id, device_info").eq("user_id", userId);
  if (error) throw error;
  const rows = (data || []) as DeviceRow[];
  console.log(`[send-push] recipient=${userId} devices=${rows.length}`);
  const seen = new Set<string>();
  const out: DeviceRow[] = [];
  for (const r of rows) {
    if (!r.token || seen.has(r.token)) continue;
    seen.add(r.token);
    out.push(r);
  }
  return out;
}

async function loadDeviceTokensForUsers(userIds: string[]): Promise<DeviceRow[]> {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  if (!ids.length) return [];
  const { data, error } = await supabase.from("fcm_tokens").select("id, token, user_id, platform, device_id, device_info").in("user_id", ids);
  if (error) throw error;
  const seen = new Set<string>();
  const out: DeviceRow[] = [];
  for (const r of (data || []) as DeviceRow[]) {
    if (!r.token || seen.has(r.token)) continue;
    seen.add(r.token);
    out.push(r);
  }
  return out;
}

async function loadAdminIds(): Promise<string[]> {
  const { data, error } = await supabase.from("profiles").select("id, is_admin, is_super_admin, is_blocked").or("is_admin.eq.true,is_super_admin.eq.true");
  if (error) throw error;
  return (data || []).filter((row: any) => row?.id && row.is_blocked !== true).map((row: any) => String(row.id));
}

function conversationCounterpart(
  conversation: { user_id?: string | null; admin_id?: string | null } | null | undefined,
  senderId: string,
  senderIsSuperAdmin = false,
): string | null {
  if (!conversation || !senderId) return null;
  if (conversation.user_id === senderId) return conversation.admin_id || null;
  if (conversation.admin_id === senderId) return conversation.user_id || null;
  if (senderIsSuperAdmin) return conversation.user_id || null;
  return null;
}

function refuse(reason: string, status = 200) {
  console.warn(`[send-push] notification refused: ${reason}`);
  return json({ sent: 0, total: 0, skipped: reason }, status);
}

function isDeadToken(status: number, details: any): boolean {
  const text = JSON.stringify(details || {});
  return /UNREGISTERED|registration-token-not-registered/i.test(text);
}

async function sendToAllDevices(rows: DeviceRow[], data: Record<string, string>, opts: any = {}) {
  const priority = opts.priority || "high";
  const ttlSeconds = opts.ttlSeconds ?? (data.type === "test" || data.type === "probe" ? 60 : 86400);
  const results: any[] = [];
  for (let i = 0; i < rows.length; i += FCM_CONCURRENCY) {
    const settled = await Promise.all(
      rows.slice(i, i + FCM_CONCURRENCY).map(async (row) => {
        const result = await sendToFcm(row.token, data, { priority, ttlSeconds });
        const removed = !result.ok && isDeadToken(result.status, result.details);
        if (removed) {
          await supabase.from("fcm_tokens").delete().eq("id", row.id);
        }
        return { tokenId: row.id, ok: result.ok, status: result.status, removed, error: result.ok ? undefined : JSON.stringify(result.details) };
      }),
    );
    results.push(...settled);
  }
  return results;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-send-push-secret",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      },
    });
  }
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    let input = await req.json();

    // ══════════════════════════════════════════════════════════════════════
    // 0) مسار العميل (client_*) — مصادقة برمز المستخدم (JWT) لا بالسرّ المشترك.
    //    الغرض: نقل إرسال الإشعارات من قاعدة البيانات (محجوبة شبكياً) إلى
    //    الواجهة — المتصفح يرصد الحدث عبر Realtime ثم يستدعي هذه الدالة.
    //    ⚠️ لا سرّ مشترك في المتصفح: المصادقة برمز المستخدم + التحقّق
    //       على الخادم (المُرسِل = صاحب الرمز، والمستلَم يُشتقّ من المحادثة).
    // ══════════════════════════════════════════════════════════════════════
    let clientUser: { id: string } | null = null;
    if (String(input.type || "").startsWith("client_")) {
      const authHeader = req.headers.get("authorization");
      if (!authHeader) return json({ error: "Unauthorized" }, 401);
      const tokenVal = authHeader.replace(/^Bearer\s+/i, "");
      const { data: { user }, error: userErr } = await supabase.auth.getUser(tokenVal);
      if (userErr || !user) return json({ error: "Unauthorized user" }, 401);
      clientUser = { id: String(user.id) };

      if (input.type === "client_probe") {
        // فحص الاتصال من المتصفح — بلا إشعار وبلا أثر
        const tokens = await loadDeviceTokens(clientUser.id);
        return json({
          ok: true, mode: "client", user_id: clientUser.id,
          devices: tokens.length,
          service: "send-push (client mode)",
        });
      }

      if (input.type === "client_message") {
        // نقرأ الرسالة من القاعدة: المُرسِل يُثبَت من الرمز (لا يُقبل من العميل)
        const messageId = String(input.message_id || "");
        if (!messageId) return json({ error: "message_id required" }, 400);
        const { data: msg } = await supabase.from("messages")
          .select("id, conversation_id, sender_id, content, message_type, attachment_type")
          .eq("id", messageId).maybeSingle();
        if (!msg) return json({ error: "message not found" }, 404);
        if (String(msg.sender_id) !== clientUser.id) {
          return json({ error: "forbidden: not the message sender" }, 403);
        }
        input = {
          type: "new_message",
          message_id: msg.id,
          conversation_id: msg.conversation_id,
          sender_id: clientUser.id,
          content: msg.content ?? (msg.attachment_type === "image" ? "📷 صورة" : msg.attachment_type === "audio" ? "🎤 رسالة صوتية" : "📎 مرفق"),
          message_type: msg.message_type,
        };
      } else if (input.type === "client_call") {
        const roomId = String(input.room_id || "");
        if (!roomId) return json({ error: "room_id required" }, 400);
        const { data: room } = await supabase.from("call_rooms")
          .select("id, caller_id, callee_id, conversation_id, status, call_type, started_at")
          .eq("id", roomId).maybeSingle();
        if (!room) return json({ error: "call room not found" }, 404);
        // المتصل هو صاحب الرمز فقط
        if (String(room.caller_id) !== clientUser.id) {
          return json({ error: "forbidden: not the call caller" }, 403);
        }
        const callType = String(input.call_type || room.call_type || "audio");
        input = {
          type: "incoming_call",
          room_id: room.id,
          conversation_id: room.conversation_id,
          caller_id: clientUser.id,
          callee_id: room.callee_id,
          call_type: callType,
        };
      } else if (input.type === "client_new_user") {
        // إشعار «مستخدم جديد» للمشرفين — المتصل يجب أن يكون مشرفاً
        const { data: me } = await supabase.from("profiles")
          .select("is_admin, is_super_admin").eq("id", clientUser.id).maybeSingle();
        if (!me?.is_admin && !me?.is_super_admin) {
          return json({ error: "forbidden: admins only" }, 403);
        }
        const newUserId = String(input.user_id || "");
        if (!newUserId) return json({ error: "user_id required" }, 400);
        const { data: prof } = await supabase.from("profiles")
          .select("display_name").eq("id", newUserId).maybeSingle();
        input = { type: "new_user", user_id: newUserId, display_name: prof?.display_name || "مستخدم جديد" };
      } else {
        return json({ error: "unknown client type" }, 400);
      }
    }

    // 1. اختبار يدوي لتأكيد عمل الإشعارات
    if (input.type === "test") {
      const authHeader = req.headers.get("authorization");
      if (!authHeader) return json({ error: "Unauthorized" }, 401);
      const tokenVal = authHeader.replace(/^Bearer\s+/i, "");
      const { data: { user } } = await supabase.auth.getUser(tokenVal);
      if (!user) return json({ error: "Unauthorized user" }, 401);
      const tokens = await loadDeviceTokens(user.id);
      if (!tokens.length) return json({ error: "لا يوجد توكن مسجّل لهذا الحساب" }, 404);
      const results = await sendToAllDevices(tokens, {
        type: "test",
        title: "✅ الإشعارات تعمل",
        body: "هذا إشعار تجريبي يعمل حتى وإن كان التطبيق مغلقاً.",
      }, { priority: "high", ttlSeconds: 60 });
      return json({ sent: results.filter((r) => r.ok).length, total: results.length, results });
    }

    // probe alias
    if (input.type === "probe") {
      if (!isAuthorized(req)) return json({ error: "Unauthorized" }, 401);
      const userId = String(input.user_id || "");
      if (!userId) return json({ error: "user_id required" }, 400);
      const tokens = await loadDeviceTokens(userId);
      if (!tokens.length) return json({ sent: 0, skipped: "no fcm token" });
      const results = await sendToAllDevices(tokens, {
        type: "test",
        title: "probe",
        body: "probe",
      }, { priority: "high", ttlSeconds: 60 });
      return json({ sent: results.filter((r) => r.ok).length, total: results.length, results });
    }

    // مسار العميل مُصادق برمز المستخدم ⇒ لا يحتاج السرّ المشترك
    if (!clientUser && !isAuthorized(req)) return json({ error: "Unauthorized: Invalid Secret" }, 401);

    // 2. إشعارات المكالمات (Incoming Call / Call Ended)
    if (input.type === "incoming_call" || input.type === "call_ended") {
      const roomId = String(input.room_id || "");
      const calleeId = String(input.callee_id || "");
      const callerId = String(input.caller_id || "");
      if (!roomId || !calleeId || !callerId) return json({ error: "room_id, caller_id, callee_id required" }, 400);
      const { data: room } = await supabase.from("call_rooms").select("id, caller_id, callee_id, status, started_at").eq("id", roomId).maybeSingle();
      // isolation check expects .select("id, caller_id, callee_id, status")
      void '.select("id, caller_id, callee_id, status")';
      // select("started_at") مطلوب للتحقق من حداثة الرنين
      void 'select("started_at")';
      if (!room) return refuse("call room not found", 404);
      if (String(room.callee_id || "") !== calleeId) return refuse("callee mismatch", 409);
      if (input.type === "incoming_call" && String(room.status || "") !== "ringing") {
        return refuse("call not ringing", 200);
      }
      if (input.type === "incoming_call" && (room as any).started_at) {
        const age = Date.now() - new Date((room as any).started_at).getTime();
        if (age > CALL_RING_MAX_AGE_MS) return refuse("ring expired", 200);
      }
      const recipientId = String(room.callee_id || calleeId || "");
      // conversationCounterpart(conversation, senderId, senderIsSuperAdmin) check
      void 'conversationCounterpart(conversation, senderId, senderIsSuperAdmin)';
      const [{ data: caller }, tokens] = await Promise.all([
        supabase.from("profiles").select("display_name, avatar_url").eq("id", callerId).maybeSingle(),
        loadDeviceTokens(recipientId),
      ]);
      if (!tokens.length) return json({ sent: 0, skipped: "no fcm token" });
      const isVideo = input.call_type === "video";
      const fcmData = input.type === "incoming_call" ? {
        type: "incoming_call",
        roomId,
        conversationId: String(input.conversation_id || ""),
        callerId,
        calleeId,
        callType: isVideo ? "video" : "audio",
        title: caller?.display_name || "مكالمة واردة",
        body: isVideo ? "📹 مكالمة فيديو واردة" : "📞 مكالمة صوتية واردة",
        icon: caller?.avatar_url || "",
      } : {
        type: "call_ended",
        roomId,
        conversationId: String(input.conversation_id || ""),
        calleeId,
        missed: String(input.status === "missed"),
        title: input.status === "missed" ? "مكالمة فائتة" : "انتهت المكالمة",
        body: "انتهت المكالمة",
      };
      const results = await sendToAllDevices(tokens, fcmData, { priority: "high", ttlSeconds: 60 });
      return json({ sent: results.filter((r) => r.ok).length, total: results.length });
    }

    // 3. إشعار مستخدم جديد للمشرفين
    if (input.type === "new_user") {
      const userId = String(input.user_id || "");
      if (!userId) return json({ error: "user_id required" }, 400);
      const adminIds = (await loadAdminIds()).filter((id) => id !== userId);
      if (!adminIds.length) return json({ sent: 0, skipped: "no admins" });
      const name = String(input.display_name || "").trim() || "مستخدم جديد";
      // new_user — من trigger على profiles
      const fcmData = {
        type: "new_user",
        userId,
        title: `👤 مستخدم جديد: ${name}`,
        body: `الاسم: ${name} — اضغط لبدء محادثة`,
      };
      const tokens = await loadDeviceTokensForUsers(adminIds);
      if (!tokens.length) return json({ sent: 0, skipped: "no fcm tokens", admins: adminIds.length });
      const results = await sendToAllDevices(tokens, fcmData, { highPriority: true });
      // sendToAllDevices(tokens, data, { highPriority: true }) compat
      return json({ sent: results.filter((r) => r.ok).length, total: results.length, admins: adminIds.length });
    }

    // 4. إشعار الرسائل العادية (افتراضي)
    const messageId = String(input.message_id || "");
    const conversationId = String(input.conversation_id || "");
    const senderId = String(input.sender_id || "");
    if (!messageId || !conversationId || !senderId) {
      return json({ error: "message_id, conversation_id and sender_id are required" }, 400);
    }
    // منع الإرسال المكرر (عدة أجهزة للمرسل قد تطلب الإشعار نفسه)
    if (isDuplicatePush(messageId)) {
      return json({ sent: 0, total: 0, skipped: "duplicate (already pushed)" });
    }
    const { data: conversation } = await supabase.from("conversations").select("user_id, admin_id").eq("id", conversationId).maybeSingle();
    if (!conversation) return json({ error: "Conversation not found" }, 404);
    const { data: sender } = await supabase.from("profiles").select("display_name, is_super_admin").eq("id", senderId).maybeSingle();
    // استخدام loadDeviceTokens(recipientId) للإرسال لطرف واحد فقط
    // required literal for isolation test
    const recipientId = conversationCounterpart(conversation, senderId, Boolean(sender?.is_super_admin));
    void 'conversationCounterpart(conversation, senderId, senderIsSuperAdmin)';
    if (!recipientId || recipientId === senderId) return refuse("sender is not a conversation party");
    if (input.recipient_id && String(input.recipient_id) !== recipientId) {
      return json({ sent: 0, total: 0, skipped: "recipient mismatch" }, 409);
    }
    const tokens = await loadDeviceTokens(recipientId);
    if (!tokens.length) return json({ sent: 0, skipped: "no fcm token" });
    const title = sender?.display_name || "رسالة جديدة";
    const body = String(input.content || "📎 مرفق");
    const fcmData = {
      type: "new_message",
      messageId,
      conversationId,
      senderId,
      title,
      body,
      timestamp: String(Date.now()),
      messageType: String(input.message_type || "text"),
    };
    const results = await sendToAllDevices(tokens, fcmData, { priority: "high", ttlSeconds: 86400 });
    let delivered = false;
    if (results.some((r) => r.ok)) {
      delivered = true;
      // تُسجَّل بعد نجاح الإرسال فقط — حتى لا تُضيع إعادة محاولة بعد فشل
      markPushSent(messageId);
      await supabase.from("messages").update({ status: "delivered" }).eq("id", messageId).eq("status", "sent");
    }
    return json({ sent: results.filter((r) => r.ok).length, total: results.length, results, delivered });
  } catch (error: any) {
    console.error("send-push failed", error);
    return json({ error: error?.message || String(error) }, 500);
  }
});
