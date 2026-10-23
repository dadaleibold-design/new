-- ============================================================================
-- tayba / send-push — تدقيق للقراءة فقط (لا يعرض الأسرار أو محتوى الرسائل)
-- نفّذ بعد إعداد Vault وتنفيذ هجرة pg_net المصححة.
-- ============================================================================

-- 1) الجاهزية: يجب أن تكون كل القيم true وأن يكون legacy_send_push_hooks = 0.
select
  exists (select 1 from pg_extension where extname = 'pg_net') as pg_net_installed,
  to_regclass('vault.decrypted_secrets') is not null as vault_available,
  exists (
    select 1 from vault.decrypted_secrets
    where name = 'send_push_url'
      and decrypted_secret ~ '^https://[^/]+/functions/v1/send-push/?$'
  ) as url_configured,
  exists (
    select 1 from vault.decrypted_secrets
    where name = 'send_push_secret' and length(decrypted_secret) >= 32
  ) as secret_configured,
  (
    select count(*)::integer
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and not t.tgisinternal
      and (c.relname, t.tgname) in (
        ('messages', 'send_fcm_on_new_message'),
        ('call_rooms', 'on_call_room_notify'),
        ('profiles', 'on_profile_created_notify_admins')
      )
  ) as canonical_trigger_count,
  (
    select count(*)::integer
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_proc p on p.oid = t.tgfoid
    join pg_namespace pn on pn.oid = p.pronamespace
    where n.nspname = 'public'
      and c.relname in ('messages', 'call_rooms', 'profiles')
      and not t.tgisinternal
      and pn.nspname = 'supabase_functions'
      and p.proname = 'http_request'
      and pg_get_triggerdef(t.oid) ilike '%/functions/v1/send-push%'
  ) as legacy_send_push_hooks;

-- 2) كل تريغر على الجداول الثلاثة. لا نعرض pg_get_triggerdef لأنه قد يحوي
--    ترويسات/أسراراً. راجع أي صف غير التريغرات القانونية ووظائف التطبيق المعروفة.
select
  c.relname as table_name,
  t.tgname as trigger_name,
  pn.nspname as function_schema,
  p.proname as function_name,
  case
    when pn.nspname = 'supabase_functions'
      and p.proname = 'http_request'
      and pg_get_triggerdef(t.oid) ilike '%/functions/v1/send-push%'
    then true else false
  end as targets_send_push,
  case
    when pn.nspname = 'supabase_functions'
      and p.proname = 'http_request'
      and pg_get_triggerdef(t.oid) ilike '%''GET''%'
    then true else false
  end as appears_to_use_get
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
join pg_namespace n on n.oid = c.relnamespace
join pg_proc p on p.oid = t.tgfoid
join pg_namespace pn on pn.oid = p.pronamespace
where n.nspname = 'public'
  and c.relname in ('messages', 'call_rooms', 'profiles')
  and not t.tgisinternal
order by c.relname, t.tgname;

-- 3) نتائج HTTP غير المتزامنة: 200 يعني أن الدالة قبلت الحدث، و401 يعني أن
--    البوابة/المصادقة رفضته. لا نختار content أو headers حتى لا نكشف بيانات حساسة.
select id, status_code, timed_out, error_msg, created
from net._http_response
order by created desc
limit 50;

-- 4) نتيجة المعالجة الفعلية داخل send-push. sent=0 مع skipped يشرح سبب التخطي.
select kind, ref_id, recipient_id, source, sent, total, skipped, detail, created_at
from public.push_delivery_log
order by created_at desc
limit 50;
