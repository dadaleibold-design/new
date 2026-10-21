/**
 * worker/send-push-relay.js — بوابة تسليم بديلة (Cloudflare Worker)
 * ================================================================
 * لماذا: بعض مشاريع Supabase لا تستطيع حاوية قاعدة البيانات فيها
 * الوصول إلى نطاق *.supabase.co (فشل DNS ⇒ "Couldn't resolve host name"
 * من pg_net). هذا الـ Worker يعمل من شبكة Cloudflare التي تصل إلى
 * دالة send-push، فيصبح بإمكان القاعدة التسليم عبر workers.dev.
 *
 * المسار بعد التفعيل:
 *   Database Trigger ➔ pg_net ➔ worker/send-push-relay ➔ Edge Function send-push
 *     ➔ FCM ➔ firebase-messaging-sw.js
 *
 * النشر (Wrangler):
 *   cd worker
 *   npx wrangler deploy
 *   npx wrangler secret put SEND_PUSH_SECRET     # نفس سرّ دالة send-push
 *   npx wrangler secret put SEND_PUSH_URL        # https://<ref>.supabase.co/functions/v1/send-push
 *
 * ثم وجّه القاعدة إلى الـ Worker (من SQL Editor أو service_role):
 *   select public.push_set_delivery_url('https://<worker>.workers.dev/');
 *
 * 🔒 الأمان:
 *   • يرفض أي طلب لا يحمل x-send-push-secret مطابقاً.
 *   • لا يمرّر أي ترويسة Authorization القادمة من القاعدة (تُبنى من خوادم
 *     Cloudflare ⇒ لا حاجة لـ JWT ولا apikey؛ دالة send-push منشورة
 *     بـ verify_jwt = false والتحقّق عبر السرّ المشترك فقط).
 *   • لا يسرّب أي سرّ في الردود.
 */

const DEFAULT_TARGET = "https://gqocavvhkfzgxzscrjms.supabase.co/functions/v1/send-push";

/** مقارنة ثابتة الزمن لتفادي هجمات توقيت المقارنة. */
function safeEqual(a, b) {
  const sa = String(a ?? "");
  const sb = String(b ?? "");
  if (sa.length !== sb.length) return false;
  let diff = 0;
  for (let i = 0; i < sa.length; i += 1) diff |= sa.charCodeAt(i) ^ sb.charCodeAt(i);
  return diff === 0;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "content-type, x-send-push-secret",
        },
      });
    }

    if (request.method !== "POST") {
      return json({ error: "method not allowed" }, 405);
    }

    const secret = env.SEND_PUSH_SECRET || "";
    const supplied = request.headers.get("x-send-push-secret") || "";

    if (!secret) return json({ error: "relay not configured (missing SEND_PUSH_SECRET)" }, 500);
    if (!safeEqual(supplied, secret)) return json({ error: "Unauthorized" }, 401);

    const target = env.SEND_PUSH_URL || DEFAULT_TARGET;
    const body = await request.text();

    let upstream;
    try {
      upstream = await fetch(target, {
        method: "POST",
        headers: {
          "Content-Type": request.headers.get("content-type") || "application/json",
          "x-send-push-secret": secret,
        },
        body,
      });
    } catch (e) {
      return json({ error: "upstream unreachable", detail: String(e?.message || e) }, 502);
    }

    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("content-type") || "application/json",
        "Access-Control-Allow-Origin": "*",
        "X-Relay-Target": target,
      },
    });
  },
};
