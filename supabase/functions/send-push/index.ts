// supabase/functions/send-push/index.ts
// Edge Function تُستدعى تلقائياً (عبر trigger + pg_net) عند إدراج رسالة جديدة.
// تُرسل Web Push للمستلم إن كان لديه اشتراك مسجّل في push_subscriptions.
//
// النشر:
//   supabase functions deploy send-push
//   supabase secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=mailto:you@example.com
//   supabase secrets set SUPABASE_SERVICE_ROLE_KEY=... SUPABASE_URL=...
//
// توليد مفاتيح VAPID (على جهازك، خارج هذه البيئة):
//   npx web-push generate-vapid-keys

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import webpush from "https://esm.sh/web-push@3.6.7";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") || "mailto:admin@example.com";

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

Deno.serve(async (req) => {
  try {
    const { message_id, conversation_id, sender_id, content } = await req.json();

    // حدد المستلم (الطرف الآخر في المحادثة)
    const { data: conv } = await supabase
      .from("conversations")
      .select("user_id, admin_id")
      .eq("id", conversation_id)
      .single();
    if (!conv) return new Response("conversation not found", { status: 404 });

    const recipientId = conv.user_id === sender_id ? conv.admin_id : conv.user_id;

    const { data: sender } = await supabase
      .from("profiles")
      .select("display_name")
      .eq("id", sender_id)
      .single();

    const { data: subs } = await supabase
      .from("push_subscriptions")
      .select("*")
      .eq("user_id", recipientId);

    if (!subs || !subs.length) {
      return new Response(JSON.stringify({ skipped: "no subscription" }), { status: 200 });
    }

    const payload = JSON.stringify({
      title: sender?.display_name || "رسالة جديدة",
      body: content || "📎 مرفق",
      conversationId: conversation_id,
      messageId: message_id,
    });

    const results = await Promise.allSettled(
      subs.map((s) =>
        webpush.sendNotification(
          {
            endpoint: s.endpoint,
            keys: { p256dh: s.p256dh, auth: s.auth },
          },
          payload
        )
      )
    );

    // احذف الاشتراكات المنتهية الصلاحية (410/404)
    await Promise.all(
      results.map(async (r, i) => {
        if (r.status === "rejected") {
          const status = (r.reason && r.reason.statusCode) || 0;
          if (status === 410 || status === 404) {
            await supabase.from("push_subscriptions").delete().eq("id", subs[i].id);
          }
        }
      })
    );

    return new Response(JSON.stringify({ sent: results.length }), { status: 200 });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});
