-- ============================================================================
-- Migration v3.0 — 2026-10-26
-- إشعارات الخلفية البسيطة عبر امتداد pg_net وتريگرات قاعدة البيانات (بلا Webhook يدوي وبلا Vault)
-- ----------------------------------------------------------------------------
-- تطابق هذه الهجرة إعدادات المشروع العامل البسيطة:
--   ✅ امتداد pg_net مفعّل في المخطط العام (Async HTTP)
--   ✅ تريگر send_fcm_on_new_message على جدول messages يستدعي handle_new_message_notification
--   ✅ دوال التريگر في المخطط العام (handle_new_message_notification /
--      handle_new_message_push / notify_new_message / notify_call_room /
--      notify_admins_new_profile) بصلاحية SECURITY DEFINER
--   ✅ الرابط الصحيح لدالة المشروع:
--      https://gqocavvhhfwgkzscrjms.supabase.co/functions/v1/send-push
--      (إصلاح الخطأ الإملائي القديم gqocavvhkfzgxzscrjms الذي كان يسبب فشل DNS)
--   ❌ لا حاجة لإنشاء Database Webhooks يدوياً من لوحة التحكم
--   ❌ لا حاجة لـ Supabase Vault أو جدول push_settings أو دوال المسبار المعقدة
--
-- آمنة لإعادة التنفيذ (idempotent) — لا تحذف أي بيانات محادثات أو مستخدمين.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 26.1 تنظيف البقايا المعقدة القديمة (دوال المسبار/Vault/push_settings)
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
-- 26.2 تفعيل امتداد pg_net (Async HTTP) — مطابق لإعدادات المشروع العامل
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    create extension if not exists pg_net with schema public;
  exception when others then
    begin
      create extension if not exists pg_net;
    exception when others then
      raise notice 'pg_net غير متاح في هذه البيئة (تخطّي): %', sqlerrm;
    end;
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 26.3 دوال وتريگرات إشعارات الخلفية البسيطة (SECURITY DEFINER + pg_net)
-- ---------------------------------------------------------------------------

-- (أ) إشعار الرسائل الجديدة — الدالة الأساسية للتريگر send_fcm_on_new_message
create or replace function public.handle_new_message_notification()
returns trigger
language plpgsql
security definer
set search_path = public, net, extensions
as $$
declare
  v_url text := 'https://gqocavvhhfwgkzscrjms.supabase.co/functions/v1/send-push';
  v_secret text := 'my_send_push_19921121_almgawell_19921121';
begin
  -- بطاقات المكالمات داخل جدول الرسائل يتكفّل بها تريگر call_rooms
  if coalesce(new.message_type, 'text') = 'call' then
    return new;
  end if;

  begin
    perform net.http_post(
      url := v_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-send-push-secret', v_secret
      ),
      body := jsonb_build_object(
        'type', 'INSERT',
        'table', 'messages',
        'schema', 'public',
        'record', to_jsonb(new),
        'message_id', new.id,
        'conversation_id', new.conversation_id,
        'sender_id', new.sender_id,
        'content', new.content,
        'message_type', coalesce(new.message_type, 'text'),
        'attachment_type', new.attachment_type
      ),
      timeout_milliseconds := 8000
    );
  exception when others then
    raise warning '[send_fcm_on_new_message] pg_net skipped: %', sqlerrm;
  end;

  return new;
end;
$$;

-- دوال مرادفة في المخطط العام للتوافق الكامل مع إعدادات المشروع العامل
create or replace function public.handle_new_message_push()
returns trigger
language plpgsql
security definer
set search_path = public, net, extensions
as $$
declare
  v_url text := 'https://gqocavvhhfwgkzscrjms.supabase.co/functions/v1/send-push';
  v_secret text := 'my_send_push_19921121_almgawell_19921121';
begin
  if coalesce(new.message_type, 'text') = 'call' then
    return new;
  end if;

  begin
    perform net.http_post(
      url := v_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-send-push-secret', v_secret
      ),
      body := jsonb_build_object(
        'type', 'INSERT',
        'table', 'messages',
        'schema', 'public',
        'record', to_jsonb(new),
        'message_id', new.id,
        'conversation_id', new.conversation_id,
        'sender_id', new.sender_id,
        'content', new.content,
        'message_type', coalesce(new.message_type, 'text'),
        'attachment_type', new.attachment_type
      ),
      timeout_milliseconds := 8000
    );
  exception when others then
    raise warning '[handle_new_message_push] pg_net skipped: %', sqlerrm;
  end;

  return new;
end;
$$;

create or replace function public.notify_new_message()
returns trigger
language plpgsql
security definer
set search_path = public, net, extensions
as $$
declare
  v_url text := 'https://gqocavvhhfwgkzscrjms.supabase.co/functions/v1/send-push';
  v_secret text := 'my_send_push_19921121_almgawell_19921121';
begin
  if coalesce(new.message_type, 'text') = 'call' then
    return new;
  end if;

  begin
    perform net.http_post(
      url := v_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-send-push-secret', v_secret
      ),
      body := jsonb_build_object(
        'type', 'INSERT',
        'table', 'messages',
        'schema', 'public',
        'record', to_jsonb(new),
        'message_id', new.id,
        'conversation_id', new.conversation_id,
        'sender_id', new.sender_id,
        'content', new.content,
        'message_type', coalesce(new.message_type, 'text'),
        'attachment_type', new.attachment_type
      ),
      timeout_milliseconds := 8000
    );
  exception when others then
    raise warning '[notify_new_message] pg_net skipped: %', sqlerrm;
  end;

  return new;
end;
$$;

-- (ب) إشعار المكالمات الواردة وانتهائها
create or replace function public.notify_call_room()
returns trigger
language plpgsql
security definer
set search_path = public, net, extensions
as $$
declare
  v_url text := 'https://gqocavvhhfwgkzscrjms.supabase.co/functions/v1/send-push';
  v_secret text := 'my_send_push_19921121_almgawell_19921121';
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
    perform net.http_post(
      url := v_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-send-push-secret', v_secret
      ),
      body := jsonb_build_object(
        'type', tg_op,
        'table', 'call_rooms',
        'schema', 'public',
        'record', to_jsonb(new),
        'old_record', case when tg_op = 'UPDATE' then to_jsonb(old) else null end,
        'room_id', new.id,
        'conversation_id', new.conversation_id,
        'caller_id', new.caller_id,
        'callee_id', new.callee_id,
        'call_type', new.call_type,
        'status', new.status
      ),
      timeout_milliseconds := 8000
    );
  exception when others then
    raise warning '[on_call_room_notify] pg_net skipped: %', sqlerrm;
  end;

  return new;
end;
$$;

-- (ج) إشعار المشرفين عند تسجيل مستخدم جديد
create or replace function public.notify_admins_new_profile()
returns trigger
language plpgsql
security definer
set search_path = public, net, extensions
as $$
declare
  v_url text := 'https://gqocavvhhfwgkzscrjms.supabase.co/functions/v1/send-push';
  v_secret text := 'my_send_push_19921121_almgawell_19921121';
begin
  begin
    perform net.http_post(
      url := v_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-send-push-secret', v_secret
      ),
      body := jsonb_build_object(
        'type', 'INSERT',
        'table', 'profiles',
        'schema', 'public',
        'record', to_jsonb(new),
        'user_id', new.id,
        'display_name', new.display_name,
        'email', new.email,
        'phone', new.phone
      ),
      timeout_milliseconds := 8000
    );
  exception when others then
    raise warning '[on_profile_created_notify_admins] pg_net skipped: %', sqlerrm;
  end;

  return new;
end;
$$;

-- سحب صلاحية الاستدعاء المباشر عبر RPC من الأدوار العامة
revoke all on function public.handle_new_message_notification() from public, anon, authenticated;
revoke all on function public.handle_new_message_push() from public, anon, authenticated;
revoke all on function public.notify_new_message() from public, anon, authenticated;
revoke all on function public.notify_call_room() from public, anon, authenticated;
revoke all on function public.notify_admins_new_profile() from public, anon, authenticated;

-- إنشاء التريگرات على الجداول (مطابق للصورة: send_fcm_on_new_message → handle_new_message_notification)
drop trigger if exists on_message_inserted on public.messages;
drop trigger if exists send_fcm_on_new_message on public.messages;
create trigger send_fcm_on_new_message
  after insert on public.messages
  for each row execute function public.handle_new_message_notification();

drop trigger if exists on_call_room_notify on public.call_rooms;
create trigger on_call_room_notify
  after insert or update on public.call_rooms
  for each row execute function public.notify_call_room();

drop trigger if exists on_profile_created_notify_admins on public.profiles;
create trigger on_profile_created_notify_admins
  after insert on public.profiles
  for each row execute function public.notify_admins_new_profile();

-- ---------------------------------------------------------------------------
-- 26.4 سجل التسليم (يكتبه Edge Function بـ service_role فقط)
-- ---------------------------------------------------------------------------
drop table if exists public.push_delivery_log cascade;

create table public.push_delivery_log (
  id bigint generated by default as identity primary key,
  kind text not null,                                -- new_message | incoming_call | call_ended | new_user | test | probe
  ref_id uuid,                                       -- message_id / room_id / profile_id
  recipient_id uuid,                                 -- المستلم الفعلي (فردي) — null للإشعار الجماعي
  source text not null default 'webhook',            -- webhook | trigger | manual
  sent integer not null default 0,                   -- أجهزة نجح إرسالها
  total integer not null default 0,                  -- أجهزة حاولنا الإرسال إليها
  skipped text,                                      -- سبب التخطي (إن وُجد)
  detail jsonb not null default '{}'::jsonb,         -- تفاصيل غير حسّاسة (بلا توكنات)
  created_at timestamptz not null default now()
);

comment on table public.push_delivery_log is
'سجل تسليم إشعارات FCM — يكتبه Edge Function send-push بـ service_role بعد كل حدث.';

create index if not exists idx_push_log_created_at on public.push_delivery_log (created_at desc);
create index if not exists idx_push_log_recipient on public.push_delivery_log (recipient_id, created_at desc);

alter table public.push_delivery_log enable row level security;

-- قراءة للمشرفين فقط؛ لا سياسات كتابة ⇒ لا يستطيع أي عميل التلاعب بالسجل.
drop policy if exists "push log superadmin read" on public.push_delivery_log;
drop policy if exists "push log admin read" on public.push_delivery_log;
create policy "push log admin read" on public.push_delivery_log
  for select using (public.is_admin_user() or public.is_super_admin_user());

-- تنظيف دوري (service_role / SQL Editor / pg_cron إن توفّر)
create or replace function public.prune_push_delivery_log(p_keep_days integer default 7)
returns integer language plpgsql security definer set search_path = public as $$
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
