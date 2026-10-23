-- ============================================================================
-- Migration v3.0 — إشعارات الخلفية عبر pg_net (نسخة التدقيق والاستقرار)
-- ----------------------------------------------------------------------------
-- المسار الوحيد المسموح:
--   tables → canonical Postgres triggers → net.http_post(POST) → send-push
--
-- قبل التنفيذ (مرة واحدة، خارج ملفات Git):
--   1) أنشئ في Vault القيمتين send_push_url وsend_push_secret.
--   2) اجعل send_push_secret مطابقاً تماماً للسرّ SEND_PUSH_SECRET في Edge Secrets.
--   3) send_push_url يجب أن ينتهي بـ /functions/v1/send-push.
--
-- لا توجد أسرار أو روابط مشاريع مكتوبة في هذا الملف. الهجرة تفشل بوضوح إذا كانت
-- إعدادات Vault ناقصة بدلاً من إنشاء تريغرات ترسل 401 بصمت.
-- آمنة لإعادة التنفيذ ولا تحذف push_delivery_log أو بيانات التطبيق.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 26.0 بوابة الإعداد: لا تُنشئ مساراً غير قابل للمصادقة
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('vault.decrypted_secrets') is null then
    raise exception 'send-push setup: Supabase Vault غير مفعّل (vault.decrypted_secrets غير موجود)';
  end if;

  if not exists (
    select 1 from vault.decrypted_secrets
    where name = 'send_push_url'
      and decrypted_secret ~ '^https://[^/]+/functions/v1/send-push/?$'
  ) then
    raise exception 'send-push setup: أضف send_push_url إلى Vault بالشكل https://<project-ref>.supabase.co/functions/v1/send-push';
  end if;

  if not exists (
    select 1 from vault.decrypted_secrets
    where name = 'send_push_secret'
      and length(decrypted_secret) >= 32
  ) then
    raise exception 'send-push setup: أضف send_push_secret (32+ حرفاً) إلى Vault وطابقه مع Edge Secret SEND_PUSH_SECRET';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 26.1 إزالة Webhooks القديمة والتريغرات المكررة
-- ----------------------------------------------------------------------------
-- Database Webhooks هي تريغرات supabase_functions.http_request. بعضها قد ضُبط
-- على GET؛ نحذف فقط الهوكات التي تستهدف send-push على الجداول المعنية. لا نحذف
-- أي Webhook آخر في المشروع. هذا يزيل أيضاً POST القديم حتى لا يتكرر الإشعار.
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select t.tgname, c.relname
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
  loop
    execute format('drop trigger if exists %I on public.%I', r.tgname, r.relname);
    raise notice 'Removed legacy send-push webhook trigger % on public.%', r.tgname, r.relname;
  end loop;
end $$;

-- إسقاط تريغراتنا القديمة قبل استبدال الدوال؛ CASCADE يزيل أي مرادف قديم مرتبط.
do $$
declare
  r record;
begin
  for r in
    select t.tgname, c.relname
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and not t.tgisinternal
      and t.tgname in (
        'on_message_inserted',
        'send_fcm_on_new_message',
        'on_call_room_notify',
        'on_profile_created_notify_admins'
      )
  loop
    execute format('drop trigger if exists %I on public.%I', r.tgname, r.relname);
  end loop;
end $$;

do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'send_push_post',
        'handle_new_message_notification', 'handle_new_message_push',
        'notify_new_message', 'notify_call_room', 'notify_admins_new_profile',
        'push_call_edge', 'trigger_send_push_notification',
        'push_probe', 'push_probe_result', 'push_probe_endpoint',
        'push_fire_probe', 'push_await_probe',
        'push_gateway_check', 'push_egress_check', 'push_net_diagnostics',
        'push_path_verdict', 'push_path_verdict_db',
        'push_delivery_url', 'push_set_delivery_url',
        'push_mode', 'push_set_mode',
        'push_recipient_allowed', 'push_skip_note',
        'conversation_direct_recipient', 'admin_recipient_ids',
        'push_diagnostics'
      )
  loop
    execute format('drop function if exists %s cascade', r.sig);
  end loop;
end $$;

drop table if exists public.push_settings cascade;

-- ---------------------------------------------------------------------------
-- 26.2 pg_net: الإنشاء يُنشئ مخطط net بنفسه؛ لا WITH SCHEMA public ولا ابتلاع خطأ
-- ---------------------------------------------------------------------------
create extension if not exists pg_net;

-- ---------------------------------------------------------------------------
-- 26.3 نقطة POST واحدة: القراءة من Vault والحمولة القياسية والترويستات الإلزامية
-- ---------------------------------------------------------------------------
create or replace function public.send_push_post(p_payload jsonb)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_secret text;
  v_request_id bigint;
begin
  select decrypted_secret into v_url
    from vault.decrypted_secrets
   where name = 'send_push_url'
   limit 1;

  select decrypted_secret into v_secret
    from vault.decrypted_secrets
   where name = 'send_push_secret'
   limit 1;

  if coalesce(v_url, '') !~ '^https://[^/]+/functions/v1/send-push/?$' then
    raise exception 'send-push: send_push_url في Vault غير صالح';
  end if;
  if length(coalesce(v_secret, '')) < 32 then
    raise exception 'send-push: send_push_secret في Vault مفقود أو أقصر من 32 حرفاً';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'send-push: payload يجب أن يكون JSON object';
  end if;

  select net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-send-push-secret', v_secret
    ),
    body := p_payload,
    timeout_milliseconds := 10000
  ) into v_request_id;

  return v_request_id;
end;
$$;

revoke all on function public.send_push_post(jsonb) from public, anon, authenticated;

-- (أ) رسالة جديدة: لا حمولة مسطّحة ولا حقول مكررة؛ record هو الصف الكامل.
create or replace function public.handle_new_message_notification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- بطاقة المكالمة يملكها تريغر call_rooms حتى لا يصل إشعاران.
  if coalesce(new.message_type, 'text') = 'call' then
    return new;
  end if;

  begin
    perform public.send_push_post(jsonb_build_object(
      'type', 'INSERT',
      'table', 'messages',
      'schema', 'public',
      'record', to_jsonb(new),
      'old_record', null
    ));
  exception when others then
    -- لا نمنع حفظ الرسالة بسبب الإشعار؛ يظهر الخطأ في سجلات القاعدة للتدقيق.
    raise warning '[send_fcm_on_new_message] enqueue failed (%): %', sqlstate, sqlerrm;
  end;

  return new;
end;
$$;

-- (ب) مكالمة واردة أو انتقال إلى حالة نهائية.
create or replace function public.notify_call_room()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if coalesce(new.status, '') <> 'ringing' then
      return new;
    end if;
  elsif tg_op = 'UPDATE' then
    if new.status is not distinct from old.status then
      return new;
    end if;
    if coalesce(new.status, '') not in ('missed', 'ended', 'declined', 'failed', 'network_lost') then
      return new;
    end if;
  else
    return new;
  end if;

  begin
    perform public.send_push_post(jsonb_build_object(
      'type', tg_op,
      'table', 'call_rooms',
      'schema', 'public',
      'record', to_jsonb(new),
      'old_record', case when tg_op = 'UPDATE' then to_jsonb(old) else null end
    ));
  exception when others then
    raise warning '[on_call_room_notify] enqueue failed (%): %', sqlstate, sqlerrm;
  end;

  return new;
end;
$$;

-- (ج) إشعار المشرفين عند إنشاء ملف مستخدم جديد.
create or replace function public.notify_admins_new_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  begin
    perform public.send_push_post(jsonb_build_object(
      'type', 'INSERT',
      'table', 'profiles',
      'schema', 'public',
      'record', to_jsonb(new),
      'old_record', null
    ));
  exception when others then
    raise warning '[on_profile_created_notify_admins] enqueue failed (%): %', sqlstate, sqlerrm;
  end;

  return new;
end;
$$;

revoke all on function public.handle_new_message_notification() from public, anon, authenticated;
revoke all on function public.notify_call_room() from public, anon, authenticated;
revoke all on function public.notify_admins_new_profile() from public, anon, authenticated;

-- التريغرات الثلاثة القانونية فقط؛ لا مرادفات ولا Database Webhooks إضافية.
create trigger send_fcm_on_new_message
  after insert on public.messages
  for each row execute function public.handle_new_message_notification();

create trigger on_call_room_notify
  after insert or update on public.call_rooms
  for each row execute function public.notify_call_room();

create trigger on_profile_created_notify_admins
  after insert on public.profiles
  for each row execute function public.notify_admins_new_profile();

-- ---------------------------------------------------------------------------
-- 26.4 سجل التسليم: CREATE IF NOT EXISTS حتى لا تمحو إعادة الهجرة الأدلة
-- ---------------------------------------------------------------------------
create table if not exists public.push_delivery_log (
  id bigint generated by default as identity primary key,
  kind text not null,
  ref_id uuid,
  recipient_id uuid,
  source text not null default 'trigger',
  sent integer not null default 0,
  total integer not null default 0,
  skipped text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

comment on table public.push_delivery_log is
'سجل تسليم إشعارات FCM — تكتبه دالة send-push بصلاحية service_role بعد كل حدث.';

alter table public.push_delivery_log alter column source set default 'trigger';

create index if not exists idx_push_log_created_at on public.push_delivery_log (created_at desc);
create index if not exists idx_push_log_recipient on public.push_delivery_log (recipient_id, created_at desc);

alter table public.push_delivery_log enable row level security;

drop policy if exists "push log superadmin read" on public.push_delivery_log;
drop policy if exists "push log admin read" on public.push_delivery_log;
create policy "push log admin read" on public.push_delivery_log
  for select using (public.is_admin_user() or public.is_super_admin_user());

create or replace function public.prune_push_delivery_log(p_keep_days integer default 7)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_days integer := greatest(coalesce(p_keep_days, 7), 1);
  v_count integer := 0;
begin
  delete from public.push_delivery_log
   where created_at < now() - make_interval(days => v_days);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.prune_push_delivery_log(integer) from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.prune_push_delivery_log(integer) to service_role';
  end if;
end $$;
