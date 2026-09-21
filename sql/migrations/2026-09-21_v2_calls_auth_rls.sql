-- ============================================================
-- Migration v2 — 2026-09-21
-- المكالمات داخل المحادثة، إشعارات المكالمات في الخلفية، مصادقة
-- (هاتف للمستخدم / بريد للمشرف)، وتشديد RLS لأزرار المشرفين.
-- آمن لإعادة التنفيذ (idempotent). نفّذه في SQL Editor بعد schema.sql
-- أو نفّذ schema.sql كاملاً (يتضمّن هذا القسم رقم 11).
-- ============================================================

-- ------------------------------------------------------------
-- 11.1 أعمدة سجل المكالمات على جدول الرسائل
-- ------------------------------------------------------------
alter table public.messages add column if not exists message_type text not null default 'text';
alter table public.messages add column if not exists call_id uuid;
alter table public.messages add column if not exists call_type text;
alter table public.messages add column if not exists call_status text;
alter table public.messages add column if not exists call_caller_id uuid references public.profiles(id) on delete set null;
alter table public.messages add column if not exists call_duration_seconds integer;
alter table public.messages add column if not exists buttons jsonb;

alter table public.messages drop constraint if exists messages_message_type_check;
alter table public.messages
  add constraint messages_message_type_check check (message_type in ('text', 'call', 'system'));

alter table public.messages drop constraint if exists messages_call_status_check;
alter table public.messages
  add constraint messages_call_status_check check (
    call_status is null or call_status in ('ended', 'missed', 'declined', 'failed', 'network_lost')
  );

create unique index if not exists idx_messages_call_id_unique
  on public.messages(call_id) where call_id is not null;

-- فهرس يخدم المزامنة التفاضلية (delta sync) والترقيم التنازلي
create index if not exists idx_messages_conversation_created_desc
  on public.messages(conversation_id, created_at desc);

-- ------------------------------------------------------------
-- 11.2 المصادقة: الهاتف للمستخدم العادي، البريد للمشرف
--      العميل يشتق بريداً داخلياً phone.<digits>@users.local لمصادقة
--      Supabase؛ الـ trigger يخفيه عن profiles.email ويحفظ الرقم الحقيقي.
-- ------------------------------------------------------------
alter table public.profiles alter column email drop not null;
alter table public.profiles add column if not exists phone text;
alter table public.profiles add column if not exists is_blocked boolean not null default false;
alter table public.profiles add column if not exists blocked_at timestamptz;
alter table public.profiles add column if not exists is_super_admin boolean not null default false;

create unique index if not exists idx_profiles_phone_unique
  on public.profiles(phone) where phone is not null and phone <> '';

create or replace function public.is_internal_phone_email(p_email text)
returns boolean language sql immutable as $$
  select coalesce(p_email, '') ~* '^phone\.[0-9]+@users\.local$';
$$;

create or replace function public.normalize_phone(p_phone text)
returns text language sql immutable as $$
  select nullif(regexp_replace(coalesce(p_phone, ''), '[^0-9+]', '', 'g'), '');
$$;

-- is_super_admin_email قد لا تكون موجودة في قواعد قديمة
create or replace function public.is_super_admin_email(p_email text)
returns boolean language sql immutable as $$
  select lower(trim(coalesce(p_email, ''))) in ('almgawell17@gmail.com');
$$;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_email text := lower(trim(coalesce(new.email, '')));
  v_internal boolean := public.is_internal_phone_email(v_email);
  v_phone text := public.normalize_phone(coalesce(new.raw_user_meta_data->>'phone', new.phone));
  v_name text;
begin
  -- استخرج الرقم من البريد الداخلي إن لم يُرسل في metadata
  if v_phone is null and v_internal then
    v_phone := regexp_replace(v_email, '^phone\.([0-9]+)@.*$', '\1');
  end if;

  v_name := coalesce(
    nullif(trim(new.raw_user_meta_data->>'display_name'), ''),
    case when v_internal then v_phone else split_part(coalesce(new.email, new.phone, 'user'), '@', 1) end
  );

  insert into public.profiles (id, email, phone, display_name, is_admin, is_super_admin)
  values (
    new.id,
    case when v_internal or v_email = '' then null else v_email end,
    v_phone,
    v_name,
    (not v_internal) and (public.is_admin_email(v_email) or public.is_super_admin_email(v_email)),
    (not v_internal) and public.is_super_admin_email(v_email)
  )
  on conflict (id) do update
    set phone = coalesce(excluded.phone, public.profiles.phone),
        display_name = coalesce(public.profiles.display_name, excluded.display_name),
        is_super_admin = public.profiles.is_super_admin or excluded.is_super_admin,
        is_admin = public.profiles.is_admin or excluded.is_admin;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- تنظيف: حسابات أُنشئت قبل هذه الهجرة ببريد داخلي مكشوف
update public.profiles
set phone = coalesce(phone, regexp_replace(email, '^phone\.([0-9]+)@.*$', '\1')),
    email = null,
    is_admin = false,
    is_super_admin = false
where public.is_internal_phone_email(email);

-- أي حساب بريده ليس ضمن قائمة المشرفين لا يمكن أن يكون مشرفاً
update public.profiles
set is_admin = false, is_super_admin = false
where is_admin = true
  and not (public.is_admin_email(email) or public.is_super_admin_email(email));

-- ------------------------------------------------------------
-- 11.3 دوال المشرفين: حظر/إلغاء حظر وحذف المستخدم (SECURITY DEFINER)
--      تتحقق من صلاحية المستدعي داخلياً — لا يمكن لغير المشرف تنفيذها.
-- ------------------------------------------------------------
create or replace function public.is_admin_user(p_user_id uuid default auth.uid())
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = p_user_id and (is_admin = true or is_super_admin = true) and is_blocked = false
  );
$$;

create or replace function public.admin_set_user_blocked(p_user_id uuid, p_blocked boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin_user() then
    raise exception 'غير مصرّح: هذه العملية للمشرفين فقط' using errcode = '42501';
  end if;
  if exists (select 1 from public.profiles where id = p_user_id and (is_admin or is_super_admin)) then
    raise exception 'لا يمكن حظر حساب مشرف' using errcode = '42501';
  end if;
  update public.profiles
  set is_blocked = p_blocked,
      blocked_at = case when p_blocked then now() else null end,
      is_online = case when p_blocked then false else is_online end
  where id = p_user_id;
end;
$$;

create or replace function public.admin_delete_user(p_user_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin_user() then
    raise exception 'غير مصرّح: هذه العملية للمشرفين فقط' using errcode = '42501';
  end if;
  if exists (select 1 from public.profiles where id = p_user_id and (is_admin or is_super_admin)) then
    raise exception 'لا يمكن حذف حساب مشرف' using errcode = '42501';
  end if;
  -- حذف من auth.users يحذف profiles وما يتبعها تتابعياً (on delete cascade)
  delete from auth.users where id = p_user_id;
  delete from public.profiles where id = p_user_id;
end;
$$;

revoke all on function public.admin_set_user_blocked(uuid, boolean) from public;
revoke all on function public.admin_delete_user(uuid) from public;
grant execute on function public.admin_set_user_blocked(uuid, boolean) to authenticated;
grant execute on function public.admin_delete_user(uuid) to authenticated;

-- المستخدم المحظور لا يستطيع الكتابة إطلاقاً
create or replace function public.is_not_blocked(p_user_id uuid default auth.uid())
returns boolean language sql stable security definer set search_path = public as $$
  select not exists (select 1 from public.profiles where id = p_user_id and is_blocked = true);
$$;

-- ------------------------------------------------------------
-- 11.4 سياسات RLS — الحذف والحظر للمشرفين فقط
-- ------------------------------------------------------------
-- messages: الحذف للمشرفين فقط (إعادة تعريف صريحة)
drop policy if exists "messages delete admins only" on public.messages;
create policy "messages delete admins only" on public.messages
  for delete using (public.is_admin_user());

-- messages: الإدراج للمشاركين غير المحظورين فقط
drop policy if exists "messages insert in own conversation" on public.messages;
create policy "messages insert in own conversation" on public.messages
  for insert with check (
    sender_id = auth.uid()
    and public.is_not_blocked()
    and exists (select 1 from public.conversations c
                where c.id = conversation_id
                and (c.user_id = auth.uid() or c.admin_id = auth.uid()))
  );

-- messages: التحديث (حالة القراءة) للمشاركين، مع منع تغيير المحتوى/المرسل من غير المشرف
drop policy if exists "messages update in own conversation" on public.messages;
create policy "messages update in own conversation" on public.messages
  for update using (
    exists (select 1 from public.conversations c
            where c.id = conversation_id
            and (c.user_id = auth.uid() or c.admin_id = auth.uid()))
  )
  with check (
    exists (select 1 from public.conversations c
            where c.id = conversation_id
            and (c.user_id = auth.uid() or c.admin_id = auth.uid()))
  );

create or replace function public.protect_message_immutable_fields()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.role() = 'service_role' or public.is_admin_user() then
    return new;
  end if;
  -- غير المشرف يستطيع تغيير حالة القراءة/التسليم فقط
  new.content         := old.content;
  new.sender_id       := old.sender_id;
  new.conversation_id := old.conversation_id;
  new.attachment_url  := old.attachment_url;
  new.attachment_type := old.attachment_type;
  new.message_type    := old.message_type;
  new.call_id         := old.call_id;
  new.call_status     := old.call_status;
  new.call_duration_seconds := old.call_duration_seconds;
  return new;
end;
$$;
drop trigger if exists on_message_protect_update on public.messages;
create trigger on_message_protect_update
  before update on public.messages
  for each row execute procedure public.protect_message_immutable_fields();

-- profiles: لا حذف مباشر من العميل (فقط عبر admin_delete_user)؛
-- لا تحديث is_blocked إلا عبر admin_set_user_blocked.
drop policy if exists "profiles admin manage users" on public.profiles;
drop policy if exists "profiles admin delete users" on public.profiles;
drop policy if exists "profiles updatable by owner" on public.profiles;
create policy "profiles updatable by owner" on public.profiles
  for update using (auth.uid() = id)
  with check (auth.uid() = id);

create or replace function public.protect_profile_privileges()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.role() = 'service_role' then
    return new;
  end if;
  if exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_super_admin) then
    return new;
  end if;
  new.is_admin       := old.is_admin;
  new.is_super_admin := old.is_super_admin;
  new.email          := old.email;
  new.is_blocked     := old.is_blocked;
  new.blocked_at     := old.blocked_at;
  -- لا يمكن تغيير رقم الهاتف بعد التسجيل (هو هوية الدخول)
  if old.phone is not null then
    new.phone := old.phone;
  end if;
  return new;
end;
$$;
drop trigger if exists on_profile_privilege_guard on public.profiles;
create trigger on_profile_privilege_guard
  before update on public.profiles
  for each row execute procedure public.protect_profile_privileges();

-- المحظور لا يبدأ محادثات ولا مكالمات
drop policy if exists "conversations insert own" on public.conversations;
create policy "conversations insert own" on public.conversations
  for insert with check (
    (auth.uid() = user_id or auth.uid() = admin_id) and public.is_not_blocked()
  );

drop policy if exists "call rooms insert own" on public.call_rooms;
create policy "call rooms insert own" on public.call_rooms
  for insert with check (
    caller_id = auth.uid()
    and caller_id <> callee_id
    and public.is_not_blocked()
    and public.is_conversation_participant(conversation_id)
    and exists (
      select 1 from public.conversations c
      where c.id = conversation_id
        and (c.user_id = callee_id or c.admin_id = callee_id)
    )
  );

-- ------------------------------------------------------------
-- 11.5 إخفاء سجل المكالمات لكل مستخدم (إن لم يكن موجوداً)
-- ------------------------------------------------------------
create table if not exists public.call_history_hidden (
  user_id uuid not null references public.profiles(id) on delete cascade,
  room_id uuid not null references public.call_rooms(id) on delete cascade,
  hidden_at timestamptz not null default now(),
  primary key (user_id, room_id)
);
alter table public.call_history_hidden enable row level security;
drop policy if exists "call history hidden own select" on public.call_history_hidden;
create policy "call history hidden own select" on public.call_history_hidden
  for select using (user_id = auth.uid());
drop policy if exists "call history hidden own insert" on public.call_history_hidden;
create policy "call history hidden own insert" on public.call_history_hidden
  for insert with check (user_id = auth.uid());
drop policy if exists "call history hidden own delete" on public.call_history_hidden;
create policy "call history hidden own delete" on public.call_history_hidden
  for delete using (user_id = auth.uid());

-- ------------------------------------------------------------
-- 11.6 إشعارات المكالمات في الخلفية (FCM عبر send-push)
--      عند إنشاء غرفة "ringing" يُرسل إشعار مكالمة واردة عالي الأولوية،
--      وعند تحوّلها إلى missed يُرسل إشعار "مكالمة فائتة" ويُغلق الرنين.
-- ------------------------------------------------------------
create extension if not exists pg_net;

create or replace function public.notify_call_room()
returns trigger language plpgsql security definer set search_path = public, vault, net as $$
declare
  v_function_url text;
  v_push_secret text;
  v_type text;
begin
  if tg_op = 'INSERT' and new.status = 'ringing' then
    v_type := 'incoming_call';
  elsif tg_op = 'UPDATE' and old.status is distinct from new.status
        and new.status in ('missed', 'ended', 'declined', 'failed', 'network_lost') then
    v_type := 'call_ended';
  else
    return new;
  end if;

  select decrypted_secret into v_function_url from vault.decrypted_secrets where name = 'SEND_PUSH_URL' limit 1;
  select decrypted_secret into v_push_secret from vault.decrypted_secrets where name = 'SEND_PUSH_SECRET' limit 1;
  if coalesce(v_function_url, '') = '' or coalesce(v_push_secret, '') = '' then
    return new;
  end if;

  perform net.http_post(
    url := v_function_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-send-push-secret', v_push_secret),
    body := jsonb_build_object(
      'type', v_type,
      'room_id', new.id,
      'conversation_id', new.conversation_id,
      'caller_id', new.caller_id,
      'callee_id', new.callee_id,
      'call_type', new.call_type,
      'status', new.status
    )
  );
  return new;
end;
$$;

drop trigger if exists on_call_room_notify on public.call_rooms;
create trigger on_call_room_notify
  after insert or update on public.call_rooms
  for each row execute procedure public.notify_call_room();

-- لا تُرسل إشعار "رسالة جديدة" لبطاقات المكالمات (لها إشعارها الخاص)
create or replace function public.notify_new_message()
returns trigger language plpgsql security definer set search_path = public, vault, net as $$
declare
  v_function_url text;
  v_push_secret text;
begin
  if new.message_type = 'call' then
    return new;
  end if;

  select decrypted_secret into v_function_url from vault.decrypted_secrets where name = 'SEND_PUSH_URL' limit 1;
  select decrypted_secret into v_push_secret from vault.decrypted_secrets where name = 'SEND_PUSH_SECRET' limit 1;

  if coalesce(v_function_url, '') = '' or coalesce(v_push_secret, '') = '' then
    raise warning 'send-push secrets are not configured in Supabase Vault';
    return new;
  end if;

  perform net.http_post(
    url := v_function_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-send-push-secret', v_push_secret),
    body := jsonb_build_object(
      'message_id', new.id,
      'conversation_id', new.conversation_id,
      'sender_id', new.sender_id,
      'content', coalesce(new.content, case new.attachment_type when 'image' then '📷 صورة' when 'audio' then '🎤 رسالة صوتية' else '📎 مرفق' end)
    )
  );
  return new;
end;
$$;

drop trigger if exists on_message_inserted on public.messages;
create trigger on_message_inserted
  after insert on public.messages
  for each row execute procedure public.notify_new_message();

-- بطاقة المكالمة تحدّث معاينة آخر رسالة في قائمة المحادثات
create or replace function public.touch_conversation_on_call_message()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.message_type = 'call' then
    update public.conversations
    set last_message = new.content, last_message_at = new.created_at
    where id = new.conversation_id;
  end if;
  return new;
end;
$$;
drop trigger if exists on_call_message_touch_conversation on public.messages;
create trigger on_call_message_touch_conversation
  after insert on public.messages
  for each row execute procedure public.touch_conversation_on_call_message();

-- ------------------------------------------------------------
-- 11.7 Realtime: تأكد من بث الحذف على messages (يتطلب REPLICA IDENTITY)
-- ------------------------------------------------------------
alter table public.messages replica identity full;
alter table public.call_rooms replica identity full;
do $$
begin
  if not exists (
    select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'call_rooms'
  ) then
    alter publication supabase_realtime add table public.call_rooms;
  end if;
  if not exists (
    select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'messages'
  ) then
    alter publication supabase_realtime add table public.messages;
  end if;
end $$;

-- ------------------------------------------------------------
-- 11.8 تنظيف الغرف العالقة في حالة ringing (تعتبر فائتة بعد دقيقتين)
-- ------------------------------------------------------------
create or replace function public.expire_stale_ringing_calls()
returns integer language plpgsql security definer set search_path = public as $$
declare v_count integer;
begin
  with upd as (
    update public.call_rooms
    set status = 'missed', ended_at = now()
    where status = 'ringing' and started_at < now() - interval '2 minutes'
    returning 1
  )
  select count(*) into v_count from upd;
  return v_count;
end;
$$;

-- (اختياري) إن كان pg_cron مفعّلاً:
-- select cron.schedule('expire-ringing-calls', '* * * * *', $$select public.expire_stale_ringing_calls();$$);
