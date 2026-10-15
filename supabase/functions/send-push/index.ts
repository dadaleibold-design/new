// supabase/functions/send-push/index.ts
// طبقة الأمان والتحقق للإشعارات — الإرسال الفعلي عبر Cloudflare Worker (Gateway).
//
// المسار الكامل (v2026-10-15.1):
//   Database Trigger (pg_net) ➔ Edge Function (التحقق والعزل) ➔ Cloudflare Worker
//   (بوابة FCM: توليد OAuth2/JWT والاتصال بـ Firebase) ➔ FCM ➔ firebase-messaging-sw.js
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
// 🔒 عزل المستلمين (v2.9) — نفس قواعد قاعدة البيانات، مُعاد التحقق منها هنا:
//   • الرسالة: المستلم = الطرف الآخر في **نفس صف المحادثة** (user_id ⇄ admin_id).
//     المرسل ليس طرفاً (مراقبة/مشاهدة) ⇒ يُرفض الطلب بلا أي إرسال.
//   • المكالمة: المستلم = **callee_id في غرفة المكالمة** المكتوبة في قاعدة
//     البيانات (لا من الحمولة وحدها). لا رنين لأي حساب آخر — ومنهم المشرف العام.
//   • new_user: هو الإشعار الجماعي الوحيد (كل المشرفين النشطين) ولا يقبل مستلماً واحداً.
//
// 🚪 بوابة الإرسال (v2026-10-15.1) — التعديل المعماري:
//   هذه الدالة لم تعد تتصل بـ FCM مباشرة ولا تولّد توكنات Google OAuth2/JWT
//   (أُزيلت getFirebaseAccessToken و sendToFcm ومعها اعتماد jose وحساب الخدمة).
//   لكل جهاز مستلم يُرسل POST واحد إلى Cloudflare Worker بالشكل:
//     { "token": "<FCM_DEVICE_TOKEN>", "title": "...", "body": "...", "data": { ... } }
//   (+ حقول اختيارية priority / ttlSeconds كتلميحات أولوية يحترمها الـ Worker إن
//    دعمها، ويجوز له تجاهلها دون كسر العقد.)
//   الـ Worker هو من يبني رسالة FCM HTTP v1 بنفس عقد الويب data-only
//   (v2026-10-13.2) ويوقّعها بحساب خدمة Firebase الخاص به.
//
// متغيرات البيئة (Deno.env.get فقط — لا سرّ واحد داخل الكود):
//   Required:
//     SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY — عميل Supabase الداخلي
//     SEND_PUSH_SECRET — السرّ المشترك الذي يستخدمه trigger قاعدة البيانات
//                        (نفس قيمة Vault: SEND_PUSH_SECRET)
//   Gateway (بوابة الـ Worker):
//     PUSH_GATEWAY_URL    — رابط الـ Cloudflare Worker (الأسمى والأوضح)
//     SEND_PUSH_URL       — بديل مقبول لرابط الـ Worker في أسرار الدالة نفسها
//                           (تنبيه: قيمة Vault بهذا الاسم تبقى رابط **هذه الدالة**
//                           لتستدعيها الـ Triggers — متجرّان مختلفان بقيمتين مختلفتين)
//     PUSH_GATEWAY_SECRET — سرّ مصادقة الـ Worker (Authorization: Bearer)؛
//                           إن لم يُضبَط يُستخدم SEND_PUSH_SECRET بديلاً.
//     ⛔ حارس حلقة: أي رابط يحوي /functions/v1/ يُرفض عند الإقلاع — لو توجّهت
//        الدالة إلى نفسها لتسبب ذلك في استدعاء لا نهائي (send-push ➔ send-push).
//   Optional:
//     PUSH_NORMAL_URGENCY ("1" لإعادة الأولوية العادية)
//
// أسرار Firebase (FIREBASE_SERVICE_ACCOUNT / FIREBASE_PROJECT_ID /
// FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY) لم تعد تُقرأ هنا إطلاقاً —
// انتقلت إلى الـ Worker (wrangler secret put ...) فهو طرف الاتصال بـ Google.
//
// عقد الويب (v2026-10-13.2): كل دفعة ويب data-only — بلا webpush.notification.
// الإشعار المرئي يُبنى حصرياً في firebase-messaging-sw.js من حقول data، فيتطابق
// الشكل الذي يرسله الخادم مع الشكل الذي تقرؤه الـ SW تماماً، ولا يعرض Firebase
// SDK إشعاراً تلقائياً بحمولة مختلفة. نقرة الإشعار تُوجَّه من الـ SW (scope).
// APP_PUBLIC_URL لم يعد مطلوباً للويب (إن ضُبط فهو غير مستخدم).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { fitFcmData } from "./payload.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const SEND_PUSH_SECRET = Deno.env.get("SEND_PUSH_SECRET");

/**
 * 🚪 رابط بوابة الإرسال (Cloudflare Worker) — يُقرأ من البيئة مع قيمة افتراضية معتمدة.
 * الترتيب: PUSH_GATEWAY_URL ثم SEND_PUSH_URL (كما ورد في أسرار الدالة) ثم الافتراضي.
 */
const DEFAULT_GATEWAY_URL = "https://nameless-dew-aac1.aabntlal680.workers.dev/";

function resolveGatewayUrl(): string {
  const candidate =
    Deno.env.get("PUSH_GATEWAY_URL")?.trim() ||
    Deno.env.get("SEND_PUSH_URL")?.trim() ||
    DEFAULT_GATEWAY_URL;

  if (!/^https?:\/\//i.test(candidate)) {
    throw new Error(
      "PUSH_GATEWAY_URL/SEND_PUSH_URL must be an absolute http(s) URL pointing to the Cloudflare Worker",
    );
  }
  // ⛔ حارس الحلقة: البوابة لا يجوز أن تكون دالة Supabase نفسها —
  // send-push ➔ send-push يعني إشعارات لا نهائية وفاتورة حسابية بلا نهاية.
  if (candidate.includes("/functions/v1/")) {
    throw new Error(
      "PUSH_GATEWAY_URL/SEND_PUSH_URL must point to the Cloudflare Worker, " +
        "not back to this Edge Function (/functions/v1/…) — that would create an infinite loop. " +
        "ملاحظة: قيمة Vault باسم SEND_PUSH_URL تبقى رابط هذه الدالة للـ Triggers، " +
        "أما أسرار الدالة (Edge Function Secrets) فتأخذ رابط الـ Worker.",
    );
  }
  return candidate;
}

/** سرّ مصادقة الـ Worker: PUSH_GATEWAY_SECRET إن وُجد، وإلا SEND_PUSH_SECRET */
function resolveGatewaySecret(): string {
  return (
    Deno.env.get("PUSH_GATEWAY_SECRET")?.trim() ||
    SEND_PUSH_SECRET?.trim() ||
    ""
  );
}

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
}

const GATEWAY_URL = resolveGatewayUrl();
const GATEWAY_SECRET = resolveGatewaySecret();

if (!SEND_PUSH_SECRET) {
  console.warn(
    "[send-push] SEND_PUSH_SECRET is not set — database triggers cannot authenticate (fail-closed)",
  );
}
if (!GATEWAY_SECRET) {
  // الـ Worker قد يقبل طلبات بلا مصادقة، لكن يُنصح بشدّة بضبط PUSH_GATEWAY_SECRET
  // ومطابقته في الـ Worker حتى لا تُفتح بوابة الدفع للعموم.
  console.warn(
    "[send-push] PUSH_GATEWAY_SECRET/SEND_PUSH_SECRET is not set — requests to the Cloudflare Worker will be sent WITHOUT an Authorization header",
  );
}
console.log(`[send-push] push gateway configured (${GATEWAY_URL})`);

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

/** أقصى عمر لدفعة رنين مكالمة (يطابق expire_stale_ringing_calls: دقيقتان) */
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

/* ------------------------------------------------------------------
 * 🚪 بوابة الإرسال: Cloudflare Worker
 * ------------------------------------------------------------------
 * عقد الطلب (لكل جهاز POST واحد):
 *   {
 *     "token":  "<FCM_DEVICE_TOKEN>",   // إلزامي
 *     "title":  "عنوان الإشعار",         // إلزامي (نسخة للعرض عند الحاجة)
 *     "body":   "نص الإشعار",            // إلزامي
 *     "data":   { ... }                  // إلزامي — مصدر الحقيقة للـ Service Worker
 *     "priority": "high" | "normal",     // اختياري (تلميح أولوية)
 *     "ttlSeconds": 60 | 86400           // اختياري (تلميح مدة صلاحية)
 *   }
 * عقد الاستجابة المتسامح:
 *   • 2xx ⇒ نجاح قبول/تسليم.
 *   • نص/JSON الاستجابة يُفحص لأنماط أخطاء توكن FCM (UNREGISTERED…) لحذف
 *     التوكنات الميّتة — راجع isDeadToken أدناه.
 * ------------------------------------------------------------------ */

async function sendToGateway(
  token: string,
  data: Record<string, string>,
  opts: { highPriority?: boolean } = {},
) {
  // أولوية عالية للكل: رسائل الدردشة رسائل مرئية للمستخدم يجب أن تصل فوراً،
  // والأولوية العادية (Urgency: normal) يجوز لمزوّد الدفع تأخيرها على جهاز
  // في وضع توفير الطاقة/Doze — وهو أحد أسباب "توقّف الإشعارات بعد فترة في
  // الخلفية". يمكن إرجاع السلوك القديم بمتغيّر البيئة PUSH_NORMAL_URGENCY=1.
  const urgent = Deno.env.get("PUSH_NORMAL_URGENCY") !== "1";

  // لا تجعل رسالة دردشة طويلة تتجاوز حد FCM وتفشل الدفعة كاملة.
  // البيانات تظل data-only؛ الـ Service Worker هو المسؤول الوحيد عن العرض.
  const fittedData = fitFcmData(data);

  const body: Record<string, unknown> = {
    token,
    title: fittedData.title || "",
    body: fittedData.body || "",
    data: fittedData,
    // تلميحات اختيارية: الـ Worker يترجمها إلى android.priority / apns-priority /
    // Urgency / TTL في رسالة FCM HTTP v1. تجاهلها لا يكسر العقد.
    priority: urgent ? "high" : "normal",
    ttlSeconds: opts.highPriority ? 60 : 86400,
  };

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (GATEWAY_SECRET) {
    // ترويستان متكافئتان: Authorization القياسية + ترويسة السر المشترك،
    // ليقبل الـ Worker أيّ أسلوب تحقق يعتمده.
    headers["Authorization"] = `Bearer ${GATEWAY_SECRET}`;
    headers["x-send-push-secret"] = GATEWAY_SECRET;
  }

  const response = await fetch(GATEWAY_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    // مهلة قصوى لكل جهاز: دفعة الإرسال لا يجوز أن تتعطل بجهازٍ بلا جواب
    signal: AbortSignal.timeout(10_000),
  });

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
 * 🔒 المستلم المباشر لرسالة داخل محادثة — من نفس صف المحادثة وحده:
 *   المرسل user_id ⇒ المستلم admin_id، والعكس صحيح.
 * المرسل ليس طرفاً في المحادثة (مشاهدة/مراقبة المشرف العام) ⇒ null
 * (لا إشعار لأي جهة — حتى لا يتحوّل جهاز المراقب إلى جهاز تنبيهات).
 */
function conversationCounterpart(
  conversation: { user_id?: string | null; admin_id?: string | null } | null | undefined,
  senderId: string,
  senderIsSuperAdmin = false,
): string | null {
  if (!conversation || !senderId) return null;
  if (conversation.user_id === senderId) return conversation.admin_id || null;
  if (conversation.admin_id === senderId) return conversation.user_id || null;
  // v2.13: المرسل مشرف عام وليس طرفاً في المحادثة ⇒ المستلم = المستخدم صاحب
  // المحادثة (العميل المنتظر للجواب) — مطابق لبوابة قاعدة البيانات.
  if (senderIsSuperAdmin) return conversation.user_id || null;
  return null;
}

/**
 * 🔒 رفض مكتوم: لا إشعار ولا طلب إرسال — يُعاد السبب للـ Trigger (يُسجَّل في
 * push_delivery_log من جهة قاعدة البيانات إن مرّ بها الطلب).
 */
function refuse(reason: string, status = 200) {
  console.warn(`[send-push] notification refused: ${reason}`);
  return json({ sent: 0, total: 0, skipped: reason }, status);
}

/**
 * هل التوكن ميّت فعلاً (ألغى الجهاز التسجيل أو التوكن غير صالح بنيوياً)؟
 * عبر البوابة لم نعد نعتبر 404 وحدها دليلاً على توكن ميّت: الـ Worker قد يرد
 * 404 لمسار/توجيه خاطئ، وحذف كل التوكنات بسبب خطأ توجيه كارثي. نحذف فقط عند:
 *   • 410 Gone (دليل نهائي)، أو
 *   • نص استجابة يطابق أنماط رفض توكن FCM الصريحة.
 */
function isDeadToken(status: number, details: any): boolean {
  if (status === 410) return true;
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
      const result = await sendToGateway(token, data, opts);
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
 *   • سبب كل فشل (HTTP status + رسالة البوابة/FCM) — لتعرف هل رفضت البوابة
 *     أو FCM الدفعة أصلاً. لا نطبع التوكنات نفسها (بيانات حسّاسة)، فقط معرّف الصف.
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
      `[send-push] gateway/FCM rejected row=${r.tokenId} status=${r.status}${r.removed ? " (token pruned)" : ""} reason=${r.error || "unknown"}`,
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
      return json({ sent, total: results.length, results, error: sent ? undefined : `البوابة رفضت كل التوكنات: ${firstError || "unknown"}` }, 200);
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
        body: "وصل هذا الإشعار عبر قاعدة البيانات → send-push → Cloudflare Worker → FCM (نفس مسار الرسائل الحقيقية).",
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

      // 🔒 مصدر الحقيقة هو غرفة المكالمة في قاعدة البيانات — لا الحمولة وحدها.
      // الرنين يذهب إلى callee_id المسجَّل في الغرفة، ولا شيء غيره إطلاقاً
      // (لا سوبر أدمن ولا مشرفين آخرين ولا أي حساب غير المعني بالمكالمة).
      const { data: room, error: roomError } = await supabase
        .from("call_rooms")
        .select("id, caller_id, callee_id, status")
        .eq("id", roomId)
        .maybeSingle();
      if (roomError) return json({ error: "Call room lookup failed" }, 500);
      if (!room) return refuse("call room not found", 404);
      if (String(room.callee_id || "") !== calleeId) return refuse("callee mismatch", 409);

      // 🔔 لا رنين إلا لمكالمة ما زالت ترنّ فعلاً. مكالمة أُجيبت/رُفضت/انتهت/فاتت
      //    بالفعل لا يجوز أن تُرسل دفعة رنين متأخرة (مثلاً إعادة محاولة trigger).
      //    الرد 200 لا خطأ: الحالة المتوقعة، لا تُعاد المحاولة.
      if (input.type === "incoming_call") {
        if (String(room.status || "") !== "ringing") return refuse("call not ringing", 200);
        // نافذة حداثة من ساعة الخادم/قاعدة البيانات (لا ساعة الجهاز): تطابق
        // expire_stale_ringing_calls (دقيقتان). الغرفة الأقدم لا ترنّ.
        const { data: timing } = await supabase
          .from("call_rooms")
          .select("started_at")
          .eq("id", roomId)
          .maybeSingle();
        const startedMs = Date.parse(String(timing?.started_at || ""));
        if (Number.isFinite(startedMs) && Date.now() - startedMs > CALL_RING_MAX_AGE_MS) {
          return refuse("call ring window expired", 200);
        }
      }

      const recipientId = String(room.callee_id || "");
      const resolvedCallerId = String(room.caller_id || callerId);
      if (!recipientId || recipientId === resolvedCallerId) return refuse("invalid call parties", 400);
      // تصريح قاعدة البيانات بالمستلم (v2.9) — أي تباين يعني طلباً مُلفَّقاً ⇒ رفض
      const declaredRecipient = String(input.recipient_id || "");
      if (declaredRecipient && declaredRecipient !== recipientId) return refuse("recipient mismatch", 409);

      const [{ data: caller }, tokens] = await Promise.all([
        supabase.from("profiles").select("display_name, avatar_url").eq("id", resolvedCallerId).maybeSingle(),
        loadDeviceTokens(recipientId),
      ]);
      if (!tokens.length) return json({ sent: 0, skipped: "no fcm token" });

      const isVideo = input.call_type === "video";
      const data: Record<string, string> = input.type === "incoming_call"
        ? {
            type: "incoming_call",
            roomId,
            conversationId: String(input.conversation_id || ""),
            callerId: resolvedCallerId,
            calleeId: recipientId,
            callType: isVideo ? "video" : "audio",
            title: caller?.display_name || "مكالمة واردة",
            body: isVideo ? "📹 مكالمة فيديو واردة — اضغط للرد" : "📞 مكالمة صوتية واردة — اضغط للرد",
            icon: caller?.avatar_url || "",
          }
        : {
            type: "call_ended",
            roomId,
            conversationId: String(input.conversation_id || ""),
            calleeId: recipientId,
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
      .maybeSingle();
    if (conversationError) return json({ error: "Conversation lookup failed" }, 500);
    if (!conversation) return json({ error: "Conversation not found" }, 404);

    // 🔒 عزل المستلم: الطرف الآخر في نفس المحادثة حصراً (user_id ⇄ admin_id).
    // v2.13: المرسل مشرف عام يردّ في محادثة ليست طرفاً فيها ⇒ المستلم =
    // المستخدم صاحب المحادثة (مطابق لبوابة قاعدة البيانات). أي مرسل آخر
    // ليس طرفاً ⇒ لا إشعار لأي جهة (وضع المراقبة/الانتحال).
    // نقرأ is_super_admin من الملف الشخصي (مصدر الحقيقة) لا من الحمولة.
    const { data: sender } = await supabase
      .from("profiles")
      .select("display_name, is_super_admin")
      .eq("id", senderId)
      .maybeSingle();
    const senderIsSuperAdmin = Boolean(sender?.is_super_admin);
    const recipientId = conversationCounterpart(conversation, senderId, senderIsSuperAdmin);
    if (!recipientId || recipientId === senderId) return refuse("sender is not a conversation party");
    // تصريح قاعدة البيانات بالمستلم (v2.9) — أي تباين يعني طلباً مُلفَّقاً ⇒ رفض
    const declaredRecipient = String(input.recipient_id || "");
    if (declaredRecipient && declaredRecipient !== recipientId) return refuse("recipient mismatch", 409);

    const tokens = await loadDeviceTokens(recipientId);
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
    // يعني أن الرسالة وصلت إلى جهاز المستلم عبر البوابة وجهة الدفع.
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
