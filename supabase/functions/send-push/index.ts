// supabase/functions/send-push/index.ts
// Sends Firebase Cloud Messaging notifications for newly inserted messages.
//
// أنواع الطلبات المدعومة:
//   • (افتراضي) رسالة جديدة        — message_id / conversation_id / sender_id
//   • test                          — إشعار تجريبي للمستخدم الحالي (JWT)
//   • probe                         — مسبار مسار الخلفية من قاعدة البيانات
//   • incoming_call / call_ended    — من trigger على call_rooms
//   • new_user                      — من trigger على profiles: يُشعر **كل المشرفين**
//                                     (is_admin أو is_super_admin غير محظورين) على
//                                     كل أجهزتهم بأن مستخدماً جديداً سجّل في النظام.
//
// كل الأسرار تُقرأ حصرياً من Deno.env.get() — لا مفتاح واحد داخل الكود:
//
// Required (one of the two Firebase forms):
//   • FIREBASE_SERVICE_ACCOUNT — كامل JSON لحساب الخدمة (يُفضّل: سرّ واحد)
//   • أو الحقول منفصلة: FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL +
//     FIREBASE_PRIVATE_KEY  (PEM؛ يدعم \n مُهرَّبة — يُعاد تحويلها لأسطر حقيقية)
//   SEND_PUSH_SECRET      — السرّ المشترك الذي يستخدمه trigger قاعدة البيانات
//                           (نفس قيمة Vault: SEND_PUSH_SECRET؛ والرابط المقابل
//                           محفوظ في Vault باسم SEND_PUSH_URL)
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
const SEND_PUSH_SECRET = Deno.env.get("SEND_PUSH_SECRET");

/** حقول حساب خدمة Firebase كما تظهر في ملف JSON الرسمي */
interface ServiceAccount {
  project_id?: string;
  client_email?: string;
  private_key?: string;
}

/**
 * يعيد مفتاح PEM إلى صيغته الصحيحة: الأسرار تُخزَّن غالباً في سطر واحد
 * مع `\n` مُهرَّبة، فيجب تحويلها إلى أسطر حقيقية قبل importPKCS8.
 */
function normalizePrivateKey(value?: string | null): string | undefined {
  const key = typeof value === "string" ? value.trim() : "";
  if (!key) return undefined;
  return key.replace(/\\n/g, "\n");
}

/**
 * يقرأ FIREBASE_SERVICE_ACCOUNT (JSON كامل) — ويدعم أيضاً تمريره Base64.
 * لا يُسجَّل أي جزء من قيمته في السجلات.
 */
function loadServiceAccount(): ServiceAccount {
  const raw = Deno.env.get("FIREBASE_SERVICE_ACCOUNT");
  if (!raw) return {};

  const attempts: string[] = [raw];
  if (!raw.trim().startsWith("{")) {
    try {
      attempts.push(atob(raw.trim()));
    } catch {
      /* ليست Base64 — نكتفي بالمحاولة الأولى */
    }
  }

  for (const candidate of attempts) {
    try {
      const parsed = JSON.parse(candidate) as ServiceAccount;
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      /* جرّب الصيغة التالية */
    }
  }

  console.error("[send-push] FIREBASE_SERVICE_ACCOUNT is not valid JSON — ignoring it");
  return {};
}

const SERVICE_ACCOUNT = loadServiceAccount();

const FIREBASE_PROJECT_ID = Deno.env.get("FIREBASE_PROJECT_ID") || SERVICE_ACCOUNT.project_id;
const FIREBASE_CLIENT_EMAIL = Deno.env.get("FIREBASE_CLIENT_EMAIL") || SERVICE_ACCOUNT.client_email;
const FIREBASE_PRIVATE_KEY = normalizePrivateKey(
  Deno.env.get("FIREBASE_PRIVATE_KEY") || SERVICE_ACCOUNT.private_key
);

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
}
if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) {
  throw new Error(
    "Firebase secrets are not configured: provide FIREBASE_SERVICE_ACCOUNT " +
      "(full service-account JSON) or FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY"
  );
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
  user_id?: string | null;
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
 * كل توكنات مجموعة مستخدمين في طلب واحد.
 * يُستخدم للإشعار الجماعي (مستخدم جديد → كل المشرفين) بدل طلب لكل مشرف.
 */
async function loadDeviceTokensForUsers(userIds: string[]): Promise<DeviceRow[]> {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  if (!ids.length) return [];

  const { data, error } = await supabase
    .from("fcm_tokens")
    .select("id, token, user_id, platform, device_id, device_info")
    .in("user_id", ids);
  if (error) throw error;

  const seen = new Set<string>();
  const rows: DeviceRow[] = [];
  for (const row of (data || []) as DeviceRow[]) {
    if (!row.token || seen.has(row.token)) continue;
    seen.add(row.token);
    rows.push(row);
  }

  const devicesByUser = new Map<string, number>();
  rows.forEach((r) => {
    const key = String(r.user_id || "?");
    devicesByUser.set(key, (devicesByUser.get(key) || 0) + 1);
  });
  console.log(
    `[send-push] bulk recipients=${ids.length} devices=${rows.length} ` +
      `[${[...devicesByUser.entries()].map(([u, n]) => `${u.slice(0, 8)}:${n}`).join(", ")}]`,
  );
  return rows;
}

/** كل المشرفين النشطين (غير المحظورين) — مستلمو إشعار "مستخدم جديد" */
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

    // --- إشعار المشرفين: مستخدم جديد سجّل في النظام (trigger على public.profiles) ---
    // طلب واحد من القاعدة → إشعار لكل المشرفين على كل أجهزتهم.
    if (input.type === "new_user") {
      const userId = String(input.user_id || "");
      if (!userId) return json({ error: "user_id required" }, 400);

      const adminIds = (await loadAdminIds()).filter((id) => id !== userId);
      if (!adminIds.length) {
        console.log("[send-push] new_user: لا يوجد مشرف نشط — تم تخطّي الإشعار");
        return json({ sent: 0, total: 0, admins: 0, skipped: "no admins" });
      }

      const name = String(input.display_name || "").trim() || "مستخدم جديد";
      const email = String(input.email || "").trim();
      const phone = String(input.phone || "").trim();
      const contact = email || phone;
      const isStaff = input.is_admin === true;

      const data: Record<string, string> = {
        type: "new_user",
        // مفتاح التوجيه: نقرة الإشعار تفتح (أو تُنشئ) محادثة مباشرة مع المستخدم الجديد
        userId,
        title: isStaff ? `🛡️ مشرف جديد: ${name}` : `👤 مستخدم جديد: ${name}`,
        body: contact
          ? `انضم إلى التطبيق — ${contact} — اضغط لبدء محادثة`
          : "انضم إلى التطبيق الآن — اضغط لبدء محادثة",
        createdAt: String(input.created_at || ""),
      };

      const tokens = await loadDeviceTokensForUsers(adminIds);
      if (!tokens.length) {
        console.log(
          `[send-push] new_user: admins=${adminIds.length} devices=0 (لم يُفعّل أي مشرف الإشعارات)`,
        );
        return json({ sent: 0, total: 0, admins: adminIds.length, skipped: "no fcm token" });
      }

      console.log(
        `[send-push] new_user user=${userId.slice(0, 8)}… admins=${adminIds.length} devices=${tokens.length}`,
      );
      // أولوية عالية: الإشعار يخص حدثاً لحظياً (مستخدم جديد الآن)
      const results = await sendToAllDevices(tokens, data, { highPriority: true });
      return json({
        admins: adminIds.length,
        sent: results.filter((r) => r.ok).length,
        total: results.length,
        removed: results.filter((r) => r.removed).length,
        results,
      });
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
