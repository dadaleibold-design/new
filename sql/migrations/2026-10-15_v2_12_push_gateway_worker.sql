-- ============================================================
-- Migration v2.12 (2026-10-15) — بوابة الإرسال عبر Cloudflare Worker
-- ------------------------------------------------------------
-- التعديل المعماري: نقل الاتصال المباشر بـ FCM وتوليد توكنات Google
-- OAuth2/JWT من Edge Function `send-push` إلى Cloudflare Worker:
--   https://nameless-dew-aac1.aabntlal680.workers.dev/
--
-- المسار الكامل بعد التعديل:
--   Database Trigger ➔ Edge Function send-push (الأمان والعزل)
--     ➔ Cloudflare Worker (بوابة FCM) ➔ Firebase ➔ firebase-messaging-sw.js
--
-- هذه الهجرة **لا تغيّر منطق الـ Triggers إطلاقاً** — فهي توثّق البنية
-- وتضيف دالة تشخيص للتأكد من سلامة الإعداد. المنطق الجديد كله في الـ
-- Edge Function نفسه (يُنشر بـ `supabase functions deploy send-push`).
--
-- إعداد المتغيرات بعد النشر:
--   1) التريگرات (منذ v2.15 — بلا Vault، القيم مُضمَّنة في الكود):
--        SEND_PUSH_URL    = رابط دالة send-push
--                           https://<project-ref>.supabase.co/functions/v1/send-push
--                           ⛔ لا توجّهها إلى workers.dev — ذلك يتجاوز طبقة الأمان.
--        SEND_PUSH_SECRET = السر المشترك (كما هو)
--        (لا SUPABASE_ANON_KEY — الدالة verify_jwt = false فلا ترويسة Authorization)
--   2) أسرار دالة send-push (Edge Function Secrets):
--        PUSH_GATEWAY_URL    = https://nameless-dew-aac1.aabntlal680.workers.dev/
--        PUSH_GATEWAY_SECRET = سرّ مصادقة الـ Worker (Authorization: Bearer)
--        (SEND_PUSH_URL مقبول بديلاً لـ PUSH_GATEWAY_URL داخل أسرار الدالة،
--         وحين لا يوجد PUSH_GATEWAY_SECRET يُستخدم SEND_PUSH_SECRET بديلاً)
--   3) في الـ Worker نفسه (wrangler secret put ...):
--        FIREBASE_SERVICE_ACCOUNT (أو FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL
--        + FIREBASE_PRIVATE_KEY) — فهو الآن الطرف الذي يوقّع طلبات FCM.
-- آمنة لإعادة التنفيذ (idempotent).
-- ============================================================

-- توثيق دالة بوابة الإشعارات (التوقيع والمنطق دون تغيير)
comment on function public.push_call_edge(text, uuid, uuid, jsonb) is
'بوابة الإشعارات من قاعدة البيانات: Trigger → pg_net → Edge Function send-push (الأمان والعزل) → Cloudflare Worker (توليد OAuth2/JWT والاتصال بـ FCM) → Firebase. منذ v2.15: رابط دالة send-push والسرّ مُضمَّنان مباشرةً — بلا Vault.';

-- ============================================================
-- تشخيص إعداد بوابة الإشعارات (v2.12)
-- يتحقق من أن الرابط المُضمَّن يشير إلى دالة send-push (طبقة الأمان)
-- ولا يشير إلى الـ Worker مباشرة (خطأ شائع يتجاوز كل قواعد العزل).
-- لا يكشف أي قيمة سرّية — أعلام منطقية وتلميح نصي فقط.
-- ============================================================
create or replace function public.push_gateway_check()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_url text := 'https://gqocavvhkfzgxzscrjms.supabase.co/functions/v1/send-push';
begin
  return jsonb_build_object(
    'url', v_url,
    'url_hardcoded', true,
    'url_is_edge_function', v_url like '%/functions/v1/send-push%',
    'url_is_worker', coalesce(v_url, '') like '%workers.dev%',
    'url_ok', coalesce(v_url, '') like '%/functions/v1/send-push%',
    'secret_hardcoded', true,
    'vault_dependency', false,
    'chain', 'Database Trigger → pg_net (http_post غير متزامن) → Edge Function send-push (رابط وسرّ مُضمَّنان — verify_jwt = false) → FCM HTTP v1 → Service Worker',
    'gateway_hint', case
      when coalesce(v_url, '') like '%workers.dev%' then
        '⚠️ الرابط المُضمَّن يشير إلى الـ Worker مباشرة — يجب أن يشير إلى دالة send-push.'
      when coalesce(v_url, '') = '' then
        '⚠️ الرابط المُضمَّن فارغ — لن تُرسل إشعارات الـ Triggers.'
      when v_url not like '%/functions/v1/send-push%' then
        '⚠️ الرابط المُضمَّن يجب أن يشير إلى Edge Function send-push.'
      else
        '✅ المسار سليم: التريگرات تستدعي send-push برابط وسرّ مُضمَّنين بلا Vault.'
    end
  );
end;
$$;

revoke all on function public.push_gateway_check() from public;
grant execute on function public.push_gateway_check() to authenticated;
