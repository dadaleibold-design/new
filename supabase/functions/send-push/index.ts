// supabase/functions/send-push/index.ts
// Sends Firebase Cloud Messaging notifications for newly inserted messages.
// Required Edge Function secrets:
//   FIREBASE_PROJECT_ID
//   FIREBASE_CLIENT_EMAIL
//   FIREBASE_PRIVATE_KEY  (the service-account PEM; escaped \n is supported)
//   SEND_PUSH_SECRET      (shared secret used by the database trigger)
// Optional:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { importPKCS8, SignJWT } from "https://esm.sh/jose@5.10.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const FIREBASE_PROJECT_ID = Deno.env.get("FIREBASE_PROJECT_ID");
const FIREBASE_CLIENT_EMAIL = Deno.env.get("FIREBASE_CLIENT_EMAIL");
const FIREBASE_PRIVATE_KEY = Deno.env.get("FIREBASE_PRIVATE_KEY")?.replace(/\\n/g, "\n");
const SEND_PUSH_SECRET = Deno.env.get("SEND_PUSH_SECRET");

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
}
if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) {
  throw new Error("Firebase service-account secrets are not configured");
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
const encoder = new TextEncoder();
let firebaseAccessToken: { value: string; expiresAt: number } | null = null;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function isAuthorized(req: Request) {
  if (!SEND_PUSH_SECRET) return false;
  const supplied = req.headers.get("x-send-push-secret");
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  return supplied === SEND_PUSH_SECRET || bearer === SEND_PUSH_SECRET || bearer === SERVICE_ROLE_KEY;
}

async function getFirebaseAccessToken() {
  if (firebaseAccessToken && firebaseAccessToken.expiresAt > Date.now() + 60_000) {
    return firebaseAccessToken.value;
  }

  const key = await importPKCS8(FIREBASE_PRIVATE_KEY!, "RS256");
  const now = Math.floor(Date.now() / 1000);
  const assertion = await new SignJWT({
    iss: FIREBASE_CLIENT_EMAIL,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
  })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(FIREBASE_CLIENT_EMAIL!)
    .setSubject(FIREBASE_CLIENT_EMAIL!)
    .setAudience("https://oauth2.googleapis.com/token")
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(key);

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!response.ok) throw new Error(`Google OAuth token request failed: ${response.status}`);

  const token = await response.json();
  firebaseAccessToken = {
    value: token.access_token,
    expiresAt: Date.now() + Number(token.expires_in || 3600) * 1000,
  };
  return firebaseAccessToken.value;
}

async function sendToFcm(token: string, data: Record<string, string>, opts: { highPriority?: boolean } = {}) {
  const accessToken = await getFirebaseAccessToken();
  const response = await fetch(
    `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(FIREBASE_PROJECT_ID!)}/messages:send`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: {
          token,
          // Data-only يمنع Firebase من إنشاء إشعار تلقائي بالتوازي مع
          // firebase-messaging-sw.js، وبالتالي لا تظهر إشعارات مزدوجة.
          data,
          // أولوية عالية + TTL قصير للمكالمات: توقظ الجهاز من Doze وتصل فوراً
          android: { priority: "high", ttl: opts.highPriority ? "60s" : "86400s" },
          webpush: {
            headers: {
              Urgency: opts.highPriority ? "high" : "normal",
              TTL: opts.highPriority ? "60" : "86400",
            },
          },
          apns: { headers: { "apns-priority": "10", "apns-push-type": "alert" } },
        },
      }),
    },
  );

  let details: any = null;
  try { details = await response.json(); } catch { /* empty response */ }
  return { ok: response.ok, status: response.status, details };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!isAuthorized(req)) return json({ error: "Unauthorized" }, 401);

  try {
    const input = await req.json();

    // --- إشعار مكالمة واردة / انتهاء مكالمة (يُستدعى من trigger على call_rooms) ---
    if (input.type === "incoming_call" || input.type === "call_ended") {
      const roomId = String(input.room_id || "");
      const calleeId = String(input.callee_id || "");
      const callerId = String(input.caller_id || "");
      if (!roomId || !calleeId || !callerId) return json({ error: "room_id, caller_id, callee_id are required" }, 400);

      const [{ data: caller }, { data: tokens, error: tokenError }] = await Promise.all([
        supabase.from("profiles").select("display_name, avatar_url").eq("id", callerId).maybeSingle(),
        supabase.from("fcm_tokens").select("id, token").eq("user_id", calleeId),
      ]);
      if (tokenError) throw tokenError;
      if (!tokens?.length) return json({ sent: 0, skipped: "no fcm token" });

      const isVideo = input.call_type === "video";
      const data: Record<string, string> = input.type === "incoming_call"
        ? {
            type: "incoming_call",
            roomId,
            conversationId: String(input.conversation_id || ""),
            callerId,
            callType: isVideo ? "video" : "audio",
            title: caller?.display_name || "مكالمة واردة",
            body: isVideo ? "📹 مكالمة فيديو واردة — اضغط للرد" : "📞 مكالمة صوتية واردة — اضغط للرد",
            icon: caller?.avatar_url || "",
          }
        : {
            type: "call_ended",
            roomId,
            conversationId: String(input.conversation_id || ""),
            missed: String(input.status === "missed"),
            title: input.status === "missed" ? `مكالمة فائتة من ${caller?.display_name || "مستخدم"}` : "انتهت المكالمة",
            body: isVideo ? "مكالمة فيديو فائتة" : "مكالمة صوتية فائتة",
            icon: caller?.avatar_url || "",
          };

      const results = await Promise.all(tokens.map(async (row) => {
        const result = await sendToFcm(row.token, data, { highPriority: true });
        const errorText = JSON.stringify(result.details || {});
        const invalid = result.status === 404 || result.status === 410 || /UNREGISTERED|registration-token-not-registered|INVALID_ARGUMENT/i.test(errorText);
        if (invalid) await supabase.from("fcm_tokens").delete().eq("id", row.id);
        return { tokenId: row.id, ok: result.ok, status: result.status, removed: invalid };
      }));
      return json({ sent: results.filter((r) => r.ok).length, total: results.length, results });
    }

    const messageId = String(input.message_id || "");
    const conversationId = String(input.conversation_id || "");
    const senderId = String(input.sender_id || "");
    if (!messageId || !conversationId || !senderId) {
      return json({ error: "message_id, conversation_id and sender_id are required" }, 400);
    }

    const { data: conversation, error: conversationError } = await supabase
      .from("conversations")
      .select("user_id, admin_id")
      .eq("id", conversationId)
      .single();
    if (conversationError || !conversation) return json({ error: "Conversation not found" }, 404);

    const recipientId = conversation.user_id === senderId ? conversation.admin_id : conversation.user_id;
    const [{ data: sender }, { data: tokens, error: tokenError }] = await Promise.all([
      supabase.from("profiles").select("display_name").eq("id", senderId).maybeSingle(),
      supabase.from("fcm_tokens").select("id, token").eq("user_id", recipientId),
    ]);
    if (tokenError) throw tokenError;
    if (!tokens?.length) return json({ sent: 0, skipped: "no fcm token" });

    const title = sender?.display_name || "رسالة جديدة";
    const body = String(input.content || "📎 مرفق");
    const data = {
      type: "new_message",
      messageId,
      conversationId,
      senderId,
      title,
      body,
    };

    const results = await Promise.all(tokens.map(async (row) => {
      const result = await sendToFcm(row.token, data);
      const errorText = JSON.stringify(result.details || {});
      const invalid = result.status === 404 || result.status === 410 || /UNREGISTERED|registration-token-not-registered|INVALID_ARGUMENT/i.test(errorText);
      if (invalid) {
        await supabase.from("fcm_tokens").delete().eq("id", row.id);
      }
      return { tokenId: row.id, ok: result.ok, status: result.status, removed: invalid };
    }));

    return json({ sent: results.filter((item) => item.ok).length, total: results.length, results });
  } catch (error) {
    console.error("send-push failed", error);
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
