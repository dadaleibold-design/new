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
//   PUSH_NORMAL_URGENCY   ("1" لإعادة الأولوية العادية)
//
// عقد الويب (v2026-10-13.2): كل دفعة ويب data-only — بلا webpush.notification.
// الإشعار المرئي يُبنى حصرياً في firebase-messaging-sw.js من حقول data، فيتطابق
// الشكل الذي يرسله الخادم مع الشكل الذي تقرؤه الـ SW تماماً، ولا يعرض Firebase
// SDK إشعاراً تلقائياً بحمولة مختلفة. نقرة الإشعار تُوجَّه من الـ SW (scope).
// APP_PUBLIC_URL لم يعد مطلوباً للويب (إن ضُبط فهو غير مستخدم).

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
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
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

/**
 * عقد الإرسال للويب (data-only):
 *   • الحمولة كلها في `data` (قيمها نصوص). الإشعار المرئي يبنيه الـ Service Worker
 *     في firebase-messaging-sw.js من هذه الحقول: title / body / icon / type / ...
 *   • لا `webpush.notification` ولا `notification` على المستوى الأعلى:
 *     - لا يعرض Firebase SDK إشعاراً تلقائياً بحمولة مختلفة عن حمولتنا.
 *     - الـ SW هو المصدر الوحيد للعرض، فيستوفي userVisibleOnly دائماً.
 *   • webpush.headers: Urgency/TTL فقط (تحكّم في التسليم، لا في العرض).
 *   • tag/renotify/requireInteraction/actions تُحدَّد في الـ SW (مصدر واحد).
 */
function buildWebPushHeaders(opts: { highPriority?: boolean }, urgent: boolean) {
  return {
    Urgency: urgent ? "high" : "normal",
    // رسائل المكالمات/الاختبار تنتهي بسرعة (لا فائدة من إيصالها متأخرة)
    TTL: opts.highPriority ? "60" : "86400",
  };
}

async function sendToFcm(
  token: string,
  data: Record<string, string>,
  opts: { highPriority?: boolean } = {},
) {
  const accessToken = await getFirebaseAccessToken();

  // أولوية عالية للكل: رسائل الدردشة رسائل مرئية للمستخدم يجب أن تصل فوراً،
  // والأولوية العادية (Urgency: normal) يجوز لمزوّد الدفع تأخيرها على جهاز
  // في وضع توفير الطاقة/Doze — وهو أحد أسباب "توقّف الإشعارات بعد فترة في
  // الخلفية". يمكن إرجاع السلوك القديم بمتغيّر البيئة PUSH_NORMAL_URGENCY=1.
  const urgent = Deno.env.get("PUSH_NORMAL_URGENCY") !== "1";

  const body: Record<string, unknown> = {
    token,
    data,
    android: {
      priority: urgent ? "high" : "normal",
      ttl: opts.highPriority ? "60s" : "86400s",
    },
    webpush: {
      headers: buildWebPushHeaders(opts, urgent),
    },
    apns: {
      headers: {
        "apns-priority": urgent ? "10" : "5",
        "apns-push-type": "alert",
      },
    },
  };

  const response = await fetch(
    `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(FIREBASE_PROJECT_ID!)}/messages:send`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message: body }),
    },
  );

  let details: any = null;
  try { details = await response.json(); } catch { /* empty response */ }
  return { ok: response.ok, status: response.status, details };
}

/* ------------------------------------------------------------------
 * تعدّد الأجهزة: كل جهاز مسجّل يملك صفاً في fcm_tokens (توكن FCM خاص به).
 * أي إشعار لمستخدم يُرسَل إلى كل توكنات حسابه — لا إلى أول توكن فقط.
 * ------------------------------------------------------------------ */

type DeviceRow = {
  id: string;
  token: string;
  platform?: string | null;
  device_id?: string | null;
  device_info?: Record<string, unknown> | null;
};
type SendResult = { ok: boolean; status: number; details: any };

const FCM_CONCURRENCY = 10;
const FCM_MAX_ATTEMPTS = 3;
const FCM_RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);

/**
 * كل توكنات الحساب النشطة (صف لكل جهاز/متصفح) بلا تكرار.
 * "نشط" = موجود في الجدول؛ التوكنات التي يرفضها FCM (UNREGISTERED…) تُحذف
 * تلقائياً عند الإرسال (sendToAllDevices → isDeadToken).
 */
async function loadDeviceTokens(userId: string): Promise<DeviceRow[]> {
  const { data, error } = await supabase
    .from("fcm_tokens")
    .select("id, token, platform, device_id, device_info")
    .eq("user_id", userId);
  if (error) throw error;

  const seen = new Set<string>();
  const rows: DeviceRow[] = [];
  for (const row of (data || []) as DeviceRow[]) {
    if (!row.token || seen.has(row.token)) continue;
    seen.add(row.token);
    rows.push(row);
  }

  // سجل تشخيصي: كم جهازاً سيستقبل الإشعار (بدون التوكنات نفسها)
  const devices = rows.map((r) =>
    `${r.platform || "?"}/${(r.device_id || r.id).slice(0, 8)}`
  );
  console.log(
    `[send-push] recipient=${userId.slice(0, 8)}… devices=${rows.length} [${devices.join(", ")}]`,
  );
  return rows;
}

/**
 * هل التوكن ميّت فعلاً (ألغى الجهاز التسجيل أو التوكن غير صالح بنيوياً)؟
 * لا نحذف عند INVALID_ARGUMENT عام: خطأ في الحمولة يُسقط توكنات الأجهزة كلها بالخطأ.
 */
function isDeadToken(status: number, details: any): boolean {
  if (status === 404) return true;
  const text = JSON.stringify(details || {});
  if (/UNREGISTERED|registration-token-not-registered|Requested entity was not found/i.test(text)) {
    return true;
  }
  return /not a valid FCM registration token/i.test(text);
}

/** إعادة محاولة للأخطاء العابرة (حد المعدّل 429 وأخطاء الخادم 5xx والشبكة) */
async function sendWithRetry(token: string, data: Record<string, string>, opts: any): Promise<SendResult> {
  let last: SendResult = { ok: false, status: 0, details: null };
  for (let attempt = 1; attempt <= FCM_MAX_ATTEMPTS; attempt++) {
    try {
      const result = await sendToFcm(token, data, opts);
      if (result.ok || !FCM_RETRY_STATUSES.has(result.status)) return result;
      last = result;
    } catch (error) {
      last = { ok: false, status: 0, details: { error: String(error) } };
    }
    if (attempt < FCM_MAX_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
    }
  }
  return last;
}

/** يرسل إلى كل الأجهزة بتوازٍ محدود، ويحذف التوكنات الميّتة فقط */
async function sendToAllDevices(rows: DeviceRow[], data: Record<string, string>, opts: any = {}) {
  const results: Array<{ tokenId: string; ok: boolean; status: number; removed: boolean; error?: string }> = [];

  for (let i = 0; i < rows.length; i += FCM_CONCURRENCY) {
    const chunk = rows.slice(i, i + FCM_CONCURRENCY);
    const settled = await Promise.all(
      chunk.map(async (row) => {
        const result = await sendWithRetry(row.token, data, opts);
        const removed = !result.ok && isDeadToken(result.status, result.details);
        if (removed) {
          const { error } = await supabase.from("fcm_tokens").delete().eq("id", row.id);
          if (error) console.warn("token prune failed:", error.message);
        }
        return {
          tokenId: row.id,
          ok: result.ok,
          status: result.status,
          removed,
          error: result.ok ? undefined : JSON.stringify(result.details || {}).slice(0, 300),
        };
      }),
    );
    results.push(...settled);
  }

  logDelivery(data.type || "unknown", results);
  return results;
}

/**
 * سجلات التشخيص في Supabase Logs (Edge Function logs):
 *   • ملخّص لكل دفعة: النوع + عدد النجاح/الفشل + عدد التوكنات المحذوفة.
 *   • سبب كل فشل (HTTP status + رسالة FCM) — لتعرف هل رفض FCM الدفعة أصلاً.
 * لا نطبع التوكنات نفسها (بيانات حسّاسة)، فقط معرّف الصف.
 */
function logDelivery(
  type: string,
  results: Array<{ tokenId: string; ok: boolean; status: number; removed: boolean; error?: string }>,
) {
  const sent = results.filter((r) => r.ok).length;
  const removed = results.filter((r) => r.removed).length;
  console.log(`[send-push] type=${type} sent=${sent}/${results.length} removed=${removed}`);
  for (const r of results) {
    if (r.ok) continue;
    console.warn(
      `[send-push] FCM rejected row=${r.tokenId} status=${r.status}${r.removed ? " (token pruned)" : ""} reason=${r.error || "unknown"}`,
    );
  }
}

async function getUserFromRequest(req: Request) {
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!bearer) return null;
  const { data, error } = await supabase.auth.getUser(bearer);
  if (error) return null;
  return data.user;
}

Deno.serve(async (req) => {
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
    console.log(`[send-push] request type=${String(input?.type || "message")}`);

    // --- إشعار تجريبي للمستخدم نفسه (يتطلب JWT المستخدم) ---
    if (input.type === "test") {
      const user = await getUserFromRequest(req);
      if (!user) return json({ error: "Unauthorized" }, 401);
      const tokens = await loadDeviceTokens(user.id);
      if (!tokens.length) return json({ error: "لا يوجد توكن مسجّل لهذا الحساب — فعّل الإشعارات أولاً." }, 404);
      const results = await sendToAllDevices(tokens, {
        type: "test",
        title: "✅ الإشعارات تعمل",
        body: "هذا إشعار تجريبي — إن وصلك والتطبيق مغلق فكل شيء سليم.",
        conversationId: "",
      }, { highPriority: true });
      const sent = results.filter((r) => r.ok).length;
      const firstError = results.find((r) => !r.ok)?.error;
      return json({ sent, total: results.length, results, error: sent ? undefined : `FCM رفض كل التوكنات: ${firstError || "unknown"}` }, 200);
    }

    if (!isAuthorized(req)) return json({ error: "Unauthorized: x-send-push-secret does not match SEND_PUSH_SECRET" }, 401);

    // --- مسبار من قاعدة البيانات (Trigger path) ---
    if (input.type === "probe") {
      const userId = String(input.user_id || "");
      if (!userId) return json({ error: "user_id required" }, 400);
      const tokens = await loadDeviceTokens(userId);
      if (!tokens.length) return json({ sent: 0, skipped: "no fcm token" });
      const results = await sendToAllDevices(tokens, {
        type: "test", title: "✅ مسار الخلفية يعمل",
        body: "وصل هذا الإشعار عبر قاعدة البيانات → send-push → FCM (نفس مسار الرسائل الحقيقية).",
        conversationId: "",
      }, { highPriority: true });
      return json({ sent: results.filter((x) => x.ok).length, total: results.length, results });
    }

    // --- إشعار مكالمة واردة / انتهاء مكالمة (يُستدعى من trigger على call_rooms) ---
    if (input.type === "incoming_call" || input.type === "call_ended") {
      const roomId = String(input.room_id || "");
      const calleeId = String(input.callee_id || "");
      const callerId = String(input.caller_id || "");
      if (!roomId || !calleeId || !callerId) return json({ error: "room_id, caller_id, callee_id are required" }, 400);

      const [{ data: caller }, tokens] = await Promise.all([
        supabase.from("profiles").select("display_name, avatar_url").eq("id", callerId).maybeSingle(),
        loadDeviceTokens(calleeId),
      ]);
      if (!tokens.length) return json({ sent: 0, skipped: "no fcm token" });

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

      const results = await sendToAllDevices(tokens, data, { highPriority: true });
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
    const [{ data: sender }, tokens] = await Promise.all([
      supabase.from("profiles").select("display_name").eq("id", senderId).maybeSingle(),
      loadDeviceTokens(recipientId),
    ]);
    if (!tokens.length) return json({ sent: 0, skipped: "no fcm token" });

    const title = sender?.display_name || "رسالة جديدة";
    const body = String(input.content || "📎 مرفق");
    const data = {
      type: "new_message",
      messageId,
      conversationId,
      senderId,
      title,
      body,
      // طابع زمني + معرّفات إضافية: تسمح للتطبيق بتجاهل إشعار قديم
      // (وصل بعد أن قرأ المستخدم الرسالة) وبربط الإشعار بالمحادثة بدقة.
      timestamp: String(Date.now()),
      messageType: String(input.message_type || input.attachment_type || "text"),
    };

    // كل أجهزة المستلم (تسجيل دخول على أكثر من هاتف = أكثر من توكن)
    const results = await sendToAllDevices(tokens, data);

    // ✓✓ رمادي (تم التسليم): نجاح إرسال الإشعار إلى جهاز واحد على الأقل
    // يعني أن الرسالة وصلت إلى جهاز المستلم عبر جهة الدفع.
    // يبقى التحديث محصوراً في الحالة 'sent' فلا يُنقص أبداً حالة أحدث.
    const delivered = results.some((item) => item.ok);
    if (delivered) {
      const { error: deliveredError } = await supabase
        .from("messages")
        .update({ status: "delivered" })
        .eq("id", messageId)
        .eq("status", "sent");
      if (deliveredError) console.warn("mark delivered failed:", deliveredError.message);
    }

    return json({
      sent: results.filter((item) => item.ok).length,
      total: results.length,
      removed: results.filter((item) => item.removed).length,
      delivered,
      results,
    });
  } catch (error) {
    console.error("send-push failed", error);
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
