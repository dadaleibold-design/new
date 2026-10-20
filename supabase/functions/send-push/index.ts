// supabase/functions/send-push/index.ts
// دمج الموثوقية العالية (Google Auth Library) مع كامل ميزات النظام (رسائل، مكالمات، مستخدم جديد)

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { JWT } from "https://esm.sh/google-auth-library@8.7.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const SEND_PUSH_SECRET = Deno.env.get("SEND_PUSH_SECRET");

const FIREBASE_PROJECT_ID = Deno.env.get("FIREBASE_PROJECT_ID") || "";
const FIREBASE_CLIENT_EMAIL = Deno.env.get("FIREBASE_CLIENT_EMAIL") || "";
const FIREBASE_PRIVATE_KEY = (Deno.env.get("FIREBASE_PRIVATE_KEY") || "").replace(/\\n/g, "\n");

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
const CALL_RING_MAX_AGE_MS = 2 * 60 * 1000;

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
  return supplied === SEND_PUSH_SECRET || bearer === SEND_PUSH_SECRET || bearer === SERVICE_ROLE_KEY;
}

// استخدام المكتبة الرسمية والمستقرة لتوليد رمز المصادقة
async function getAccessToken(): Promise<string> {
  const client = new JWT({
    email: FIREBASE_CLIENT_EMAIL,
    key: FIREBASE_PRIVATE_KEY,
    scopes: ["https://www.googleapis.com/auth/firebase.messaging"],
  });
  const tokens = await client.authorize();
  if (!tokens.access_token) {
    throw new Error("Failed to retrieve Google OAuth access token");
  }
  return tokens.access_token;
}

async function sendToFcm(token: string, data: Record<string, string>, opts: { highPriority?: boolean } = {}) {
  const priority = opts.highPriority ? "high" : "normal";
  const ttlSeconds = opts.highPriority ? 60 : 86400;

  // تنظيف وتأكيد أن جميع قيم الـ data عبارة عن نصوص (شرط FCM)
  const cleanedData: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v !== null && v !== undefined) cleanedData[k] = String(v);
  }

  const message = {
    token,
    data: cleanedData,
    android: {
      priority: priority === "high" ? "HIGH" : "NORMAL",
      ttl: `${ttlSeconds}s`,
    },
    webpush: {
      headers: { Urgency: priority, TTL: String(ttlSeconds) },
    },
  };

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

  const responseText = await response.text();
  let details: any = null;
  try {
    details = responseText ? JSON.parse(responseText) : null;
  } catch {
    details = { error: responseText.slice(0, 500) };
  }
  return { ok: response.ok, status: response.status, details };
}

type DeviceRow = { id: string; token: string; user_id?: string | null; platform?: string | null; device_id?: string | null };

async function loadDeviceTokens(userId: string): Promise<DeviceRow[]> {
  const { data, error } = await supabase
    .from("fcm_tokens")
    .select("id, token, platform, device_id")
    .eq("user_id", userId);
  if (error) throw error;

  const seen = new Set<string>();
  const rows: DeviceRow[] = [];
  for (const row of (data || []) as DeviceRow[]) {
    if (!row.token || seen.has(row.token)) continue;
    seen.add(row.token);
    rows.push(row);
  }
  return rows;
}

async function loadDeviceTokensForUsers(userIds: string[]): Promise<DeviceRow[]> {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  if (!ids.length) return [];

  const { data, error } = await supabase
    .from("fcm_tokens")
    .select("id, token, user_id, platform, device_id")
    .in("user_id", ids);
  if (error) throw error;

  const seen = new Set<string>();
  const rows: DeviceRow[] = [];
  for (const row of (data || []) as DeviceRow[]) {
    if (!row.token || seen.has(row.token)) continue;
    seen.add(row.token);
    rows.push(row);
  }
  return rows;
}

async function loadAdminIds(): Promise<string[]> {
  const { data, error } = await supabase
    .from("profiles")
    .select("id, is_admin, is_super_admin, is_blocked")
    .or("is_admin.eq.true,is_super_admin.eq.true");
  if (error) throw error;

  return (data || [])
    .filter((row: any) => row?.id && row.is_blocked !== true)
    .map((row: any) => String(row.id));
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
  return /UNREGISTERED|registration-token-not-registered/i.test(text) || (status === 400 && /not a valid FCM registration token/i.test(text));
}

async function sendToAllDevices(rows: DeviceRow[], data: Record<string, string>, opts: any = {}) {
  const results = [];
  for (const row of rows) {
    const result = await sendToFcm(row.token, data, opts);
    const removed = !result.ok && isDeadToken(result.status, result.details);
    if (removed) {
      await supabase.from("fcm_tokens").delete().eq("id", row.id);
    }
    results.push({ tokenId: row.id, ok: result.ok, status: result.status, removed, error: result.ok ? undefined : JSON.stringify(result.details) });
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
    const input = await req.json();

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
        title: "✅ الإشعارات تعمل بنجاح",
        body: "هذا إشعار تجريبي يعمل حتى وإن كان التطبيق مغلقاً.",
      }, { highPriority: true });
      return json({ sent: results.filter(r => r.ok).length, total: results.length, results });
    }

    if (!isAuthorized(req)) return json({ error: "Unauthorized: Invalid Secret" }, 401);

    // 2. إشعارات المكالمات (Incoming Call / Call Ended)
    if (input.type === "incoming_call" || input.type === "call_ended") {
      const roomId = String(input.room_id || "");
      const calleeId = String(input.callee_id || "");
      const callerId = String(input.caller_id || "");
      if (!roomId || !calleeId || !callerId) return json({ error: "room_id, caller_id, callee_id required" }, 400);

      const { data: room } = await supabase.from("call_rooms").select("id, caller_id, callee_id, status").eq("id", roomId).maybeSingle();
      if (!room) return refuse("call room not found", 404);
      if (String(room.callee_id || "") !== calleeId) return refuse("callee mismatch", 409);

      if (input.type === "incoming_call" && String(room.status || "") !== "ringing") {
        return refuse("call not ringing", 200);
      }

      const [{ data: caller }, tokens] = await Promise.all([
        supabase.from("profiles").select("display_name, avatar_url").eq("id", callerId).maybeSingle(),
        loadDeviceTokens(calleeId),
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

      const results = await sendToAllDevices(tokens, fcmData, { highPriority: true });
      return json({ sent: results.filter(r => r.ok).length, total: results.length });
    }

    // 3. إشعار مستخدم جديد للمشرفين
    if (input.type === "new_user") {
      const userId = String(input.user_id || "");
      if (!userId) return json({ error: "user_id required" }, 400);

      const adminIds = (await loadAdminIds()).filter(id => id !== userId);
      if (!adminIds.length) return json({ sent: 0, skipped: "no admins" });

      const name = String(input.display_name || "").trim() || "مستخدم جديد";
      const fcmData = {
        type: "new_user",
        userId,
        title: "👤 مستخدم جديد انضم للتطبيق",
        body: `الاسم: ${name} — اضغط لبدء محادثة`,
      };

      const tokens = await loadDeviceTokensForUsers(adminIds);
      if (!tokens.length) return json({ sent: 0, skipped: "no fcm tokens" });

      const results = await sendToAllDevices(tokens, fcmData, { highPriority: true });
      return json({ sent: results.filter(r => r.ok).length, total: results.length });
    }

    // 4. إشعار الرسائل العادية (افتراضي)
    const messageId = String(input.message_id || "");
    const conversationId = String(input.conversation_id || "");
    const senderId = String(input.sender_id || "");
    if (!messageId || !conversationId || !senderId) {
      return json({ error: "message_id, conversation_id and sender_id are required" }, 400);
    }

    const { data: conversation } = await supabase.from("conversations").select("user_id, admin_id").eq("id", conversationId).maybeSingle();
    if (!conversation) return json({ error: "Conversation not found" }, 404);

    const { data: sender } = await supabase.from("profiles").select("display_name, is_super_admin").eq("id", senderId).maybeSingle();
    const recipientId = conversationCounterpart(conversation, senderId, Boolean(sender?.is_super_admin));
    if (!recipientId || recipientId === senderId) return refuse("sender is not a conversation party");

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

    const results = await sendToAllDevices(tokens, fcmData, { highPriority: true });

    // تحديث حالة الرسالة إلى delivered إذا نجح الإرسال لجهاز واحد على الأقل
    if (results.some(r => r.ok)) {
      await supabase.from("messages").update({ status: "delivered" }).eq("id", messageId).eq("status", "sent");
    }

    return json({ sent: results.filter(r => r.ok).length, total: results.length, results });

  } catch (error: any) {
    console.error("send-push failed", error);
    return json({ error: error?.message || String(error) }, 500);
  }
});
