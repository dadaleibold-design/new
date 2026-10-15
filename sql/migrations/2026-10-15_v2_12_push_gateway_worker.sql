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
--   1) Vault (للتريگرات — كما هي دون تغيير):
--        SEND_PUSH_URL    = رابط دالة send-push
--                           https://<project-ref>.supabase.co/functions/v1/send-push
--                           ⛔ لا توجّهها إلى workers.dev — ذلك يتجاوز طبقة الأمان.
--        SEND_PUSH_SECRET = السر المشترك (كما هو)
--        SUPABASE_ANON_KEY = مفتاح anon (كما هو — ترويسة Authorization للبوابة)
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
'بوابة الإشعارات من قاعدة البيانات: Trigger → pg_net → Edge Function send-push (الأمان والعزل) → Cloudflare Worker (توليد OAuth2/JWT والاتصال بـ FCM) → Firebase. Vault: SEND_PUSH_URL = رابط دالة send-push (ليس الـ Worker)، SEND_PUSH_SECRET = السر المشترك.';

-- ============================================================
-- تشخيص إعداد بوابة الإشعارات (v2.12)
-- يتحقق من أن Vault SEND_PUSH_URL يشير إلى دالة send-push (طبقة الأمان)
-- ولا يشير إلى الـ Worker مباشرة (خطأ شائع يتجاوز كل قواعد العزل).
-- لا يكشف أي قيمة سرّية — أعلام منطقية وتلميح نصي فقط.
-- ============================================================
create or replace function public.push_gateway_check()
returns jsonb language plpgsql security definer set search_path = public, vault as $$
declare
  v_url text;
  v_secret_set boolean;
  v_auth_set boolean;
begin
  select decrypted_secret into v_url
    from vault.decrypted_secrets where name = 'SEND_PUSH_URL' limit 1;

  select exists (
    select 1 from vault.decrypted_secrets
    where name = 'SEND_PUSH_SECRET' and coalesce(decrypted_secret, '') <> ''
  ) into v_secret_set;

  select exists (
    select 1 from vault.decrypted_secrets
    where name = 'SUPABASE_ANON_KEY' and coalesce(decrypted_secret, '') <> ''
  ) or exists (
    select 1 from vault.decrypted_secrets
    where name = 'SUPABASE_SERVICE_ROLE_KEY' and coalesce(decrypted_secret, '') <> ''
  ) into v_auth_set;

  return jsonb_build_object(
    'vault_url_set', coalesce(v_url, '') <> '',
    -- Vault SEND_PUSH_URL يجب أن يكون رابط دالة send-push (طبقة الأمان)
    'vault_url_is_edge_function', v_url like '%/functions/v1/send-push%',
    -- ⛔ خطأ إعداد: توجيه التريگرات إلى الـ Worker يتجاوز الأمان والعزل
    'vault_url_is_worker', v_url like '%workers.dev%',
    'vault_url_ok', coalesce(v_url, '') <> '' and v_url like '%/functions/v1/send-push%',
    'vault_secret_set', v_secret_set,
    'auth_key_set', v_auth_set,
    'chain', 'Database Trigger → Edge Function (أمان/عزل) → Cloudflare Worker → FCM → Service Worker',
    'gateway_hint', case
      when v_url like '%workers.dev%' then
        '⚠️ خطأ إعداد: Vault SEND_PUSH_URL يشير إلى الـ Worker مباشرة — هذا يتجاوز طبقة الأمان والعزل. أعد ضبطه على رابط دالة send-push، وضع رابط الـ Worker في أسرار الدالة (PUSH_GATEWAY_URL أو SEND_PUSH_URL).'
      when coalesce(v_url, '') = '' then
        '⚠️ Vault SEND_PUSH_URL غير مضبوط — لن تُرسل أي إشعارات من الـ Triggers.'
      when v_url not like '%/functions/v1/send-push%' then
        '⚠️ Vault SEND_PUSH_URL لا يبدو رابط دالة send-push — راجع الإعداد.'
      when not v_secret_set then
        '⚠️ Vault SEND_PUSH_SECRET غير مضبوط.'
      when not v_auth_set then
        '⚠️ لا SUPABASE_ANON_KEY ولا SUPABASE_SERVICE_ROLE_KEY في Vault — طلبات pg_net سترفض بـ 401 (fail-closed).'
      else
        '✅ المسار سليم: الـ Triggers تستدعي send-push (الأمان/العزل) والإرسال النهائي عبر الـ Worker.'
    end
  );
end;
$$;

revoke all on function public.push_gateway_check() from public;
grant execute on function public.push_gateway_check() to authenticated;
