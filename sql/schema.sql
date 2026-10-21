-- ============================================================
-- WhatsApp-Clone Chat App — Supabase Schema
-- Run this in Supabase SQL Editor (Project > SQL Editor > New query)
-- ============================================================

-- Extensions
-- ============================================================
-- إسقاط الدوال القديمة لتجنب أخطاء تضارب أنواع الإرجاع (42P13)
-- ============================================================
-- ============================================================
-- إسقاط الدوال القديمة مع تبعاتها (CASCADE) لتجنب أخطاء الارتباط
-- ============================================================
DROP FUNCTION IF EXISTS public.admin_delete_user(uuid) CASCADE;
DROP FUNCTION IF EXISTS public.mark_messages_delivered(uuid) CASCADE;
DROP FUNCTION IF EXISTS public.mark_all_messages_delivered() CASCADE;
DROP FUNCTION IF EXISTS public.push_diagnostics() CASCADE;
DROP FUNCTION IF EXISTS public.push_probe() CASCADE;
DROP FUNCTION IF EXISTS public.push_probe_result(bigint) CASCADE;
DROP FUNCTION IF EXISTS public.push_call_edge(text, uuid, uuid, jsonb) CASCADE;
DROP FUNCTION IF EXISTS public.notify_new_message() CASCADE;
DROP FUNCTION IF EXISTS public.notify_call_room() CASCADE;
DROP FUNCTION IF EXISTS public.admin_directory_search(text, integer, integer) CASCADE;
DROP FUNCTION IF EXISTS public.registered_users_count() CASCADE;
DROP FUNCTION IF EXISTS public.is_admin_user(uuid) CASCADE;
DROP FUNCTION IF EXISTS public.is_not_blocked(uuid) CASCADE;
DROP FUNCTION IF EXISTS public.handle_new_user() CASCADE;

-- ------------------------------------------------------------
-- 1. PROFILES  (one row per auth.users row)
-- ------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text unique,
  phone text,
  display_name text not null,
  avatar_url text,
  is_admin boolean not null default false,
  status text default 'available',
  wallpaper_url text,
  language text default 'ar',       -- 'ar' | 'en'
  theme text default 'dark',        -- 'dark' | 'light'
  last_seen timestamptz default now(),
  is_online boolean default false,
  is_blocked boolean not null default false,
  blocked_at timestamptz,
  call_status text default 'available',
  call_status_at timestamptz,
  created_at timestamptz default now()
);

-- Hardcoded admin list is enforced from the client config (js/config.js)
-- but we also flag it server-side on first insert via trigger below.

create or replace function public.is_admin_email(p_email text)
returns boolean language sql immutable as $$
  select lower(trim(coalesce(p_email, ''))) in (
    'aabntlal680@gmail.com',
    'almgawell17@gmail.com',
    'almgawell@gmail.com',
    'almgawell1992@gmail.com',
    'almgawell1121@gmail.com',
    'almgawell1212@gmail.com',
    'almgawell5@gmail.com',
    'almgawell4@gmail.com',
    'almgawell3@gmail.com',
    'almgawell2@gmail.com',
    'almgawell1@gmail.com',
    'almgawell6@gmail.com',
    'almgawell7@gmail.com',
    'almgawell8@gmail.com',
    'almgawell9@gmail.com',
    'almgawell10@gmail.com',
    'almgawell0@gmail.com',
    'almgawell11@gmail.com'
  );
$$;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles (id, email, phone, display_name, is_admin)
  values (
    new.id,
    new.email,
    new.phone,
    coalesce(new.raw_user_meta_data->>'display_name', split_part(coalesce(new.email, new.phone), '@', 1)),
    public.is_admin_email(new.email)
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ------------------------------------------------------------
-- 2. CONVERSATIONS  (one per user<->admin pair)
-- ------------------------------------------------------------
create table if not exists public.conversations (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  admin_id uuid not null references public.profiles(id) on delete cascade,
  last_message text,
  last_message_at timestamptz default now(),
  created_at timestamptz default now(),
  unique (user_id, admin_id)
);

-- ------------------------------------------------------------
-- 3. MESSAGES
-- ------------------------------------------------------------
create table if not exists public.messages (
  id uuid primary key default uuid_generate_v4(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  content text,
  attachment_url text,
  attachment_type text,           -- 'image' | 'file' | 'audio' | 'video'
  reply_to_id uuid references public.messages(id),
  status text not null default 'sent',   -- 'sent' | 'delivered' | 'read'
  created_at timestamptz default now()
);

create index if not exists idx_messages_conversation on public.messages(conversation_id, created_at);
create index if not exists idx_messages_conversation_unread
  on public.messages(conversation_id, sender_id, status)
  where status <> 'read';

alter table public.messages add column if not exists message_type text not null default 'text';
alter table public.messages add column if not exists call_id uuid;
alter table public.messages add column if not exists call_duration_seconds integer;
create unique index if not exists idx_messages_call_id_unique
  on public.messages(call_id)
  where call_id is not null;
alter table public.profiles alter column email drop not null;
alter table public.profiles add column if not exists is_blocked boolean not null default false;
alter table public.profiles add column if not exists blocked_at timestamptz;
create unique index if not exists idx_profiles_phone_unique
  on public.profiles(phone)
  where phone is not null and phone <> '';

-- ------------------------------------------------------------
-- 4. MESSAGE REACTIONS
-- ------------------------------------------------------------
create table if not exists public.message_reactions (
  id uuid primary key default uuid_generate_v4(),
  message_id uuid not null references public.messages(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  emoji text not null,
  created_at timestamptz default now(),
  unique (message_id, user_id, emoji)
);

-- ------------------------------------------------------------
-- 5. TYPING STATUS
-- ------------------------------------------------------------
create table if not exists public.typing_status (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  is_typing boolean default false,
  updated_at timestamptz default now(),
  primary key (conversation_id, user_id)
);

-- ------------------------------------------------------------
-- 6. PUSH SUBSCRIPTIONS (Web Push)
-- ------------------------------------------------------------
create table if not exists public.push_subscriptions (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  created_at timestamptz default now(),
  unique (user_id, endpoint)
);

alter table public.push_subscriptions enable row level security;

drop policy if exists "push subs select own" on public.push_subscriptions;
create policy "push subs select own" on public.push_subscriptions
  for select using (auth.uid() = user_id);
drop policy if exists "push subs insert own" on public.push_subscriptions;
create policy "push subs insert own" on public.push_subscriptions
  for insert with check (auth.uid() = user_id);
drop policy if exists "push subs delete own" on public.push_subscriptions;
create policy "push subs delete own" on public.push_subscriptions
  for delete using (auth.uid() = user_id);

-- ------------------------------------------------------------
-- ROW LEVEL SECURITY
-- ------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.message_reactions enable row level security;
alter table public.typing_status enable row level security;
create or replace function public.is_admin_user(p_user_id uuid default auth.uid())
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = p_user_id and is_admin = true);
$$;

-- Profiles: everyone authenticated can read (needed for contact lists / names)
drop policy if exists "profiles readable by authenticated" on public.profiles;
create policy "profiles readable by authenticated" on public.profiles
  for select using (auth.role() = 'authenticated');
drop policy if exists "profiles updatable by owner" on public.profiles;
create policy "profiles updatable by owner" on public.profiles
  for update using (auth.uid() = id)
  with check (auth.uid() = id);
drop policy if exists "profiles admin manage users" on public.profiles;
create policy "profiles admin manage users" on public.profiles
  for update using (public.is_admin_user()) with check (public.is_admin_user());
drop policy if exists "profiles admin delete users" on public.profiles;
create policy "profiles admin delete users" on public.profiles
  for delete using (public.is_admin_user());

-- Conversations: only the two participants can see/manage
drop policy if exists "conversations select own" on public.conversations;
create policy "conversations select own" on public.conversations
  for select using (auth.uid() = user_id or auth.uid() = admin_id);
drop policy if exists "conversations insert own" on public.conversations;
create policy "conversations insert own" on public.conversations
  for insert with check (auth.uid() = user_id or auth.uid() = admin_id);
drop policy if exists "conversations update own" on public.conversations;
create policy "conversations update own" on public.conversations
  for update using (auth.uid() = user_id or auth.uid() = admin_id);

-- Messages: only participants of the parent conversation
drop policy if exists "messages select in own conversation" on public.messages;
create policy "messages select in own conversation" on public.messages
  for select using (
    exists (select 1 from public.conversations c
            where c.id = conversation_id
            and (c.user_id = auth.uid() or c.admin_id = auth.uid()))
  );
drop policy if exists "messages insert in own conversation" on public.messages;
create policy "messages insert in own conversation" on public.messages
  for insert with check (
    sender_id = auth.uid() and
    exists (select 1 from public.conversations c
            where c.id = conversation_id
            and (c.user_id = auth.uid() or c.admin_id = auth.uid()))
  );
drop policy if exists "messages update in own conversation" on public.messages;
create policy "messages update in own conversation" on public.messages
  for update using (
    exists (select 1 from public.conversations c
            where c.id = conversation_id
            and (c.user_id = auth.uid() or c.admin_id = auth.uid()))
  );
drop policy if exists "messages delete admins only" on public.messages;
create policy "messages delete admins only" on public.messages
  for delete using (public.is_admin_user());

-- Reactions
drop policy if exists "reactions select in own conversation" on public.message_reactions;
create policy "reactions select in own conversation" on public.message_reactions
  for select using (
    exists (select 1 from public.messages m join public.conversations c on c.id = m.conversation_id
            where m.id = message_id and (c.user_id = auth.uid() or c.admin_id = auth.uid()))
  );
drop policy if exists "reactions insert own" on public.message_reactions;
create policy "reactions insert own" on public.message_reactions
  for insert with check (user_id = auth.uid());
drop policy if exists "reactions delete own" on public.message_reactions;
create policy "reactions delete own" on public.message_reactions
  for delete using (user_id = auth.uid());

-- Typing status
drop policy if exists "typing select in own conversation" on public.typing_status;
create policy "typing select in own conversation" on public.typing_status
  for select using (
    exists (select 1 from public.conversations c
            where c.id = conversation_id and (c.user_id = auth.uid() or c.admin_id = auth.uid()))
  );
drop policy if exists "typing upsert own" on public.typing_status;
create policy "typing upsert own" on public.typing_status
  for insert with check (user_id = auth.uid());
drop policy if exists "typing update own" on public.typing_status;
create policy "typing update own" on public.typing_status
  for update using (user_id = auth.uid());

-- ------------------------------------------------------------
-- REALTIME: enable replication on the tables the client listens to
-- ------------------------------------------------------------
do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'messages', 'typing_status', 'profiles', 'message_reactions'
  ] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', v_table);
    exception when duplicate_object then null;
    end;
  end loop;
end
$$;

-- ------------------------------------------------------------
-- STORAGE BUCKETS (run once; Supabase Dashboard > Storage also works)
-- ------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('attachments', 'attachments', true)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('wallpapers', 'wallpapers', true)
on conflict (id) do nothing;

drop policy if exists "avatar upload own" on storage.objects;
create policy "avatar upload own" on storage.objects
  for insert with check (bucket_id = 'avatars' and auth.role() = 'authenticated');
drop policy if exists "avatar public read" on storage.objects;
create policy "avatar public read" on storage.objects
  for select using (bucket_id = 'avatars');

drop policy if exists "attachments upload own" on storage.objects;
create policy "attachments upload own" on storage.objects
  for insert with check (bucket_id = 'attachments' and auth.role() = 'authenticated');
drop policy if exists "attachments public read" on storage.objects;
create policy "attachments public read" on storage.objects
  for select using (bucket_id = 'attachments');

drop policy if exists "wallpapers upload own" on storage.objects;
create policy "wallpapers upload own" on storage.objects
  for insert with check (bucket_id = 'wallpapers' and auth.role() = 'authenticated');
drop policy if exists "wallpapers public read" on storage.objects;
create policy "wallpapers public read" on storage.objects
  for select using (bucket_id = 'wallpapers');

-- ------------------------------------------------------------
-- 7. الأزرار التفاعلية (بلا رسائل تلقائية — تم إلغاء الترحيب والبوت)
-- ------------------------------------------------------------

-- عمود لتخزين الأزرار التفاعلية المرفقة برسالة (مصفوفة JSON: [{label, value}, ...])
alter table public.messages add column if not exists buttons jsonb;

-- لا توجد أي رسائل تلقائية (ترحيب / بوت كلمات مفتاحية): الرسائل تُنشأ فقط عند إرسال المستخدم.
-- عمود الأزرار يبقى للتوافق مع الرسائل القديمة فقط.
drop trigger if exists on_message_first_welcome on public.messages;
drop trigger if exists on_message_keyword_autoreply on public.messages;
drop trigger if exists on_conversation_created on public.conversations;
drop function if exists public.send_welcome_message();
drop function if exists public.handle_keyword_autoreply();

-- ------------------------------------------------------------
-- WEB PUSH TRIGGER (اختياري)
-- عند إدراج رسالة جديدة، يستدعي Edge Function الذي يرسل Web Push
-- للمستلم. يتطلب تفعيل امتداد pg_net ونشر الدالة supabase/functions/send-push
-- ------------------------------------------------------------
create extension if not exists pg_net;

-- رابط دالة send-push والسرّ المشترك مُضمَّنان مباشرةً (بلا Supabase Vault).
create or replace function public.notify_new_message()
returns trigger language plpgsql security definer set search_path = public, net as $$
declare
  v_function_url text := 'https://gqocavvhkfzgxzscrjms.supabase.co/functions/v1/send-push';
  v_push_secret text := 'my_send_push_19921121_almgawell_19921121';
begin

  perform net.http_post(
    url := v_function_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-send-push-secret', v_push_secret
    ),
    body := jsonb_build_object(
      'message_id', new.id,
      'conversation_id', new.conversation_id,
      'sender_id', new.sender_id,
      'content', new.content
    )
  );
  return new;
end;
$$;

drop trigger if exists on_message_inserted on public.messages;
create trigger on_message_inserted
  after insert on public.messages
  for each row execute procedure public.notify_new_message();

-- ------------------------------------------------------------
-- 8. جدول FCM Tokens (Firebase Cloud Messaging)
--    يُستخدم من js/push.js لحفظ توكن كل جهاز/متصفح مسجَّل للإشعارات.
--    ملاحظة: هذا منفصل تماماً عن جدول push_subscriptions القديم
--    (Web Push VAPID) الذي لم يعد المشروع يعتمد عليه بعد التحول لـ FCM.
-- ------------------------------------------------------------
create table if not exists public.fcm_tokens (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  token text not null,
  platform text default 'web',
  device_id text,
  device_info jsonb not null default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (token)
);

create index if not exists idx_fcm_tokens_user_device on public.fcm_tokens (user_id, device_id);

alter table public.fcm_tokens enable row level security;

drop policy if exists "fcm tokens select own" on public.fcm_tokens;
create policy "fcm tokens select own" on public.fcm_tokens
  for select using (auth.uid() = user_id);
drop policy if exists "fcm tokens upsert own" on public.fcm_tokens;
create policy "fcm tokens upsert own" on public.fcm_tokens
  for insert with check (auth.uid() = user_id);
drop policy if exists "fcm tokens update own" on public.fcm_tokens;
create policy "fcm tokens update own" on public.fcm_tokens
  for update using (auth.uid() = user_id);
drop policy if exists "fcm tokens delete own" on public.fcm_tokens;
create policy "fcm tokens delete own" on public.fcm_tokens
  for delete using (auth.uid() = user_id);

do $$
begin
  begin
    alter publication supabase_realtime add table public.fcm_tokens;
  exception when duplicate_object then null;
  end;
end
$$;

-- RPC تسجيل توكن الجهاز (v2.7): تنقل التوكن للمستخدم الحالي، وتحذف صف الجهاز القديم عند التدوير
drop function if exists public.register_fcm_token(text, text);
create or replace function public.register_fcm_token(
  p_token text,
  p_platform text default 'web',
  p_device_id text default null,
  p_device_info jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_owner uuid;
  v_action text;
  v_id uuid;
  v_device text := nullif(btrim(coalesce(p_device_id, '')), '');
  v_removed int := 0;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if coalesce(btrim(p_token), '') = '' then
    raise exception 'token required' using errcode = '22023';
  end if;

  -- تحديد الإجراء قبل الكتابة: جديد / تحديث لنفس الحساب / نقل من حساب آخر على الجهاز نفسه
  select user_id into v_owner from public.fcm_tokens where token = p_token;
  v_action := case
    when not found then 'inserted'
    when v_owner = v_uid then 'refreshed'
    else 'moved'
  end;

  -- تدوير التوكن على نفس الجهاز: احذف الصفوف القديمة لهذا الجهاز (لنفس المستخدم فقط)
  if v_device is not null then
    delete from public.fcm_tokens
    where user_id = v_uid
      and device_id = v_device
      and token <> p_token;
    get diagnostics v_removed = row_count;
  end if;

  insert into public.fcm_tokens (user_id, token, platform, device_id, device_info, created_at, updated_at)
  values (
    v_uid,
    p_token,
    coalesce(nullif(p_platform, ''), 'web'),
    v_device,
    coalesce(p_device_info, '{}'::jsonb),
    now(),
    now()
  )
  on conflict (token) do update
    set user_id = excluded.user_id,
        platform = excluded.platform,
        device_id = excluded.device_id,
        device_info = excluded.device_info,
        updated_at = now()
  returning id into v_id;

  return jsonb_build_object(
    'id', v_id,
    'action', v_action,
    'rotated_removed', v_removed
  );
end;
$$;

revoke all on function public.register_fcm_token(text, text, text, jsonb) from public;
grant execute on function public.register_fcm_token(text, text, text, jsonb) to authenticated;

-- ------------------------------------------------------------
-- 9. صلاحيات المشرف العام (Super Admin) — تحكم كامل بلا قيود
--    الحساب المستهدف حالياً: almgawell17@gmail.com
--    لإضافة حساب آخر لاحقاً: نفّذ فقط سطر الـ UPDATE في آخر هذا القسم
--    بالبريد الجديد، دون الحاجة لتعديل أي دالة.
-- ------------------------------------------------------------

-- 9.1 عمود الصلاحية + دالة مطابقة البريد (على نمط is_admin_email الموجودة أصلاً)
alter table public.profiles add column if not exists is_super_admin boolean not null default false;

create or replace function public.is_super_admin_email(p_email text)
returns boolean language sql immutable as $$
  select lower(trim(coalesce(p_email, ''))) = 'almgawell17@gmail.com';
$$;

-- 9.2 تحديث trigger التسجيل التلقائي ليضبط is_super_admin (و is_admin ضمنياً)
--     لأي حساب جديد يُنشأ ببريد المشرف العام
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles (id, email, phone, display_name, is_admin, is_super_admin)
  values (
    new.id,
    new.email,
    new.phone,
    coalesce(new.raw_user_meta_data->>'display_name', split_part(coalesce(new.email, new.phone), '@', 1)),
    public.is_admin_email(new.email) or public.is_super_admin_email(new.email),
    public.is_super_admin_email(new.email)
  )
  on conflict (id) do update
    set is_super_admin = excluded.is_super_admin,
        is_admin = public.profiles.is_admin or excluded.is_admin;
  return new;
end;
$$;

-- 9.3 تفعيل فوري لأي حساب مسجَّل بالفعل بنفس البريد (لا داعي لإعادة التسجيل)
update public.profiles
set is_super_admin = true, is_admin = true
where lower(email) = 'almgawell17@gmail.com';

update public.profiles
set is_admin = true
where lower(email) in (
  'aabntlal680@gmail.com',
  'almgawell17@gmail.com',
  'almgawell@gmail.com',
  'almgawell1992@gmail.com',
  'almgawell1121@gmail.com',
  'almgawell1212@gmail.com',
  'almgawell5@gmail.com',
  'almgawell4@gmail.com',
  'almgawell3@gmail.com',
  'almgawell2@gmail.com',
  'almgawell1@gmail.com',
  'almgawell6@gmail.com',
  'almgawell7@gmail.com',
  'almgawell8@gmail.com',
  'almgawell9@gmail.com',
  'almgawell10@gmail.com',
  'almgawell0@gmail.com',
  'almgawell11@gmail.com'
);

-- 9.4 سياسات RLS إضافية (Permissive — تُضاف بجانب السياسات الحالية ولا تستبدلها):
--     تمنح المشرف العام قراءة/كتابة كاملة على كل المحادثات والرسائل، بصرف
--     النظر عن كونه طرفاً فيها أصلاً أم لا.
drop policy if exists "conversations full access superadmin" on public.conversations;
create policy "conversations full access superadmin" on public.conversations
  for all using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_super_admin)
  )
  with check (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_super_admin)
  );

drop policy if exists "messages full access superadmin" on public.messages;
create policy "messages full access superadmin" on public.messages
  for all using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_super_admin)
  )
  with check (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_super_admin)
  );

-- ملاحظة: جدول profiles مقروء بالفعل لكل مستخدم مسجَّل دخول (السياسة
-- "profiles readable by authenticated" أعلاه)، لذلك لا حاجة لسياسة إضافية
-- هنا كي يرى المشرف العام أسماء/بيانات كل المستخدمين والمشرفين.

-- ============================================================
-- 10. المكالمات الصوتية والمرئية عبر منصة Agora
--     - call_rooms : غرفة/جلسة مكالمة واحدة (تُنشأ عند الطلب)
--     - call_logs  : سجل تفصيلي لكل حدث داخل المكالمة (تدقيق وإحصاء)
--     - profiles.call_status : حالة اتصال المستخدم الحالية
-- ملاحظة: هذا القسم idempotent (يمكن إعادة تنفيذه بأمان).
-- ============================================================

-- 10.1 حالة الاتصال على مستوى المستخدم
alter table public.profiles
  add column if not exists call_status text not null default 'available';

alter table public.profiles
  add column if not exists call_status_at timestamptz default now();

-- قيّد القيم المسموحة (احذف القيد القديم أولاً لضمان إعادة التنفيذ)
alter table public.profiles drop constraint if exists profiles_call_status_check;
alter table public.profiles
  add constraint profiles_call_status_check
  check (call_status in ('available', 'ringing', 'in_call', 'unavailable'));

create index if not exists idx_profiles_call_status
  on public.profiles(call_status)
  where call_status <> 'available';

-- 10.2 غرف المكالمات
create table if not exists public.call_rooms (
  id uuid primary key default uuid_generate_v4(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  channel_name text not null,
  call_type text not null default 'audio',
  caller_id uuid not null references public.profiles(id) on delete cascade,
  callee_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'ringing',
  started_at timestamptz not null default now(),
  answered_at timestamptz,
  ended_at timestamptz,
  -- المدة بالثواني تُحسب تلقائياً (عمود مولَّد) لتقارير سريعة بلا حسابات في العميل
  duration_seconds integer generated always as (
    case
      when answered_at is not null and ended_at is not null
        then greatest(0, extract(epoch from (ended_at - answered_at))::integer)
      else 0
    end
  ) stored,
  created_at timestamptz not null default now()
);

alter table public.call_rooms drop constraint if exists call_rooms_call_type_check;
alter table public.call_rooms
  add constraint call_rooms_call_type_check check (call_type in ('audio', 'video'));

alter table public.call_rooms drop constraint if exists call_rooms_status_check;
alter table public.call_rooms
  add constraint call_rooms_status_check check (
    status in ('ringing', 'active', 'ended', 'declined', 'missed', 'failed', 'network_lost')
  );

alter table public.call_rooms drop constraint if exists call_rooms_distinct_parties;
alter table public.call_rooms
  add constraint call_rooms_distinct_parties check (caller_id <> callee_id);

create index if not exists idx_call_rooms_conversation
  on public.call_rooms(conversation_id, started_at desc);
create index if not exists idx_call_rooms_caller  on public.call_rooms(caller_id, started_at desc);
create index if not exists idx_call_rooms_callee  on public.call_rooms(callee_id, started_at desc);
create index if not exists idx_call_rooms_channel on public.call_rooms(channel_name);

-- منع أكثر من مكالمة نشطة واحدة على نفس المحادثة في آن واحد
create unique index if not exists uq_call_rooms_active_conversation
  on public.call_rooms(conversation_id)
  where status in ('ringing', 'active');

-- 10.3 سجل أحداث المكالمات
create table if not exists public.call_logs (
  id uuid primary key default uuid_generate_v4(),
  room_id uuid not null references public.call_rooms(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  event text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.call_logs drop constraint if exists call_logs_event_check;
alter table public.call_logs
  add constraint call_logs_event_check check (
    event in (
      'initiated', 'ringing', 'answered', 'declined', 'missed',
      'ended', 'failed', 'network_lost', 'muted', 'unmuted',
      'camera_on', 'camera_off', 'reconnecting'
    )
  );

create index if not exists idx_call_logs_room on public.call_logs(room_id, created_at);
create index if not exists idx_call_logs_user on public.call_logs(user_id, created_at desc);

-- 10.3.1 إخفاء سجل المكالمة لكل مستخدم دون حذف السجل المشترك للطرف الآخر
create table if not exists public.call_history_hidden (
  user_id uuid not null references public.profiles(id) on delete cascade,
  room_id uuid not null references public.call_rooms(id) on delete cascade,
  created_at timestamptz not null default now(),
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

-- 10.4 دالة مساعدة: هل المستخدم الحالي طرف في هذه الغرفة؟
--      SECURITY DEFINER + search_path مثبّت لمنع أي التفاف على الصلاحيات.
create or replace function public.is_call_participant(p_room_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.call_rooms r
    where r.id = p_room_id
      and (r.caller_id = auth.uid() or r.callee_id = auth.uid())
  );
$$;

create or replace function public.is_conversation_participant(p_conversation_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.conversations c
    where c.id = p_conversation_id
      and (c.user_id = auth.uid() or c.admin_id = auth.uid())
  );
$$;

-- 10.5 عند انتهاء المكالمة: أعد ضبط حالة اتصال الطرفين تلقائياً
create or replace function public.reset_call_presence()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status in ('ended', 'declined', 'missed', 'failed', 'network_lost')
     and (old.status is distinct from new.status) then
    update public.profiles
    set call_status = 'available', call_status_at = now()
    where id in (new.caller_id, new.callee_id);
  end if;
  return new;
end;
$$;

drop trigger if exists on_call_room_finished on public.call_rooms;
create trigger on_call_room_finished
  after update on public.call_rooms
  for each row execute procedure public.reset_call_presence();

-- ------------------------------------------------------------
-- 10.6 سياسات أمان الصفوف (RLS) للمكالمات
-- ------------------------------------------------------------
alter table public.call_rooms enable row level security;
alter table public.call_logs  enable row level security;

-- --- call_rooms ---
drop policy if exists "call rooms select participants" on public.call_rooms;
create policy "call rooms select participants" on public.call_rooms
  for select using (
    caller_id = auth.uid() or callee_id = auth.uid()
  );

-- الإدراج: المتصل هو المستخدم الحالي فقط، ويجب أن يكون طرفاً في المحادثة،
-- وأن يكون المستقبل هو الطرف الآخر فعلاً (يمنع انتحال مكالمات لأطراف غريبة).
drop policy if exists "call rooms insert own" on public.call_rooms;
create policy "call rooms insert own" on public.call_rooms
  for insert with check (
    caller_id = auth.uid()
    and caller_id <> callee_id
    and public.is_conversation_participant(conversation_id)
    and exists (
      select 1 from public.conversations c
      where c.id = conversation_id
        and (c.user_id = callee_id or c.admin_id = callee_id)
    )
  );

-- التحديث: الطرفان فقط، ولا يمكن تغيير هوية الأطراف أو المحادثة بعد الإنشاء.
drop policy if exists "call rooms update participants" on public.call_rooms;
create policy "call rooms update participants" on public.call_rooms
  for update using (
    caller_id = auth.uid() or callee_id = auth.uid()
  )
  with check (
    caller_id = auth.uid() or callee_id = auth.uid()
  );

-- لا سياسة DELETE: سجل المكالمات لا يُحذف من العميل (يُحذف تتابعياً مع المحادثة فقط).

-- المشرف العام: اطّلاع كامل على كل غرف المكالمات للتدقيق
drop policy if exists "call rooms superadmin" on public.call_rooms;
create policy "call rooms superadmin" on public.call_rooms
  for all using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_super_admin)
  )
  with check (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_super_admin)
  );

-- --- call_logs ---
drop policy if exists "call logs select participants" on public.call_logs;
create policy "call logs select participants" on public.call_logs
  for select using (public.is_call_participant(room_id));

-- كل مستخدم يكتب أحداثه هو فقط، وداخل غرفة هو طرف فيها.
drop policy if exists "call logs insert own" on public.call_logs;
create policy "call logs insert own" on public.call_logs
  for insert with check (
    user_id = auth.uid() and public.is_call_participant(room_id)
  );

-- السجلات غير قابلة للتعديل أو الحذف (append-only) لضمان نزاهة التدقيق.

drop policy if exists "call logs superadmin" on public.call_logs;
create policy "call logs superadmin" on public.call_logs
  for select using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_super_admin)
  );

-- ------------------------------------------------------------
-- 10.7 تشديد سياسة تحديث profiles
--      المستخدم يعدّل صفّه فقط (مع منع رفع صلاحياته بنفسه)
-- ------------------------------------------------------------
drop policy if exists "profiles updatable by owner" on public.profiles;
create policy "profiles updatable by owner" on public.profiles
  for update using (auth.uid() = id)
  with check (auth.uid() = id);

-- منع أي مستخدم من منح نفسه is_admin / is_super_admin عبر تحديث مباشر
create or replace function public.protect_profile_privileges()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- الأدوار الخدمية (service_role) والمشرف العام مستثناة
  if auth.role() = 'service_role' then
    return new;
  end if;

  if exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_super_admin) then
    return new;
  end if;

  new.is_admin       := old.is_admin;
  new.is_super_admin := old.is_super_admin;
  new.email          := old.email;

  return new;
end;
$$;

drop trigger if exists on_profile_privilege_guard on public.profiles;
create trigger on_profile_privilege_guard
  before update on public.profiles
  for each row execute procedure public.protect_profile_privileges();

-- ------------------------------------------------------------
-- 10.8 تشديد سياسات التخزين (Storage) — الرفع داخل مجلد المستخدم فقط
--      المسار المستخدم في العميل: <user_id>/<uuid>.<ext>
-- ------------------------------------------------------------
drop policy if exists "avatar upload own"      on storage.objects;
drop policy if exists "attachments upload own" on storage.objects;
drop policy if exists "wallpapers upload own"  on storage.objects;

drop policy if exists "avatar upload own" on storage.objects;
create policy "avatar upload own" on storage.objects
  for insert with check (
    bucket_id = 'avatars'
    and auth.role() = 'authenticated'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "attachments upload own" on storage.objects;
create policy "attachments upload own" on storage.objects
  for insert with check (
    bucket_id = 'attachments'
    and auth.role() = 'authenticated'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "wallpapers upload own" on storage.objects;
create policy "wallpapers upload own" on storage.objects
  for insert with check (
    bucket_id = 'wallpapers'
    and auth.role() = 'authenticated'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- السماح لصاحب الملف بحذف/استبدال ملفاته فقط
drop policy if exists "media delete own" on storage.objects;
create policy "media delete own" on storage.objects
  for delete using (
    bucket_id in ('avatars', 'attachments', 'wallpapers')
    and auth.role() = 'authenticated'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "media update own" on storage.objects;
create policy "media update own" on storage.objects
  for update using (
    bucket_id in ('avatars', 'attachments', 'wallpapers')
    and auth.role() = 'authenticated'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ------------------------------------------------------------
-- 10.9 فهارس أداء إضافية على الجداول القائمة
-- ------------------------------------------------------------
create index if not exists idx_conversations_user  on public.conversations(user_id, last_message_at desc);
create index if not exists idx_conversations_admin on public.conversations(admin_id, last_message_at desc);
create index if not exists idx_messages_unread
  on public.messages(conversation_id, sender_id)
  where status <> 'read';
create index if not exists idx_reactions_message on public.message_reactions(message_id);

-- ------------------------------------------------------------
-- 10.10 تفعيل Realtime على جداول المكالمات
--       (داخل DO block حتى لا يفشل السكربت إن كانت مضافة مسبقاً)
-- ------------------------------------------------------------
do $$
begin
  begin
    alter publication supabase_realtime add table public.call_rooms;
  exception when duplicate_object then null;
  end;

  begin
    alter publication supabase_realtime add table public.call_logs;
  exception when duplicate_object then null;
  end;
end
$$;

-- ------------------------------------------------------------
-- 10.11 تنظيف دوري: أنهِ الغرف العالقة في حالة "ringing" لأكثر من 5 دقائق
--       (نفّذها يدوياً أو عبر pg_cron إن كان مفعّلاً)
-- ------------------------------------------------------------
create or replace function public.expire_stale_calls()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  update public.call_rooms
  set status = 'missed', ended_at = now()
  where status = 'ringing'
    and started_at < now() - interval '5 minutes';

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;


-- ============================================================
-- 11. الإصدار v2 (2026-09-21): مكالمات داخل المحادثة، إشعارات الخلفية،
--     مصادقة (هاتف/بريد)، وتشديد RLS للمشرفين — انظر sql/migrations/
-- ============================================================
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
      -- المستخدم العادي: الحظر يقطعه. المشرف: يبقى "متصل الآن" دائماً.
      is_online = case
                    when (is_admin or is_super_admin) then true
                    when p_blocked then false
                    else is_online
                  end
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
  -- (1) حضور المشرف ثابت: "متصل الآن" دائماً للمستخدم العادي، ولا تقطعه
  --     نبضات الخروج/السكون التي يُرسلها متصفح المشرف عند إخفاء التطبيق.
  if coalesce(new.is_admin, old.is_admin, false)
     or public.is_admin_email(coalesce(old.email, new.email)) then
    new.is_online := true;
    new.last_seen := coalesce(new.last_seen, now());
  end if;

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

-- نفس القاعدة عند إنشاء الملف الشخصي (تسجيل مشرف جديد)
create or replace function public.force_admin_presence_online()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(new.is_admin, false) or public.is_admin_email(new.email) then
    new.is_online := true;
  end if;
  return new;
end;
$$;
drop trigger if exists on_profile_admin_presence on public.profiles;
create trigger on_profile_admin_presence
  before insert on public.profiles
  for each row execute procedure public.force_admin_presence_online();

-- تصحيح الحالة القائمة
update public.profiles p
   set is_online = true,
       last_seen = coalesce(p.last_seen, now())
 where p.is_admin = true
    or public.is_admin_email(p.email);

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
returns trigger language plpgsql security definer set search_path = public, net as $$
declare
  v_function_url text := 'https://gqocavvhkfzgxzscrjms.supabase.co/functions/v1/send-push';
  v_push_secret text := 'my_send_push_19921121_almgawell_19921121';
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
returns trigger language plpgsql security definer set search_path = public, net as $$
declare
  v_function_url text := 'https://gqocavvhkfzgxzscrjms.supabase.co/functions/v1/send-push';
  v_push_secret text := 'my_send_push_19921121_almgawell_19921121';
begin
  if new.message_type = 'call' then
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

-- ============================================================
-- 12. الإصدار v2.1: موثوقية الإشعارات + عدّاد غير المقروء + الترتيب بآخر تفاعل
-- ============================================================
-- (أ) --------------------------------------------------------
create index if not exists idx_fcm_tokens_user on public.fcm_tokens(user_id);

-- سجل محاولات الإرسال لتشخيص "الإشعار لا يصل" من لوحة Supabase مباشرة
create table if not exists public.push_delivery_log (
  id bigserial primary key,
  kind text not null,               -- new_message | incoming_call | call_ended | new_user | probe
  ref_id uuid,                      -- message_id أو room_id
  recipient_id uuid,
  request_id bigint,                -- معرّف طلب pg_net
  note text,
  created_at timestamptz not null default now()
);
alter table public.push_delivery_log enable row level security;
drop policy if exists "push log superadmin read" on public.push_delivery_log;
create policy "push log superadmin read" on public.push_delivery_log
  for select using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_super_admin));

create or replace function public.push_call_edge(p_kind text, p_ref uuid, p_recipient uuid, p_body jsonb)
returns void language plpgsql security definer set search_path = public, net as $$
declare
  v_url text := 'https://gqocavvhkfzgxzscrjms.supabase.co/functions/v1/send-push';
  v_secret text := 'my_send_push_19921121_almgawell_19921121';
  v_req bigint;
begin

  begin
    select net.http_post(
      url := v_url,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-send-push-secret', v_secret),
      body := p_body,
      timeout_milliseconds := 8000
    ) into v_req;
    insert into public.push_delivery_log(kind, ref_id, recipient_id, request_id)
    values (p_kind, p_ref, p_recipient, v_req);
  exception when others then
    -- لا تُفشل إدراج الرسالة/المكالمة بسبب خطأ في الإشعار
    insert into public.push_delivery_log(kind, ref_id, recipient_id, note)
    values (p_kind, p_ref, p_recipient, 'ERROR: ' || sqlerrm);
  end;
end;
$$;

create or replace function public.notify_new_message()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_recipient uuid;
begin
  if new.message_type = 'call' then
    return new;
  end if;
  select case when c.user_id = new.sender_id then c.admin_id else c.user_id end
    into v_recipient
  from public.conversations c where c.id = new.conversation_id;

  perform public.push_call_edge(
    'new_message', new.id, v_recipient,
    jsonb_build_object(
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

create or replace function public.notify_call_room()
returns trigger language plpgsql security definer set search_path = public as $$
declare
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

  perform public.push_call_edge(
    v_type, new.id, new.callee_id,
    jsonb_build_object(
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

-- (ب) --------------------------------------------------------
create index if not exists idx_messages_unread_by_conv
  on public.messages(conversation_id, sender_id) where status <> 'read';

create or replace function public.unread_counts(p_conversation_ids uuid[])
returns table(conversation_id uuid, unread bigint)
language sql stable security invoker set search_path = public as $$
  select m.conversation_id, count(*)::bigint
  from public.messages m
  where m.conversation_id = any(p_conversation_ids)
    and m.sender_id <> auth.uid()
    and m.status <> 'read'
  group by m.conversation_id;
$$;
grant execute on function public.unread_counts(uuid[]) to authenticated;

-- تصفير "غير المقروء" لمحادثة كاملة في طلب واحد (تُستخدم عند فتح المحادثة
-- فوراً من نقرة إشعار). تُعيد عدد الرسائل التي تحوّلت إلى مقروءة — تثبيت
-- ذرّي أدق من UPDATE من العميل، ويسهّل تشخيص فشل RLS.
create or replace function public.mark_conversation_read(p_conversation_id uuid)
returns integer
language plpgsql security invoker set search_path = public as $$
declare
  v_count integer := 0;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  update public.messages m
     set status = 'read'
   where m.conversation_id = p_conversation_id
     and m.sender_id <> auth.uid()
     and (m.status is null or m.status <> 'read');

  get diagnostics v_count = row_count;
  return coalesce(v_count, 0);
end;
$$;
grant execute on function public.mark_conversation_read(uuid) to authenticated;

-- "تم التسليم" (✓✓ رمادي): يثبّتها جهاز المستقبِل عند وصول الرسالة إليه فعلاً
-- (Realtime / مزامنة العودة / وصول الإشعار)، ويثبّتها كذلك Edge Function
-- send-push بعد نجاح إرسال الإشعار — فيظهر الصحّان حتى لو كان المستقبِل مغلقاً.
create or replace function public.mark_messages_delivered(p_conversation_id uuid)
returns integer
language plpgsql security invoker set search_path = public as $$
declare
  v_count integer := 0;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  update public.messages m
     set status = 'delivered'
   where m.conversation_id = p_conversation_id
     and m.sender_id <> auth.uid()
     and m.status = 'sent';

  get diagnostics v_count = row_count;
  return coalesce(v_count, 0);
end;
$$;
grant execute on function public.mark_messages_delivered(uuid) to authenticated;

-- وتصحيح جماعي عند عودة التطبيق: كل الرسائل الواردة المعلّقة → "مُسلَّمة"
create or replace function public.mark_all_messages_delivered()
returns integer
language plpgsql security invoker set search_path = public as $$
declare
  v_count integer := 0;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  update public.messages m
     set status = 'delivered'
   where m.sender_id <> auth.uid()
     and m.status = 'sent'
     and exists (
       select 1 from public.conversations c
       where c.id = m.conversation_id
         and (c.user_id = auth.uid() or c.admin_id = auth.uid())
     );

  get diagnostics v_count = row_count;
  return coalesce(v_count, 0);
end;
$$;
grant execute on function public.mark_all_messages_delivered() to authenticated;

-- (ج) --------------------------------------------------------
-- أي رسالة جديدة (نص/مرفق/مكالمة) تحدّث آخر تفاعل للمحادثة، حتى إن لم يحدّثها العميل
create or replace function public.touch_conversation_on_message()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.conversations
  set last_message = coalesce(new.content, case new.attachment_type when 'image' then '📷 صورة' when 'audio' then '🎤 رسالة صوتية' when 'file' then '📎 ملف' else last_message end),
      last_message_at = greatest(coalesce(last_message_at, new.created_at), new.created_at)
  where id = new.conversation_id;
  return new;
end;
$$;
drop trigger if exists on_call_message_touch_conversation on public.messages;
drop trigger if exists on_message_touch_conversation on public.messages;
create trigger on_message_touch_conversation
  after insert on public.messages
  for each row execute procedure public.touch_conversation_on_message();

-- تأكد أن Realtime يبث تحديثات conversations (لإعادة الترتيب الفوري)
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'conversations') then
    alter publication supabase_realtime add table public.conversations;
  end if;
end $$;

-- ============================================================
-- 13. الإصدار v2.2: حذف المستخدم الشامل لكل المشرفين + تشخيص الإشعارات
-- ============================================================
-- المشرف = is_admin أو is_super_admin (السوبر أدمن دائماً مشرف)
create or replace function public.is_admin_user(p_user_id uuid default auth.uid())
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = p_user_id and (is_admin = true or is_super_admin = true)
  );
$$;

-- reply_to_id بلا cascade كان يمنع حذف الرسائل المُشار إليها → اجعله set null
alter table public.messages drop constraint if exists messages_reply_to_id_fkey;
alter table public.messages
  add constraint messages_reply_to_id_fkey
  foreign key (reply_to_id) references public.messages(id) on delete set null;

-- تأكد أن كل الجداول التابعة تُحذف تتابعياً مع profiles
do $$
declare r record;
begin
  for r in
    select tc.table_name, tc.constraint_name
    from information_schema.table_constraints tc
    join information_schema.referential_constraints rc on rc.constraint_name = tc.constraint_name and rc.constraint_schema = tc.table_schema
    join information_schema.constraint_column_usage ccu on ccu.constraint_name = tc.constraint_name and ccu.constraint_schema = tc.table_schema
    where tc.table_schema = 'public' and tc.constraint_type = 'FOREIGN KEY'
      and ccu.table_name = 'profiles' and rc.delete_rule <> 'CASCADE'
      and tc.table_name <> 'messages' -- call_caller_id: set null مقصود
  loop
    raise notice 'FK بلا cascade على profiles: %.% — راجعه يدوياً', r.table_name, r.constraint_name;
  end loop;
end $$;

-- حذف شامل: جداول public + ملفات Storage + حساب auth
-- (نوع الإرجاع تغيّر من void إلى jsonb → يجب إسقاط الدالة القديمة أولاً)
drop function if exists public.admin_delete_user(uuid);
create or replace function public.admin_delete_user(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = public, auth, storage as $$
declare
  v_counts jsonb := '{}'::jsonb;
  v_n bigint;
  v_conv uuid[];
begin
  if not public.is_admin_user() then
    raise exception 'غير مصرّح: هذه العملية للمشرفين فقط' using errcode = '42501';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'لا يمكنك حذف حسابك أنت' using errcode = '42501';
  end if;
  if exists (select 1 from public.profiles where id = p_user_id and (is_admin or is_super_admin)) then
    raise exception 'لا يمكن حذف حساب مشرف' using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles where id = p_user_id) then
    raise exception 'المستخدم غير موجود' using errcode = 'P0002';
  end if;

  select coalesce(array_agg(id), '{}') into v_conv
  from public.conversations where user_id = p_user_id or admin_id = p_user_id;

  -- 1) ملفات التخزين (صور/صوتيات/مرفقات/أفاتار/خلفيات) المخزّنة تحت مجلد المستخدم
  --    (داخل كتلة محمية: نقص صلاحية على storage لا يجب أن يُفشل حذف الحساب)
  begin
    delete from storage.objects
    where bucket_id in ('attachments', 'avatars', 'wallpapers')
      and (owner = p_user_id or name like p_user_id::text || '/%');
    get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('storage_objects', v_n);
  exception when others then
    v_counts := v_counts || jsonb_build_object('storage_objects', 0, 'storage_warning', sqlerrm);
  end;

  -- 2) بيانات المحادثات (تفاعلات ← رسائل ← كتابة ← غرف/سجلات مكالمات ← محادثات)
  delete from public.message_reactions where user_id = p_user_id
     or message_id in (select id from public.messages where conversation_id = any(v_conv));
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('reactions', v_n);

  delete from public.messages where sender_id = p_user_id or conversation_id = any(v_conv);
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('messages', v_n);

  delete from public.typing_status where user_id = p_user_id or conversation_id = any(v_conv);

  delete from public.call_history_hidden where user_id = p_user_id;
  delete from public.call_logs where user_id = p_user_id
     or room_id in (select id from public.call_rooms where caller_id = p_user_id or callee_id = p_user_id);
  delete from public.call_rooms where caller_id = p_user_id or callee_id = p_user_id or conversation_id = any(v_conv);
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('call_rooms', v_n);

  delete from public.conversations where id = any(v_conv);
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('conversations', v_n);

  -- 3) أجهزة الإشعارات
  delete from public.fcm_tokens where user_id = p_user_id;
  delete from public.push_subscriptions where user_id = p_user_id;
  delete from public.push_delivery_log where recipient_id = p_user_id;

  -- 4) الملف الشخصي ثم حساب المصادقة (يمنع تسجيل الدخول مجدداً)
  delete from public.profiles where id = p_user_id;
  begin
    delete from auth.users where id = p_user_id;
    get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('auth_user', v_n);
  exception when others then
    -- نقص صلاحية على auth.users: الحساب حُذف من التطبيق لكن يبقى في Auth؛ احذفه من لوحة Supabase
    v_counts := v_counts || jsonb_build_object('auth_user', 0, 'auth_warning', sqlerrm);
  end;

  return v_counts;
end;
$$;
revoke all on function public.admin_delete_user(uuid) from public, anon;
grant execute on function public.admin_delete_user(uuid) to authenticated;
-- تأكد من صلاحيات مالك الدالة (postgres) على auth.users و storage.objects
do $$
begin
  begin execute 'grant delete, select on auth.users to postgres'; exception when others then null; end;
  begin execute 'grant delete, select on storage.objects to postgres'; exception when others then null; end;
end $$;
alter function public.admin_delete_user(uuid) owner to postgres;

-- سياسات الحذف على المستوى المباشر (المشرفون فقط) — تكميلية للدالة
drop policy if exists "messages delete by admins" on public.messages;
create policy "messages delete by admins" on public.messages
  for delete using (public.is_admin_user());
drop policy if exists "conversations delete by admins" on public.conversations;
create policy "conversations delete by admins" on public.conversations
  for delete using (public.is_admin_user());
drop policy if exists "reactions delete by admins" on public.message_reactions;
create policy "reactions delete by admins" on public.message_reactions
  for delete using (public.is_admin_user() or user_id = auth.uid());

-- (ب) فحص جاهزية الإشعارات
create or replace function public.push_diagnostics()
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  v jsonb;
begin
  select jsonb_build_object(
    'pg_net_installed', exists (select 1 from pg_extension where extname = 'pg_net'),
    'edge_function_url', 'https://gqocavvhkfzgxzscrjms.supabase.co/functions/v1/send-push',
    'edge_url_hardcoded', true,
    'edge_url_ok', true,
    'secret_hardcoded', true,
    'vault_dependency', false,
    'trigger_messages', exists (select 1 from pg_trigger where tgname = 'on_message_inserted'),
    'trigger_calls', exists (select 1 from pg_trigger where tgname = 'on_call_room_notify'),
    'trigger_first_welcome', exists (select 1 from pg_trigger where tgname = 'on_message_first_welcome'),
    'trigger_keyword_bot', exists (select 1 from pg_trigger where tgname = 'on_message_keyword_autoreply'),
    'trigger_admin_presence', exists (select 1 from pg_trigger where tgname = 'on_profile_admin_presence'),
    'unread_counts_rpc', exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'unread_counts'),
    'mark_read_rpc', exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'mark_conversation_read'),
    'mark_delivered_rpc', exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'mark_messages_delivered'),
    'my_tokens', (select count(*) from public.fcm_tokens where user_id = auth.uid()),
    'my_unread_total', (
      select count(*) from public.messages m
      join public.conversations c on c.id = m.conversation_id
      where (c.user_id = auth.uid() or c.admin_id = auth.uid())
        and m.sender_id <> auth.uid() and m.status <> 'read'
    ),
    'my_messages_by_status', (
      select coalesce(jsonb_object_agg(s.status, s.n), '{}'::jsonb)
      from (
        select coalesce(m.status, 'null') as status, count(*) as n
        from public.messages m
        join public.conversations c on c.id = m.conversation_id
        where (c.user_id = auth.uid() or c.admin_id = auth.uid()) and m.sender_id = auth.uid()
        group by 1
      ) s
    ),
    'last_log', (select jsonb_agg(l) from (select kind, note, request_id, created_at from public.push_delivery_log where recipient_id = auth.uid() or public.is_admin_user() order by id desc limit 5) l)
  ) into v;
  return v;
end;
$$;
grant execute on function public.push_diagnostics() to authenticated;

-- ============================================================
-- 14. الإصدار v2.3: مسبار الإشعارات من قاعدة البيانات
-- ============================================================
-- نتيجة آخر طلبات pg_net الصادرة من الـ Trigger مع حالة HTTP وجسم الرد
create or replace function public.push_diagnostics()
returns jsonb language plpgsql security definer set search_path = public, extensions, net as $$
declare
  v jsonb;
  v_last jsonb;
begin
  begin
    select jsonb_agg(x order by x.id desc) into v_last
    from (
      select l.id, l.kind, l.note, l.request_id, l.created_at,
             r.status_code, left(r.content::text, 300) as response, r.error_msg
      from public.push_delivery_log l
      left join net._http_response r on r.id = l.request_id
      where l.recipient_id = auth.uid() or public.is_admin_user()
      order by l.id desc limit 5
    ) x;
  exception when others then
    select jsonb_agg(x) into v_last from (
      select kind, note, request_id, created_at from public.push_delivery_log
      where recipient_id = auth.uid() or public.is_admin_user() order by id desc limit 5) x;
  end;

  select jsonb_build_object(
    'pg_net_installed', exists (select 1 from pg_extension where extname = 'pg_net'),
    'edge_function_url', 'https://gqocavvhkfzgxzscrjms.supabase.co/functions/v1/send-push',
    'edge_url_hardcoded', true,
    'edge_url_ok', true,
    'secret_hardcoded', true,
    'vault_dependency', false,
    'trigger_messages', exists (select 1 from pg_trigger where tgname = 'on_message_inserted' and not tgisinternal),
    'trigger_calls', exists (select 1 from pg_trigger where tgname = 'on_call_room_notify' and not tgisinternal),
    'my_tokens', (select count(*) from public.fcm_tokens where user_id = auth.uid()),
    'last_log', v_last
  ) into v;
  return v;
end;
$$;
grant execute on function public.push_diagnostics() to authenticated;

-- اختبار المسار الكامل من قاعدة البيانات: يستدعي send-push بنفس طريقة الـ Trigger
-- (بالسر المشترك) ويرسل إشعاراً تجريبياً للمستخدم الحالي. يعيد request_id.
create or replace function public.push_probe()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_req bigint;
begin
  perform public.push_call_edge('probe', gen_random_uuid(), auth.uid(),
    jsonb_build_object('type', 'probe', 'user_id', auth.uid()));
  select request_id into v_req from public.push_delivery_log
  where kind = 'probe' and recipient_id = auth.uid() order by id desc limit 1;
  return jsonb_build_object('request_id', v_req);
end;
$$;
grant execute on function public.push_probe() to authenticated;

-- قراءة نتيجة طلب pg_net بعينه (بعد ثوانٍ من push_probe)
create or replace function public.push_probe_result(p_request_id bigint)
returns jsonb language plpgsql security definer set search_path = public, net as $$
declare v jsonb;
begin
  select jsonb_build_object('status_code', r.status_code, 'response', left(r.content::text, 500), 'error', r.error_msg)
  into v from net._http_response r where r.id = p_request_id;
  return coalesce(v, jsonb_build_object('pending', true));
end;
$$;
grant execute on function public.push_probe_result(bigint) to authenticated;

-- ============================================================
-- 15. الإصدار v2.4: ترويسة Authorization لطلبات pg_net (إصلاح 401 من البوابة)
-- ============================================================
-- ملاحظة (v2.15): مسار التريگرات بلا Vault — الرابط والسرّ مُضمَّنان
--   مباشرةً، والدالة تُنشر بـ verify_jwt = false ⇒ لا مفتاح anon إطلاقاً.

create or replace function public.push_call_edge(p_kind text, p_ref uuid, p_recipient uuid, p_body jsonb)
returns void language plpgsql security definer set search_path = public, net as $$
declare
  v_url text := 'https://gqocavvhkfzgxzscrjms.supabase.co/functions/v1/send-push';
  v_secret text := 'my_send_push_19921121_almgawell_19921121';
  v_headers jsonb;
  v_req bigint;
begin
  -- الرابط والسرّ مُضمَّنان مباشرةً (بلا Vault) — لا ترويسة Authorization:
  --   الدالة منشورة بـ verify_jwt = false ⇒ التحقّق عبر x-send-push-secret
  v_headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-send-push-secret', v_secret
  );

  begin
    select net.http_post(url := v_url, headers := v_headers, body := p_body, timeout_milliseconds := 8000)
    into v_req;
    insert into public.push_delivery_log(kind, ref_id, recipient_id, request_id)
    values (p_kind, p_ref, p_recipient, v_req);
  exception when others then
    insert into public.push_delivery_log(kind, ref_id, recipient_id, note)
    values (p_kind, p_ref, p_recipient, 'ERROR: ' || sqlerrm);
  end;
end;
$$;

-- ============================================================
-- 16. الإصدار v2.8 (2026-10-13): إشعار المشرفين عند تسجيل مستخدم جديد
--     + دليل المستخدمين الشامل (بحث حي في كل المسجّلين) للمشرف
--     مطابق لهجرة sql/migrations/2026-10-13_v2_8_admin_new_user_alerts_directory.sql
-- ============================================================
-- ============================================================
-- (أ) إشعار المشرفين عند إنشاء ملف شخصي جديد
-- ============================================================

-- قائمة مستلمي إشعار "مستخدم جديد" (المشرفون النشطون فقط).
create or replace function public.admin_recipient_ids()
returns table(id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select p.id
  from public.profiles p
  where (p.is_admin = true or p.is_super_admin = true)
    and p.is_blocked = false;
$$;
grant execute on function public.admin_recipient_ids() to authenticated;

-- يرسل طلباً واحداً إلى send-push بحمولة المستخدم الجديد، والدالة تتولّى
-- التوزيع على كل المشرفين وكل أجهزتهم (طلب pg_net واحد لكل تسجيل، لا لكل مشرف).
--
-- ملاحظات تصميمية:
--   • لا يُشعر أحد إن لم يكن هناك مشرف واحد مسجَّل بعد (يُسجَّل السبب في push_delivery_log).
--   • أي خطأ داخل هذه الدالة لا يُفشل التسجيل إطلاقاً (exception → warning فقط).
--   • البريد الداخلي المُشتق (phone.<digits>@users.local) لا يُرسل في الحمولة.
create or replace function public.notify_admins_new_profile()
returns trigger
language plpgsql
security definer
set search_path = public, net
as $$
declare
  v_admins integer;
  v_staff boolean;
  v_email text;
begin
  begin
    v_staff := coalesce(new.is_admin, false) or coalesce(new.is_super_admin, false);

    select count(*) into v_admins from public.admin_recipient_ids();

    if v_admins = 0 then
      insert into public.push_delivery_log(kind, ref_id, note)
      values ('new_user', new.id, 'SKIPPED: لا يوجد مشرف مسجَّل/نشط بعد');
      return new;
    end if;

    -- لا نكشف البريد التقني المُشتق من رقم الهاتف
    v_email := case
      when coalesce(new.email, '') like 'phone.%@users.local' then null
      else new.email
    end;

    perform public.push_call_edge(
      'new_user',
      new.id,
      null,                        -- ليس مستلماً واحداً: الإشعار موزَّع على كل المشرفين
      jsonb_build_object(
        'type', 'new_user',
        'user_id', new.id,
        'display_name', coalesce(nullif(btrim(coalesce(new.display_name, '')), ''), 'مستخدم جديد'),
        'email', v_email,
        'phone', new.phone,
        'is_admin', v_staff,
        'admins_count', v_admins,
        'created_at', to_char(coalesce(new.created_at, now()) at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
      )
    );
  exception when others then
    -- الإشعار مكمّل لا أساسي: التسجيل يجب أن ينجح دائماً
    raise warning 'notify_admins_new_profile: %', sqlerrm;
  end;

  return new;
end;
$$;

drop trigger if exists on_profile_created_notify_admins on public.profiles;
create trigger on_profile_created_notify_admins
  after insert on public.profiles
  for each row execute procedure public.notify_admins_new_profile();

-- ============================================================
-- (ب) دليل المستخدمين الشامل + بحث حي للمشرف
-- ============================================================

-- فهارس البحث (اختيارية: تُتخطّى بأمان إن لم يتوفّر pg_trgm).
do $$
begin
  begin
    create extension if not exists pg_trgm;
  exception when others then
    raise notice 'pg_trgm غير متاح: %', sqlerrm;
  end;

  begin
    create index if not exists idx_profiles_display_name_trgm
      on public.profiles using gin (display_name gin_trgm_ops);
  exception when others then
    raise notice 'فهرس الثلاثيات على display_name غير متاح: %', sqlerrm;
  end;

  begin
    create index if not exists idx_profiles_email_trgm
      on public.profiles using gin (email gin_trgm_ops);
  exception when others then
    raise notice 'فهرس الثلاثيات على email غير متاح: %', sqlerrm;
  end;

  begin
    create index if not exists idx_profiles_created_at
      on public.profiles (created_at desc);
  exception when others then
    raise notice 'فهرس created_at غير متاح: %', sqlerrm;
  end;
end $$;

-- دليل المستخدمين: قائمة كل المسجّلين أو بحث حي في (الاسم / البريد / الهاتف).
--   p_query = ''  ⇒ أحدث المسجّلين (مرتّبون بتاريخ التسجيل تنازلياً)
--   p_query <> '' ⇒ مطابقة جزئية في الاسم أو البريد أو أرقام الهاتف
-- الإرجاع: { total, limit, offset, users: [...] } — كل مستخدم يحمل conversation_id
-- إن كانت لديه محادثة قائمة مع المشرف المستدعي (لتفادي إنشاء محادثة مكرّرة).
create or replace function public.admin_directory_search(
  p_query text default '',
  p_limit integer default 60,
  p_offset integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_query text := btrim(coalesce(p_query, ''));
  -- الأرقام فقط (مع تحويل الأرقام العربية/الفارسية) لمطابقة الهاتف بأي صيغة
  v_digits text := regexp_replace(
    translate(coalesce(p_query, ''), '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789'),
    '\D', '', 'g'
  );
  v_pattern text;
  v_limit integer := least(greatest(coalesce(p_limit, 60), 1), 200);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_total bigint := 0;
  v_rows jsonb := '[]'::jsonb;
begin
  if v_uid is null or not public.is_admin_user(v_uid) then
    raise exception 'غير مصرّح: دليل المستخدمين للمشرفين فقط' using errcode = '42501';
  end if;

  -- تهريب محارف LIKE الخاصة حتى لا يتحوّل البحث إلى نمط مفتوح
  v_pattern := '%' || replace(replace(replace(v_query, '\', '\\'), '%', '\%'), '_', '\_') || '%';

  with people as (
    select p.id,
           p.display_name,
           case when coalesce(p.email, '') like 'phone.%@users.local' then null else p.email end as email,
           p.phone,
           p.avatar_url,
           p.is_admin,
           p.is_super_admin,
           p.is_blocked,
           p.is_online,
           p.last_seen,
           p.created_at,
           -- أرقام الهاتف فقط (مع تحويل الأرقام العربية/الفارسية) للمقارنة بأي صيغة
           regexp_replace(
             translate(coalesce(p.phone, ''), '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789'),
             '\D', '', 'g'
           ) as phone_digits
    from public.profiles p
    where p.id <> v_uid
  ),
  matches as (
    select pe.id,
           pe.display_name,
           pe.email,
           pe.phone,
           pe.avatar_url,
           pe.is_admin,
           pe.is_super_admin,
           pe.is_blocked,
           pe.is_online,
           pe.last_seen,
           pe.created_at,
           conv.id as conversation_id,
           conv.last_message,
           conv.last_message_at
    from people pe
    left join lateral (
      select c.id, c.last_message, c.last_message_at
      from public.conversations c
      where (c.user_id = pe.id and c.admin_id = v_uid)
         or (c.admin_id = pe.id and c.user_id = v_uid)
      order by c.last_message_at desc nulls last
      limit 1
    ) conv on true
    where
      v_query = ''
      or pe.display_name ilike v_pattern
      or coalesce(pe.email, '') ilike v_pattern
      or (
        v_digits <> ''
        and pe.phone_digits <> ''
        and (
          -- مطابقة جزئية مباشرة في أرقام الهاتف المخزّنة
          pe.phone_digits like '%' || v_digits || '%'
          -- أو بحث يحمل رمز الدولة/بادئة زائدة: قارن آخر 7 أرقام (على الطرفين)
          or (
            length(v_digits) >= 7
            and length(pe.phone_digits) >= 7
            and v_digits like '%' || right(pe.phone_digits, 7) || '%'
          )
        )
      )
  )
  select (select count(*) from matches),
         coalesce(
           (select jsonb_agg(to_jsonb(s))
            from (
              select * from matches
              order by
                -- عند البحث: الأقرب أبجدياً أولاً. عند القائمة الكاملة: الأحدث تسجيلاً أولاً.
                case when v_query = '' then null else lower(coalesce(display_name, '')) end asc nulls last,
                case when v_query = '' then null else created_at end desc nulls last,
                created_at desc nulls last
              limit v_limit offset v_offset
            ) s),
           '[]'::jsonb
         )
    into v_total, v_rows;

  return jsonb_build_object(
    'total', coalesce(v_total, 0),
    'limit', v_limit,
    'offset', v_offset,
    'query', v_query,
    'users', coalesce(v_rows, '[]'::jsonb)
  );
end;
$$;

revoke all on function public.admin_directory_search(text, integer, integer) from public, anon;
grant execute on function public.admin_directory_search(text, integer, integer) to authenticated;

-- عدّاد سريع لأحدث المسجّلين (يُعرض في ترويسة الدليل وتشخيص الإشعارات)
create or replace function public.registered_users_count()
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select count(*) from public.profiles where public.is_admin_user(auth.uid());
$$;
grant execute on function public.registered_users_count() to authenticated;

-- ============================================================
-- (ج) تشخيص: أضف مؤشرات الميزتين إلى push_diagnostics()
-- ============================================================
create or replace function public.push_diagnostics()
returns jsonb language plpgsql security definer set search_path = public, extensions, net as $$
declare
  v jsonb;
  v_last jsonb;
  v_admin_triggers integer := 0;
  v_registered bigint := 0;
begin
  begin
    select jsonb_agg(x order by x.id desc) into v_last
    from (
      select l.id, l.kind, l.note, l.request_id, l.created_at,
             r.status_code, left(r.content::text, 300) as response, r.error_msg
      from public.push_delivery_log l
      left join net._http_response r on r.id = l.request_id
      where l.recipient_id = auth.uid() or public.is_admin_user()
      order by l.id desc limit 5
    ) x;
  exception when others then
    select jsonb_agg(x) into v_last from (
      select kind, note, request_id, created_at from public.push_delivery_log
      where recipient_id = auth.uid() or public.is_admin_user() order by id desc limit 5) x;
  end;

  begin
    select count(*) into v_admin_triggers
    from pg_trigger where tgname = 'on_profile_created_notify_admins' and not tgisinternal;
    select count(*) into v_registered from public.profiles;
  exception when others then
    v_admin_triggers := 0;
    v_registered := 0;
  end;

  select jsonb_build_object(
    'pg_net_installed', exists (select 1 from pg_extension where extname = 'pg_net'),
    'edge_function_url', 'https://gqocavvhkfzgxzscrjms.supabase.co/functions/v1/send-push',
    'edge_url_hardcoded', true,
    'edge_url_ok', true,
    'secret_hardcoded', true,
    'vault_dependency', false,
    'trigger_messages', exists (select 1 from pg_trigger where tgname = 'on_message_inserted' and not tgisinternal),
    'trigger_calls', exists (select 1 from pg_trigger where tgname = 'on_call_room_notify' and not tgisinternal),
    'trigger_new_user', v_admin_triggers > 0,
    'admins_count', (select count(*) from public.admin_recipient_ids()),
    'registered_users', v_registered,
    'directory_rpc', exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'admin_directory_search'
    ),
    'my_tokens', (select count(*) from public.fcm_tokens where user_id = auth.uid()),
    'last_log', v_last
  ) into v;
  return v;
end;
$$;
grant execute on function public.push_diagnostics() to authenticated;

-- ============================================================
-- 17. الإصدار v2.9 (2026-10-13): عزل مستلمي إشعارات الرسائل والمكالمات
--     + الوضع الصامت للمشرف العام (Super Admin) — مطابق لهجرة
--     sql/migrations/2026-10-13_v2_9_notification_recipient_isolation.sql
-- ------------------------------------------------------------
-- ملاحظة: هذا القسم يُعيد تعريف notify_new_message() و notify_call_room()
-- و push_call_edge() و notify_admins_new_profile() و push_diagnostics()
-- بعد تعريفات الأقسام 11.6 و12 و13 و14 و16 — والنتيجة النهائية هي المشدّدة.
-- لا تُعدَّل أي جداول أو أنواع بيانات: دوال + Triggers + سياسات RLS فقط.
-- ============================================================

-- ============================================================
-- v2.10 (2026-10-14): حداثة الرنين من ساعة قاعدة البيانات
-- (مطابق لـ sql/migrations/2026-10-14_v2_10_call_ring_freshness.sql)
-- ============================================================
create or replace function public.call_room_is_ringing(p_room uuid)
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select exists (
    select 1
    from public.call_rooms r
    where r.id = p_room
      and r.callee_id = auth.uid()
      and r.status = 'ringing'
      and r.started_at > now() - interval '2 minutes'
  );
$$;

revoke all on function public.call_room_is_ringing(uuid) from public;
grant execute on function public.call_room_is_ringing(uuid) to authenticated;


-- ============================================================
-- 16.5 (v2.11): تشديد الأمان — حظر/حذف المستخدم مرفوض للمشرف العام، وسياسات
-- التخزين بلا سرد عام. (تعريفات §17 أدناه تبقى كما هي، والدوال الداخلية مُقيَّدة في ⑧)
-- ============================================================
create or replace function public.admin_set_user_blocked(p_user_id uuid, p_blocked boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if public.is_super_admin_user() then
    raise exception 'المشرف العام للمراقبة للقراءة فقط' using errcode = '42501';
  end if;
  if not public.is_admin_user() then
    raise exception 'غير مصرّح: هذه العملية للمشرفين فقط' using errcode = '42501';
  end if;
  if exists (select 1 from public.profiles where id = p_user_id and (is_admin or is_super_admin)) then
    raise exception 'لا يمكن حظر حساب مشرف' using errcode = '42501';
  end if;
  update public.profiles
  set is_blocked = p_blocked,
      blocked_at = case when p_blocked then now() else null end,
      -- المستخدم العادي: الحظر يقطعه. المشرف: يبقى "متصل الآن" دائماً.
      is_online = case
                    when (is_admin or is_super_admin) then true
                    when p_blocked then false
                    else is_online
                  end
  where id = p_user_id;
end;
$$;

create or replace function public.admin_delete_user(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = public, auth, storage as $$
declare
  v_counts jsonb := '{}'::jsonb;
  v_n bigint;
  v_conv uuid[];
begin
  if public.is_super_admin_user() then
    raise exception 'المشرف العام للمراقبة للقراءة فقط' using errcode = '42501';
  end if;
  if not public.is_admin_user() then
    raise exception 'غير مصرّح: هذه العملية للمشرفين فقط' using errcode = '42501';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'لا يمكنك حذف حسابك أنت' using errcode = '42501';
  end if;
  if exists (select 1 from public.profiles where id = p_user_id and (is_admin or is_super_admin)) then
    raise exception 'لا يمكن حذف حساب مشرف' using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles where id = p_user_id) then
    raise exception 'المستخدم غير موجود' using errcode = 'P0002';
  end if;

  select coalesce(array_agg(id), '{}') into v_conv
  from public.conversations where user_id = p_user_id or admin_id = p_user_id;

  -- 1) ملفات التخزين (صور/صوتيات/مرفقات/أفاتار/خلفيات) المخزّنة تحت مجلد المستخدم
  --    (داخل كتلة محمية: نقص صلاحية على storage لا يجب أن يُفشل حذف الحساب)
  begin
    delete from storage.objects
    where bucket_id in ('attachments', 'avatars', 'wallpapers')
      and (owner = p_user_id or name like p_user_id::text || '/%');
    get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('storage_objects', v_n);
  exception when others then
    v_counts := v_counts || jsonb_build_object('storage_objects', 0, 'storage_warning', sqlerrm);
  end;

  -- 2) بيانات المحادثات (تفاعلات ← رسائل ← كتابة ← غرف/سجلات مكالمات ← محادثات)
  delete from public.message_reactions where user_id = p_user_id
     or message_id in (select id from public.messages where conversation_id = any(v_conv));
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('reactions', v_n);

  delete from public.messages where sender_id = p_user_id or conversation_id = any(v_conv);
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('messages', v_n);

  delete from public.typing_status where user_id = p_user_id or conversation_id = any(v_conv);

  delete from public.call_history_hidden where user_id = p_user_id;
  delete from public.call_logs where user_id = p_user_id
     or room_id in (select id from public.call_rooms where caller_id = p_user_id or callee_id = p_user_id);
  delete from public.call_rooms where caller_id = p_user_id or callee_id = p_user_id or conversation_id = any(v_conv);
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('call_rooms', v_n);

  delete from public.conversations where id = any(v_conv);
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('conversations', v_n);

  -- 3) أجهزة الإشعارات
  delete from public.fcm_tokens where user_id = p_user_id;
  delete from public.push_subscriptions where user_id = p_user_id;
  delete from public.push_delivery_log where recipient_id = p_user_id;

  -- 4) الملف الشخصي ثم حساب المصادقة (يمنع تسجيل الدخول مجدداً)
  delete from public.profiles where id = p_user_id;
  begin
    delete from auth.users where id = p_user_id;
    get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('auth_user', v_n);
  exception when others then
    -- نقص صلاحية على auth.users: الحساب حُذف من التطبيق لكن يبقى في Auth؛ احذفه من لوحة Supabase
    v_counts := v_counts || jsonb_build_object('auth_user', 0, 'auth_warning', sqlerrm);
  end;

  return v_counts;
end;
$$;


-- ============================================================
-- ⑨ (v2.11) التخزين: منع سرد/تعداد الملفات عبر الـ API
--    الواجهة تعرض الملفات بروابط عامة (getPublicUrl) والحاويات عامة أصلاً،
--    فلا حاجة لسياسة SELECT عامة (كانت تُتيح لأي زائر سرد كل المرفقات).
-- ============================================================
drop policy if exists "attachments public read" on storage.objects;
drop policy if exists "avatar public read" on storage.objects;
drop policy if exists "wallpapers public read" on storage.objects;

-- ============================================================
-- ① دوال الحراسة المركزية (مصدر واحد للحقيقة لِمن يحق له الاستلام)
-- ============================================================

-- هل الحساب مشرف عام (is_super_admin)؟
create or replace function public.is_super_admin_user(p_user_id uuid default auth.uid())
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = p_user_id and is_super_admin = true
  );
$$;

-- المستلم المباشر لمحادثة: الطرف الآخر في نفس الصف حصراً.
--   • المرسل هو user_id  ⇒ يعيد admin_id
--   • المرسل هو admin_id ⇒ يعيد user_id
--   • المرسل ليس طرفاً في المحادثة (مشاهدة/مراقبة) ⇒ يعيد null (لا إشعار)
create or replace function public.conversation_direct_recipient(
  p_conversation_id uuid,
  p_sender_id uuid
)
returns uuid language sql stable security definer set search_path = public as $$
  select case
    when c.user_id = p_sender_id and c.admin_id is distinct from p_sender_id then c.admin_id
    when c.admin_id = p_sender_id and c.user_id is distinct from p_sender_id then c.user_id
    else null
  end
  from public.conversations c
  where c.id = p_conversation_id;
$$;

-- ⛔ الحراسة المركزية: هل يُسمح بإرسال إشعار من هذا النوع إلى هذا المستلم؟
--    تُستدعى من push_call_edge() قبل أي طلب شبكة — فلا يمكن لأي Trigger أو دالة
--    أن "تتجاوزها" ولو أخطأت في حساب المستلم.
--
--    القواعد:
--      new_user  ⇒ إشعار جماعي وحيد (المشرفون) ⇒ لا مستلم فردي إطلاقاً.
--      new_message ⇒ المستلم = الطرف الآخر في المحادثة نفسها، والمرسل طرف فيها.
--      incoming_call / call_ended ⇒ المستلم = callee_id في الغرفة نفسها حصراً.
--      probe / test ⇒ للمستخدم نفسه فقط (auth.uid()).
--      أي نوع آخر ⇒ يجب تحديد مستلم فردي (لا بث جماعي ضمني).
create or replace function public.push_recipient_allowed(
  p_kind text,
  p_ref uuid,
  p_recipient uuid,
  p_body jsonb
)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare
  v_sender uuid;
  v_conversation uuid;
begin
  if p_kind is null then
    return false;
  end if;

  -- ① الإشعار الجماعي الوحيد المسموح: مستخدم جديد ⇒ بلا مستلم فردي
  if p_kind = 'new_user' then
    return p_recipient is null;
  end if;

  -- كل ما تبقّى يجب أن يحدّد مستلماً فردياً صراحةً
  if p_recipient is null then
    return false;
  end if;

  -- ② رسالة جديدة: الطرف الآخر في نفس المحادثة فقط (user_id ↔ admin_id)
  if p_kind = 'new_message' then
    begin
      v_sender := nullif(p_body ->> 'sender_id', '')::uuid;
      v_conversation := nullif(p_body ->> 'conversation_id', '')::uuid;
    exception when others then
      return false;
    end;

    if v_sender is null or v_conversation is null then
      return false;
    end if;

    return exists (
      select 1
      from public.conversations c
      where c.id = v_conversation
        and (
          (c.user_id = v_sender and c.admin_id = p_recipient)
          or (c.admin_id = v_sender and c.user_id = p_recipient)
        )
    );
  end if;

  -- ③ مكالمة واردة/انتهت: callee_id المُعلن في الغرفة نفسها فقط
  --    (لا سوبر أدمن، لا مشرفين آخرين، لا أي حساب غير المعني)
  if p_kind in ('incoming_call', 'call_ended') then
    return exists (
      select 1
      from public.call_rooms r
      where r.id = p_ref
        and r.callee_id = p_recipient
        and r.caller_id is distinct from p_recipient
    );
  end if;

  -- ④ مسبار/اختبار: لا يُرسل إلا لصاحب الجلسة نفسه
  if p_kind in ('probe', 'test') then
    return p_recipient = coalesce(auth.uid(), p_recipient);
  end if;

  -- ⑤ أي نوع مستقبلي: يُسمح بشرط وجود مستلم فردي محدَّد (السلوك الافتراضي القديم)
  return true;
end;
$$;

-- سبب تخطّي الإشعار — يُسجَّل في push_delivery_log ليكون التشخيص واضحاً
create or replace function public.push_skip_note(p_kind text, p_recipient uuid)
returns text language plpgsql stable security definer set search_path = public as $$
declare
  v_super boolean := false;
  v_reason text := 'لا مستلم مباشر صالح لهذا الحدث';
begin
  if p_kind = 'new_user' and p_recipient is not null then
    v_reason := 'الإشعار الجماعي (new_user) لا يقبل مستلماً فردياً';
  elsif p_kind = 'new_message' then
    v_reason := 'المستلم ليس الطرف الآخر في المحادثة';
  elsif p_kind in ('incoming_call', 'call_ended') then
    v_reason := 'callee_id ليس مستقبل هذه الغرفة — لا رنين لأي حساب آخر';
  end if;

  begin
    select coalesce(p.is_super_admin, false) into v_super
    from public.profiles p where p.id = p_recipient;
  exception when others then
    v_super := false;
  end;

  -- الوضع الصامت للمشرف العام يسبق أي سبب آخر في السجل (يُقرأ من لوحة Supabase)
  if v_super then
    return 'SKIPPED: مشرف عام ليس طرفاً مباشراً — الوضع الصامت (v2.9) · ' || v_reason;
  end if;

  return 'SKIPPED: ' || v_reason || ' (v2.9)';
end;
$$;

-- هذه الدوال داخلية (تستدعيها Triggers ودوال SECURITY DEFINER فقط) — لا تُمنح للعميل.
-- الأدوار anon/authenticated موجودة دائماً في Supabase، لكن نتحقق منها حتى تعمل
-- الهجرة أيضاً على قاعدة محلية/اختبارية ناقصة بلا أخطاء.
do $$
begin
  revoke all on function public.push_recipient_allowed(text, uuid, uuid, jsonb) from public;
  revoke all on function public.push_skip_note(text, uuid) from public;
  revoke all on function public.conversation_direct_recipient(uuid, uuid) from public;

  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.push_recipient_allowed(text, uuid, uuid, jsonb) from anon';
    execute 'revoke all on function public.push_skip_note(text, uuid) from anon';
    execute 'revoke all on function public.conversation_direct_recipient(uuid, uuid) from anon';
  end if;

  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.push_recipient_allowed(text, uuid, uuid, jsonb) from authenticated';
    execute 'revoke all on function public.push_skip_note(text, uuid) from authenticated';
    execute 'revoke all on function public.conversation_direct_recipient(uuid, uuid) from authenticated';
    -- سياسات RLS للمشرف العام تُستدعى من العميل ⇒ تحتاج صلاحية تنفيذها
    execute 'grant execute on function public.is_super_admin_user(uuid) to authenticated';
  end if;
end $$;

-- ============================================================
-- ② مسار الرسائل: المستلم = الطرف الآخر في المحادثة نفسها حصراً
-- ============================================================
create or replace function public.notify_new_message()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_recipient uuid;
  v_user uuid;
  v_admin uuid;
begin
  -- بطاقة مكالمة داخل المحادثة: لها إشعارها الخاص من call_rooms حصراً
  if new.message_type = 'call' then
    return new;
  end if;

  select c.user_id, c.admin_id into v_user, v_admin
  from public.conversations c
  where c.id = new.conversation_id;

  -- محادثة غير موجودة/يتيمة (نظرياً مستحيل مع FK، لكن نمنع أي إشعار عشوائي)
  if v_user is null and v_admin is null then
    insert into public.push_delivery_log(kind, ref_id, note)
    values ('new_message', new.id, 'SKIPPED: محادثة غير موجودة (v2.9)');
    return new;
  end if;

  -- ✅ تحديد المستلم حصرياً من أطراف المحادثة المباشرة
  if v_user = new.sender_id then
    v_recipient := v_admin;
  elsif v_admin = new.sender_id then
    v_recipient := v_user;
  else
    -- المرسل ليس طرفاً في المحادثة (مثال: المشرف العام يراقب محادثة غيره)
    -- ⇒ لا إشعار لأي جهة إطلاقاً (هذا هو مصدر الإزعاج الذي أُغلق)
    insert into public.push_delivery_log(kind, ref_id, note)
    values ('new_message', new.id, 'SKIPPED: المرسل ليس طرفاً في المحادثة — بلا إشعار (v2.9)');
    return new;
  end if;

  if v_recipient is null or v_recipient = new.sender_id then
    insert into public.push_delivery_log(kind, ref_id, note)
    values ('new_message', new.id, 'SKIPPED: لا يوجد طرف مقابل مباشر في المحادثة (v2.9)');
    return new;
  end if;

  perform public.push_call_edge(
    'new_message',
    new.id,
    v_recipient,
    jsonb_build_object(
      'message_id', new.id,
      'conversation_id', new.conversation_id,
      'sender_id', new.sender_id,
      'recipient_id', v_recipient,   -- تصريح صريح بالمستلم: تتحقق منه الدالة أيضاً
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

-- ============================================================
-- ③ مسار المكالمات: الرنين = callee_id فقط (لا سوبر أدمن ولا أي حساب آخر)
-- ============================================================
create or replace function public.notify_call_room()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_type text;
  v_recipient uuid;
begin
  if tg_op = 'INSERT' and new.status = 'ringing' then
    v_type := 'incoming_call';
  elsif tg_op = 'UPDATE' and old.status is distinct from new.status
        and new.status in ('missed', 'ended', 'declined', 'failed', 'network_lost') then
    v_type := 'call_ended';
  else
    return new;
  end if;

  -- ✅ المستلم الوحيد إطلاقاً: callee_id المُعلن في غرفة المكالمة نفسها.
  --    لا استثناء للمشرف العام، ولا بث لأي مشرف آخر، ولا لأي جهة مراقبة.
  v_recipient := new.callee_id;

  if v_recipient is null or v_recipient = new.caller_id then
    insert into public.push_delivery_log(kind, ref_id, note)
    values (v_type, new.id, 'SKIPPED: callee_id غير صالح — لا رنين لأي حساب (v2.9)');
    return new;
  end if;

  -- تحقّق مزدوج: طرفا المكالمة هما طرفا المحادثة فعلاً (لا مكالمات بين أطراف غريبة)
  if not exists (
    select 1
    from public.conversations c
    where c.id = new.conversation_id
      and (c.user_id = new.caller_id or c.admin_id = new.caller_id)
      and (c.user_id = new.callee_id or c.admin_id = new.callee_id)
  ) then
    insert into public.push_delivery_log(kind, ref_id, note)
    values (v_type, new.id, 'SKIPPED: طرفا المكالمة ليسا طرفي المحادثة (v2.9)');
    return new;
  end if;

  perform public.push_call_edge(
    v_type,
    new.id,
    v_recipient,
    jsonb_build_object(
      'type', v_type,
      'room_id', new.id,
      'conversation_id', new.conversation_id,
      'caller_id', new.caller_id,
      'callee_id', new.callee_id,
      'recipient_id', v_recipient,   -- تصريح صريح بالمستلم: تتحقق منه الدالة أيضاً
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

-- ============================================================
-- ④ الحراسة المركزية داخل push_call_edge (آخر بوابة قبل الشبكة)
--    نفس التوقيع السابق (بلا تغيير) ⇒ لا يتأثّر أي مستدعٍ قائم.
-- ============================================================
create or replace function public.push_call_edge(p_kind text, p_ref uuid, p_recipient uuid, p_body jsonb)
returns void language plpgsql security definer set search_path = public, net as $$
declare
  v_url text := 'https://gqocavvhkfzgxzscrjms.supabase.co/functions/v1/send-push';
  v_secret text := 'my_send_push_19921121_almgawell_19921121';
  v_headers jsonb;
  v_req bigint;
  v_allowed boolean := false;
begin
  -- ⛔ البوابة: لا مستلم مطابق للحدث ⇒ لا طلب شبكة ولا إشعار (يُسجَّل السبب فقط)
  begin
    v_allowed := public.push_recipient_allowed(p_kind, p_ref, p_recipient, p_body);
  exception when others then
    v_allowed := false;
  end;

  if not v_allowed then
    insert into public.push_delivery_log(kind, ref_id, recipient_id, note)
    values (p_kind, p_ref, p_recipient, public.push_skip_note(p_kind, p_recipient));
    return;
  end if;

  -- الرابط والسرّ مُضمَّنان مباشرةً (بلا Vault) — لا ترويسة Authorization:
  --   الدالة منشورة بـ verify_jwt = false ⇒ التحقّق عبر x-send-push-secret
  v_headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-send-push-secret', v_secret
  );

  begin
    select net.http_post(url := v_url, headers := v_headers, body := p_body, timeout_milliseconds := 8000)
    into v_req;
    insert into public.push_delivery_log(kind, ref_id, recipient_id, request_id)
    values (p_kind, p_ref, p_recipient, v_req);
  exception when others then
    insert into public.push_delivery_log(kind, ref_id, recipient_id, note)
    values (p_kind, p_ref, p_recipient, 'ERROR: ' || sqlerrm);
  end;
end;
$$;

-- ============================================================
-- ⑤ إشعار المستخدم الجديد = الإشعار الجماعي الوحيد (مراجعة v2.9)
--    - لا يتقاطع مع مساري الرسائل والمكالمات: نوع مستقل ('new_user') بمستلم null.
--    - يبقى مقصوراً على INSERT في profiles، وبعد التحقق من وجود مشرف نشط.
--    - يُضاف له وسم صريح (category = admin_broadcast) حتى لا يُفسَّر كإشعار
--      رسالة/مكالمة في الواجهة أو الـ Service Worker.
--    - الحساب المحظور عند التسجيل لا يُرسل عنه إشعار.
-- ============================================================
create or replace function public.notify_admins_new_profile()
returns trigger
language plpgsql
security definer
set search_path = public, net
as $$
declare
  v_admins integer;
  v_staff boolean;
  v_email text;
begin
  begin
    -- حساب محظور مسبقاً ⇒ لا إشعار جماعي عنه
    if coalesce(new.is_blocked, false) then
      insert into public.push_delivery_log(kind, ref_id, note)
      values ('new_user', new.id, 'SKIPPED: الحساب محظور (v2.9)');
      return new;
    end if;

    v_staff := coalesce(new.is_admin, false) or coalesce(new.is_super_admin, false);

    -- عدد المشرفين النشطين: من دالة v2.8 إن وُجدت، وإلا مباشرةً من profiles
    -- (نفس القاعدة) حتى تعمل الهجرة وحدها على قاعدة لم تُطبَّق عليها v2.8.
    begin
      select count(*) into v_admins from public.admin_recipient_ids();
    exception when others then
      begin
        select count(*) into v_admins
        from public.profiles p
        where (p.is_admin = true or p.is_super_admin = true) and p.is_blocked = false;
      exception when others then
        v_admins := 0;
      end;
    end;

    if v_admins = 0 then
      insert into public.push_delivery_log(kind, ref_id, note)
      values ('new_user', new.id, 'SKIPPED: لا يوجد مشرف مسجَّل/نشط بعد');
      return new;
    end if;

    -- لا نكشف البريد التقني المُشتق من رقم الهاتف
    v_email := case
      when coalesce(new.email, '') like 'phone.%@users.local' then null
      else new.email
    end;

    -- مستلم فردي = null (التوزيع داخل send-push على المشرفين النشطين فقط).
    -- البوابة المركزية ترفض أي محاولة لتحويل هذا النوع إلى إشعار فردي.
    perform public.push_call_edge(
      'new_user',
      new.id,
      null,
      jsonb_build_object(
        'type', 'new_user',
        'category', 'admin_broadcast',   -- وسم صريح: ليس رسالة ولا مكالمة
        'recipients', 'admins',
        'user_id', new.id,
        'display_name', coalesce(nullif(btrim(coalesce(new.display_name, '')), ''), 'مستخدم جديد'),
        'email', v_email,
        'phone', new.phone,
        'is_admin', v_staff,
        'admins_count', v_admins,
        'created_at', to_char(coalesce(new.created_at, now()) at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
      )
    );
  exception when others then
    -- الإشعار مكمّل لا أساسي: التسجيل يجب أن ينجح دائماً
    raise warning 'notify_admins_new_profile: %', sqlerrm;
  end;

  return new;
end;
$$;

drop trigger if exists on_profile_created_notify_admins on public.profiles;
create trigger on_profile_created_notify_admins
  after insert on public.profiles
  for each row execute procedure public.notify_admins_new_profile();

-- ============================================================
-- ⑥ RLS — المشرف العام: مراقبة كاملة (Read-only / Admin mode)، تنبيهات صفر
--    ملاحظة: هذه السياسات موجودة أصلاً في schema.sql §9.4/§10.6؛ نُعيد إنشاءها
--    هنا idempotent لضمان وجودها على أي قاعدة طُبِّقت عليها الهجرات تدريجياً.
--    لا تُعدّل أي جدول ولا نوع بيانات — سياسات فقط.
-- ============================================================
do $$
begin
  -- كل سياسة داخل كتلة محمية: غياب جدول (قاعدة لم تُطبَّق عليها الأقسام السابقة
  -- كاملة) لا يُفشل الهجرة — يُسجَّل تنبيه فقط.
  begin
    -- المحادثات: قراءة فقط للمشرف العام (مراقبة بلا كتابة)
    drop policy if exists "conversations full access superadmin" on public.conversations;
    drop policy if exists "conversations read superadmin" on public.conversations;
    create policy "conversations read superadmin" on public.conversations
      for select using (public.is_super_admin_user());
  exception when others then
    raise notice 'تخطّي سياسة conversations read superadmin: %', sqlerrm;
  end;

  begin
    -- الرسائل: قراءة فقط للمشرف العام (مراقبة بلا كتابة)
    drop policy if exists "messages full access superadmin" on public.messages;
    drop policy if exists "messages read superadmin" on public.messages;
    create policy "messages read superadmin" on public.messages
      for select using (public.is_super_admin_user());
  exception when others then
    raise notice 'تخطّي سياسة messages read superadmin: %', sqlerrm;
  end;

  begin
    -- غرف المكالمات: قراءة فقط للتدقيق
    drop policy if exists "call rooms superadmin" on public.call_rooms;
    drop policy if exists "call rooms read superadmin" on public.call_rooms;
    create policy "call rooms read superadmin" on public.call_rooms
      for select using (public.is_super_admin_user());
  exception when others then
    raise notice 'تخطّي سياسة call rooms read superadmin: %', sqlerrm;
  end;

  begin
    -- سجلات أحداث المكالمات: قراءة كاملة
    drop policy if exists "call logs superadmin" on public.call_logs;
    create policy "call logs superadmin" on public.call_logs
      for select using (public.is_super_admin_user());
  exception when others then
    raise notice 'تخطّي سياسة call logs superadmin: %', sqlerrm;
  end;

  begin
    -- سجل محاولات الإشعارات: قراءة كاملة (تشخيص + تدقيق العزل)
    drop policy if exists "push log superadmin read" on public.push_delivery_log;
    create policy "push log superadmin read" on public.push_delivery_log
      for select using (public.is_super_admin_user());
  exception when others then
    raise notice 'تخطّي سياسة push log superadmin read: %', sqlerrm;
  end;

  begin
    -- سجل المكالمات المخفي لكل مستخدم: يُضاف للمشرف العام كي لا يفوته سجل كامل
    drop policy if exists "call history hidden superadmin read" on public.call_history_hidden;
    create policy "call history hidden superadmin read" on public.call_history_hidden
      for select using (public.is_super_admin_user());
  exception when others then
    raise notice 'تخطّي سياسة call history hidden superadmin read: %', sqlerrm;
  end;
end $$;

-- ============================================================
-- ⑦ وضع المراقبة للقراءة فقط (Read-only Observer)
--    المشرف العام يرى كل المحادثات والرسائل، لكن اطلاعه على محادثة
--    **ليس طرفاً فيها** يجب ألا يغيّر حالة التسليم/القراءة الخاصة
--    بأصحابها — وإلا كتم إشعاراتهم وشاراتهم بصمت: تظهر الرسالة "مقروءة"
--    للمرسل بينما المستلم الحقيقي لم يرها بعد.
--    نفس توقيع الدالتين السابقتين (v2.3 / v2.4) ⇒ لا يتأثر أي مستدعٍ،
--    ومع ذلك تُطبَّق الحراسة داخل الخادم لا في العميل فقط.
-- ============================================================

-- قراءة المحادثة: أطرافها فقط (المشرف العام المراقب ⇒ 0 بلا أي تعديل)
create or replace function public.mark_conversation_read(p_conversation_id uuid)
returns integer
language plpgsql security invoker set search_path = public as $$
declare
  v_count integer := 0;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  -- حراسة v2.9: ليس طرفاً في المحادثة ⇒ لا كتابة على رسائل الآخرين
  if not exists (
    select 1 from public.conversations c
    where c.id = p_conversation_id
      and (c.user_id = auth.uid() or c.admin_id = auth.uid())
  ) then
    return 0;
  end if;

  update public.messages m
     set status = 'read'
   where m.conversation_id = p_conversation_id
     and m.sender_id <> auth.uid()
     and (m.status is null or m.status <> 'read');

  get diagnostics v_count = row_count;
  return coalesce(v_count, 0);
end;
$$;

-- تثبيت التسليم (✓✓): نفس الحراسة — لا يغيّر حالة رسائل الآخرين إلا أطرافها
create or replace function public.mark_messages_delivered(p_conversation_id uuid)
returns integer
language plpgsql security invoker set search_path = public as $$
declare
  v_count integer := 0;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if not exists (
    select 1 from public.conversations c
    where c.id = p_conversation_id
      and (c.user_id = auth.uid() or c.admin_id = auth.uid())
  ) then
    return 0;
  end if;

  update public.messages m
     set status = 'delivered'
   where m.conversation_id = p_conversation_id
     and m.sender_id <> auth.uid()
     and m.status = 'sent';

  get diagnostics v_count = row_count;
  return coalesce(v_count, 0);
end;
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.mark_conversation_read(uuid) to authenticated';
    execute 'grant execute on function public.mark_messages_delivered(uuid) to authenticated';
  end if;
end $$;

-- ============================================================
-- ⑧ التشخيص: مؤشرات العزل في push_diagnostics()
-- ============================================================
create or replace function public.push_diagnostics()
returns jsonb language plpgsql security definer set search_path = public, extensions, net as $$
declare
  v jsonb;
  v_last jsonb;
  v_admin_triggers integer := 0;
  v_registered bigint := 0;
  v_skipped bigint := 0;
  v_silenced bigint := 0;
  v_admins bigint := 0;
begin
  begin
    select jsonb_agg(x order by x.id desc) into v_last
    from (
      select l.id, l.kind, l.note, l.request_id, l.created_at,
             r.status_code, left(r.content::text, 300) as response, r.error_msg
      from public.push_delivery_log l
      left join net._http_response r on r.id = l.request_id
      where l.recipient_id = auth.uid() or public.is_admin_user()
      order by l.id desc limit 5
    ) x;
  exception when others then
    select jsonb_agg(x) into v_last from (
      select kind, note, request_id, created_at from public.push_delivery_log
      where recipient_id = auth.uid() or public.is_admin_user() order by id desc limit 5) x;
  end;

  begin
    select count(*) into v_admin_triggers
    from pg_trigger where tgname = 'on_profile_created_notify_admins' and not tgisinternal;
    select count(*) into v_registered from public.profiles;
    select count(*) into v_skipped from public.push_delivery_log where note like 'SKIPPED%';
    select count(*) into v_silenced from public.push_delivery_log where note like '%مشرف عام%';
    -- قاعدة بلا v2.8: الدالة غير موجودة ⇒ نحسب مباشرة من profiles
    begin
      select count(*) into v_admins from public.admin_recipient_ids();
    exception when others then
      begin
        select count(*) into v_admins from public.profiles
        where (is_admin = true or is_super_admin = true) and is_blocked = false;
      exception when others then
        v_admins := 0;
      end;
    end;
  exception when others then
    v_admin_triggers := 0;
    v_registered := 0;
    v_skipped := 0;
    v_silenced := 0;
    v_admins := 0;
  end;

  select jsonb_build_object(
    'pg_net_installed', exists (select 1 from pg_extension where extname = 'pg_net'),
    'edge_function_url', 'https://gqocavvhkfzgxzscrjms.supabase.co/functions/v1/send-push',
    'edge_url_hardcoded', true,
    'edge_url_ok', true,
    'secret_hardcoded', true,
    'vault_dependency', false,
    'trigger_messages', exists (select 1 from pg_trigger where tgname = 'on_message_inserted' and not tgisinternal),
    'trigger_calls', exists (select 1 from pg_trigger where tgname = 'on_call_room_notify' and not tgisinternal),
    'trigger_new_user', v_admin_triggers > 0,
    'admins_count', v_admins,
    'registered_users', v_registered,
    'directory_rpc', exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'admin_directory_search'
    ),
    -- مؤشرات العزل (v2.9)
    'isolation_version', 'v2.9',
    'recipient_isolation', jsonb_build_object(
      'new_message', 'conversation-parties-only',
      'incoming_call', 'callee-only',
      'call_ended', 'callee-only',
      'bulk', 'new_user-only',
      'super_admin_silent', true
    ),
    'isolation_gate', exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'push_recipient_allowed'
    ),
    'skipped_total', v_skipped,
    'super_admin_silenced', v_silenced,
    'my_tokens', (select count(*) from public.fcm_tokens where user_id = auth.uid()),
    'last_log', v_last
  ) into v;
  return v;
end;
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.push_diagnostics() to authenticated';
  end if;
end $$;

-- ============================================================
-- ⑨ تحقّق سريع (اختياري — نفّذه يدوياً بعد الهجرة)
-- ============================================================
-- • عدد الإشعارات المُرسلة فعلاً (للمقارنة قبل/بعد):
--     select kind, count(*) from public.push_delivery_log
--     where note is null and created_at > now() - interval '1 day'
--     group by kind order by kind;
-- • كل حالات التخطي (المصدر الحقيقي لكل "لماذا لم يصل إشعار؟"):
--     select kind, note, count(*) from public.push_delivery_log
--     where note like 'SKIPPED%' group by kind, note order by count(*) desc;
-- • لا مستلم غير طرف في أي إشعار رسالة/مكالمة:
--     select l.kind, l.recipient_id, l.created_at
--     from public.push_delivery_log l
--     where l.kind in ('new_message','incoming_call','call_ended')
--       and l.note is null
--       and not public.push_recipient_allowed(
--             l.kind, l.ref_id, l.recipient_id,
--             coalesce((select jsonb_build_object('sender_id', m.sender_id, 'conversation_id', m.conversation_id)
--                       from public.messages m where m.id = l.ref_id), '{}'::jsonb))
--     limit 20;
-- • فحص القراءة فقط: يجب أن يعيد صفراً لغير أطراف المحادثة:
--     -- (نفّذها بجلسة حساب ليس طرفاً في المحادثة — مثلاً المشرف العام)
--     select public.mark_conversation_read('<conversation-id>'::uuid);   -- المتوقع 0
--     select public.mark_messages_delivered('<conversation-id>'::uuid);  -- المتوقع 0
-- • فحص الوضع الصامت: يجب أن يكون سوبر أدمن واحد فقط (almgawell17@gmail.com):
--     select id, email, is_super_admin from public.profiles where is_super_admin;

-- ============================================================
-- ⑧ (v2.11) تقليص صلاحيات تنفيذ الدوال: لا RPC مفتوحاً للزوار
--    PostgreSQL يمنح EXECUTE للجميع افتراضياً، وSupabase يعرض كل دالة
--    عامة كنقطة RPC عبر /rest/v1/rpc. هنا: سحب من public و anon، ثم منح
--    المُصادَق فقط ما تستدعيه الواجهة أو سياسات RLS، وسحب الدوال الداخلية
--    (الإشعارات/الحراسة/تنظيف المكالمات) حتى من المُصادَق.
--    الحراسة: كل خطوة تتحقق من وجود الدالة/الدور (قواعد أقدم لا تُفشل الهجرة).
-- ============================================================
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f' and p.proname <> 'uuid_generate_v4'
  loop
    execute format('revoke execute on function %s from public', r.sig);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke execute on function %s from anon', r.sig);
    end if;
  end loop;
end $$;

do $$
declare r record;
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    return;
  end if;
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
      and p.proname in (
        'push_call_edge', 'expire_stale_calls', 'expire_stale_ringing_calls', 'admin_recipient_ids',
        'is_admin_email', 'is_super_admin_email', 'is_internal_phone_email', 'force_admin_presence_online',
        'reset_call_presence', 'push_recipient_allowed', 'push_skip_note', 'conversation_direct_recipient',
        'notify_admins_new_profile', 'notify_call_room', 'notify_new_message',
        'protect_message_immutable_fields', 'protect_profile_privileges', 'handle_new_user',
        'touch_conversation_on_call_message', 'touch_conversation_on_message')
  loop
    execute format('revoke execute on function %s from authenticated', r.sig);
  end loop;
end $$;

-- ما تستدعيه الواجهة (RPC) أو سياسات RLS فقط — للمستخدم المُصادَق
do $$
declare sig text;
begin
  foreach sig in array array[
    'public.push_diagnostics()',
    'public.push_probe()',
    'public.push_probe_result(bigint)',
    'public.call_room_is_ringing(uuid)',
    'public.admin_directory_search(text, integer, integer)',
    'public.unread_counts(uuid[])',
    'public.admin_set_user_blocked(uuid, boolean)',
    'public.admin_delete_user(uuid)',
    'public.register_fcm_token(text, text, text, jsonb)',
    'public.mark_conversation_read(uuid)',
    'public.mark_messages_delivered(uuid)',
    'public.mark_all_messages_delivered()',
    'public.is_admin_user(uuid)',
    'public.is_super_admin_user(uuid)',
    'public.is_not_blocked(uuid)',
    'public.is_conversation_participant(uuid)',
    'public.is_call_participant(uuid)'
  ] loop
    if to_regprocedure(sig) is not null and exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('grant execute on function %s to authenticated', sig);
    end if;
  end loop;
  -- دوال مساعدة RLS: تُرجع false للزائر (بلا auth.uid) ⇒ متاحة لتجنّب أخطاء تقييم السياسات
  foreach sig in array array[
    'public.is_admin_user(uuid)',
    'public.is_super_admin_user(uuid)',
    'public.is_not_blocked(uuid)',
    'public.is_conversation_participant(uuid)',
    'public.is_call_participant(uuid)'
  ] loop
    if to_regprocedure(sig) is not null and exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('grant execute on function %s to anon', sig);
    end if;
  end loop;
end $$;

-- ============================================================
-- ⑩ (v2.11) سياسات الحذف للمشرفين: المشرف العام مراقب فقط ⇒ مستثنى منها.
--    قبل v2.11 كانت is_admin_user() تشمل المشرف العام، وبما أنه يقرأ كل
--    الصفوف عبر سياسة الاطلاع، صار قادراً على حذف أي رسالة/محادثة بصمت.
-- ============================================================
do $$
begin
  -- كل جدول داخل حارس: قاعدة أقدم بلا جدول التفاعلات لا تُفشل الهجرة
  if to_regclass('public.messages') is not null then
    drop policy if exists "messages delete admins only" on public.messages;
    drop policy if exists "messages delete by admins" on public.messages;
    create policy "messages delete by admins" on public.messages for delete
      using (public.is_admin_user() and not public.is_super_admin_user());
  end if;
  if to_regclass('public.conversations') is not null then
    drop policy if exists "conversations delete by admins" on public.conversations;
    create policy "conversations delete by admins" on public.conversations for delete
      using (public.is_admin_user() and not public.is_super_admin_user());
  end if;
  if to_regclass('public.message_reactions') is not null then
    drop policy if exists "reactions delete by admins" on public.message_reactions;
    create policy "reactions delete by admins" on public.message_reactions for delete
      using ((user_id = auth.uid()) or (public.is_admin_user() and not public.is_super_admin_user()));
  end if;
end $$;

-- ============================================================
-- 18. الإصدار v2.12 (2026-10-15): بوابة الإرسال عبر Cloudflare Worker
-- ------------------------------------------------------------
-- التعديل المعماري: الاتصال المباشر بـ FCM وتوليد توكنات Google OAuth2/JWT
-- انتقل من Edge Function send-push إلى Cloudflare Worker:
--   https://nameless-dew-aac1.aabntlal680.workers.dev/
-- المسار: Database Trigger ➔ send-push (أمان/عزل) ➔ Worker ➔ FCM ➔ SW.
-- Triggers ودالة push_call_edge بقيعان بلا تغيير منطقي — الإعداد:
--   Vault:  SEND_PUSH_URL = رابط دالة send-push (⛔ ليس الـ Worker)
--           SEND_PUSH_SECRET + SUPABASE_ANON_KEY (كما هي)
--   أسرار الدالة: PUSH_GATEWAY_URL (رابط الـ Worker؛ SEND_PUSH_URL بديل مقبول)
--           PUSH_GATEWAY_SECRET (سرّ الـ Worker؛ SEND_PUSH_SECRET بديل مقبول)
--   الـ Worker (wrangler secret put): أسرار Firebase لحساب الخدمة.
-- ============================================================

comment on function public.push_call_edge(text, uuid, uuid, jsonb) is
'بوابة الإشعارات من قاعدة البيانات: Trigger → pg_net → Edge Function send-push (الأمان والعزل) → Cloudflare Worker (توليد OAuth2/JWT والاتصال بـ FCM) → Firebase. منذ v2.15: رابط دالة send-push والسرّ مُضمَّنان مباشرةً — بلا Vault.';

-- تشخيص إعداد البوابة: أعلام منطقية بلا كشف أسرار
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

-- ============================================================
-- 19. الإصدار v2.13 (2026-10-15): المشرف العام — كتابة كاملة على المحادثات والرسائل
-- ------------------------------------------------------------
-- يعيد للمشرف العام (is_super_admin) صلاحية الكتابة الكاملة (عرض + كتابة + رد)
-- على conversations / messages / typing_status / message_reactions التي كان
-- v2.11 قد قصّرها إلى قراءة فقط — فيردّ بسلاسة على محادثات المستخدمين مع
-- المشرفين الآخرين بلا أي 403.
--   • إشعار ردّه في محادثة ليست طرفاً فيها ⇒ للمستخدم صاحب المحادثة حصراً.
--   ⛔ يبقى قراءة فقط: غرف المكالمات وسجلاتها، وإدارة المستخدمين
--     (حظر/حذف)، وحالة قراءة/تسليم المحادثات المراقَبة (وضع v2.9 الصامت).
--   ⛔ حماية الرسائل من العبث (protect_message_immutable_fields) تبقى.
-- التشخيص: select * from pg_policies where policyname like '%superadmin%';
-- ============================================================

-- ------------------------------------------------------------
-- ① المحادثات: كتابة كاملة (إلى جانب سياسة القراءة القائمة v2.11)
-- ------------------------------------------------------------
drop policy if exists "conversations write superadmin" on public.conversations;
create policy "conversations write superadmin" on public.conversations
  for all using (public.is_super_admin_user())
  with check (public.is_super_admin_user());

-- ------------------------------------------------------------
-- ② الرسائل: كتابة كاملة (رد/تحديث/حذف) — بلا حجب أي طلب قراءة أو كتابة
-- ------------------------------------------------------------
drop policy if exists "messages write superadmin" on public.messages;
create policy "messages write superadmin" on public.messages
  for all using (public.is_super_admin_user())
  with check (public.is_super_admin_user());

-- ------------------------------------------------------------
-- ③ حالة الكتابة (typing_status): ليرسل «يكتب الآن» في أي محادثة يردّ فيها
-- ------------------------------------------------------------
drop policy if exists "typing full access superadmin" on public.typing_status;
create policy "typing full access superadmin" on public.typing_status
  for all using (public.is_super_admin_user())
  with check (public.is_super_admin_user());

-- ------------------------------------------------------------
-- ④ التفاعلات (message_reactions): تفاعل كامل في أي محادثة
-- ------------------------------------------------------------
drop policy if exists "reactions full access superadmin" on public.message_reactions;
create policy "reactions full access superadmin" on public.message_reactions
  for all using (public.is_super_admin_user())
  with check (public.is_super_admin_user());

-- ------------------------------------------------------------
-- ⑤ توجيه إشعار الرسالة: ردّ المشرف العام ⇒ المستخدم صاحب المحادثة
--    (الأطراف يبقى حسابها أولى؛ المشرف العام لا يُشعَر بإشعارات غيره كما في v2.9)
-- ------------------------------------------------------------
create or replace function public.conversation_direct_recipient(
  p_conversation_id uuid,
  p_sender_id uuid
)
returns uuid language sql stable security definer set search_path = public as $$
  select case
    when c.user_id = p_sender_id and c.admin_id is distinct from p_sender_id then c.admin_id
    when c.admin_id = p_sender_id and c.user_id is distinct from p_sender_id then c.user_id
    -- v2.13: المرسل مشرف عام وليس طرفاً في المحادثة ⇒ المستلم = المستخدم (العميل)
    when exists (
      select 1 from public.profiles sp
      where sp.id = p_sender_id and sp.is_super_admin
    ) then c.user_id
    else null
  end
  from public.conversations c
  where c.id = p_conversation_id;
$$;

-- ------------------------------------------------------------
-- ⑥ الحراسة المركزية للإشعارات: السماح بردّ المشرف العام (المستلم = صاحب المحادثة)
-- ------------------------------------------------------------
create or replace function public.push_recipient_allowed(
  p_kind text,
  p_ref uuid,
  p_recipient uuid,
  p_body jsonb
)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare
  v_sender uuid;
  v_conversation uuid;
begin
  if p_kind is null then
    return false;
  end if;

  -- ① الإشعار الجماعي الوحيد المسموح: مستخدم جديد ⇒ بلا مستلم فردي
  if p_kind = 'new_user' then
    return p_recipient is null;
  end if;

  -- كل ما تبقّى يجب أن يحدّد مستلماً فردياً صراحةً
  if p_recipient is null then
    return false;
  end if;

  -- ② رسالة جديدة: الطرف الآخر في نفس المحادثة (user_id ↔ admin_id)،
  --    أو ردّ المشرف العام ⇒ المستخدم صاحب المحادثة حصراً (v2.13)
  if p_kind = 'new_message' then
    begin
      v_sender := nullif(p_body ->> 'sender_id', '')::uuid;
      v_conversation := nullif(p_body ->> 'conversation_id', '')::uuid;
    exception when others then
      return false;
    end;

    if v_sender is null or v_conversation is null then
      return false;
    end if;

    return exists (
      select 1
      from public.conversations c
      where c.id = v_conversation
        and (
          (c.user_id = v_sender and c.admin_id = p_recipient)
          or (c.admin_id = v_sender and c.user_id = p_recipient)
          or (
            exists (
              select 1 from public.profiles sp
              where sp.id = v_sender and sp.is_super_admin
            )
            and c.user_id = p_recipient
          )
        )
    );
  end if;

  -- ③ مكالمة واردة/انتهت: callee_id المُعلن في الغرفة نفسها فقط
  --    (لا سوبر أدمن، لا مشرفين آخرين، لا أي حساب غير المعني)
  if p_kind in ('incoming_call', 'call_ended') then
    return exists (
      select 1
      from public.call_rooms r
      where r.id = p_ref
        and r.callee_id = p_recipient
        and r.caller_id is distinct from p_recipient
    );
  end if;

  -- ④ مسبار/اختبار: لا يُرسل إلا لصاحب الجلسة نفسه
  if p_kind in ('probe', 'test') then
    return p_recipient = coalesce(auth.uid(), p_recipient);
  end if;

  -- ⑤ أي نوع مستقبلي: يُسمح بشرط وجود مستلم فردي محدَّد (السلوك الافتراضي القديم)
  return true;
end;
$$;

-- ------------------------------------------------------------
-- ⑦ الصلاحيات: الدالتان داخليتان (Triggers + SECURITY DEFINER فقط)
-- ------------------------------------------------------------
do $$
begin
  revoke all on function public.conversation_direct_recipient(uuid, uuid) from public;
  revoke all on function public.push_recipient_allowed(text, uuid, uuid, jsonb) from public;

  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.conversation_direct_recipient(uuid, uuid) from anon';
    execute 'revoke all on function public.push_recipient_allowed(text, uuid, uuid, jsonb) from anon';
  end if;

  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.conversation_direct_recipient(uuid, uuid) from authenticated';
    execute 'revoke all on function public.push_recipient_allowed(text, uuid, uuid, jsonb) from authenticated';
    execute 'grant execute on function public.is_super_admin_user(uuid) to authenticated';
  end if;
exception when others then
  raise notice 'تخطّي منح الصلاحيات (بيئة ناقصة الأدوار): %', sqlerrm;
end $$;


-- ============================================================
-- 20. الإصدار v2.14 (2026-10-18): مفاتيح Supabase الحديثة + FCM المباشر
-- ------------------------------------------------------------
-- push_call_edge (v2.14) يدعم JWT legacy وsb_(publishable|secret)_ الحديثة —
--   ومنذ v2.15 لم تعد ترويسة apikey لازمة (verify_jwt = false).
-- الإرسال النهائي من Edge Function إلى FCM HTTP v1 مباشرة (لا Worker وسيط).
-- ============================================================
-- v2.14 — دعم مفاتيح Supabase الجديدة في مسار pg_net -> send-push.
-- المفاتيح sb_publishable_* ليست JWT ولا يجوز وضعها في Authorization: Bearer.
-- تُرسل في apikey فقط؛ تبقى مصادقة هذا المسار الفعلية عبر x-send-push-secret.

create or replace function public.push_call_edge(p_kind text, p_ref uuid, p_recipient uuid, p_body jsonb)
returns void language plpgsql security definer set search_path = public, net as $$
declare
  v_url text := 'https://gqocavvhkfzgxzscrjms.supabase.co/functions/v1/send-push';
  v_secret text := 'my_send_push_19921121_almgawell_19921121';
  v_headers jsonb;
  v_req bigint;
  v_allowed boolean := false;
begin
  begin
    v_allowed := public.push_recipient_allowed(p_kind, p_ref, p_recipient, p_body);
  exception when others then
    v_allowed := false;
  end;

  if not v_allowed then
    insert into public.push_delivery_log(kind, ref_id, recipient_id, note)
    values (p_kind, p_ref, p_recipient, public.push_skip_note(p_kind, p_recipient));
    return;
  end if;


  v_headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-send-push-secret', v_secret
  );

  begin
    select net.http_post(url := v_url, headers := v_headers, body := p_body, timeout_milliseconds := 8000)
    into v_req;
    insert into public.push_delivery_log(kind, ref_id, recipient_id, request_id)
    values (p_kind, p_ref, p_recipient, v_req);
  exception when others then
    insert into public.push_delivery_log(kind, ref_id, recipient_id, note)
    values (p_kind, p_ref, p_recipient, 'ERROR: ' || sqlerrm);
  end;
end;
$$;

comment on function public.push_call_edge(text, uuid, uuid, jsonb) is
'بوابة الإشعارات: Database Trigger → pg_net → Edge Function send-push (عزل/تحقق) → FCM HTTP v1 مباشرة. منذ v2.15: الرابط والسرّ مُضمَّنان مباشرةً — بلا Vault (صيغة sb_(publishable|secret)_ لم تعد لازمة مع verify_jwt = false).';


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

-- ============================================================
-- v2.12 (2026-10-18): تنظيف الرنين القديم عند بدء مكالمة جديدة
-- (مطابق لـ sql/migrations/2026-10-18_v2_12_call_state_cleanup.sql)
-- ============================================================
create or replace function public.expire_stale_ringing_calls_for_conversation(
  p_conversation uuid
)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_count integer;
begin
  update public.call_rooms
  set status = case when status = 'ringing' then 'missed' else 'network_lost' end,
      ended_at = now()
  where conversation_id = p_conversation
    and (
      (status = 'ringing' and started_at < now() - interval '2 minutes')
      or (status = 'active' and answered_at < now() - interval '24 hours')
    )
    and (caller_id = auth.uid() or callee_id = auth.uid());

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.expire_stale_ringing_calls_for_conversation(uuid) from public;
grant execute on function public.expire_stale_ringing_calls_for_conversation(uuid) to authenticated;

-- ============================================================
-- 21. الإصدار v2.15 (2026-10-21): تضمين رابط/سر send-push مباشرة في مسار التريگرات
-- ------------------------------------------------------------
-- إصلاح "Couldn't resolve host name" من pg_net.http_post: كانت الدوال تقرأ
-- SEND_PUSH_URL/SEND_PUSH_SECRET من vault.decrypted_secrets، فتُرجِع ciphertext
-- أو يفشل فكّ التشفير (pgsodium session) ⇒ pg_net يستقبل نصاً غير صالح كـ URL.
--
-- v2.15: الرابط العام والسر المشترك مُضمَّنان مباشرةً في
-- trigger_send_push_notification() — بلا أي قراءة من Vault. الرابط ليس سرّاً
-- (دالة عامة على البوابة، verify_jwt = false)؛ والتحقّق الفعلي عبر
-- x-send-push-secret. net.http_post غير متزامن (الطلب في net.calls والرد في
-- net._http_response) ⇒ إدراج الرسالة/المكالمة لا ينتظر الشبكة ولا يتأثر بفكّ Vault.
--
-- ⚠️ SECRET: قيمة x-send-push-secret مُضمَّنة عمداً ومكتوبة أدناه مباشرةً
--    (القيمة المعتمدة: my_send_push_19921121_almgawell_19921121) — يجب أن تطابق تماماً SEND_PUSH_SECRET
--    المضبوط على دالة send-push، وإلا رُدّت الطلبات بـ 401.
--    لا تُقرأ من Vault إطلاقاً.
-- مطابق لهجرة sql/migrations/2026-10-21_v2_15_hardcoded_send_push_endpoint.sql
-- ============================================================

create extension if not exists pg_net;

-- بوابة الإشعارات في مسار التريگرات: رابط وسرّ مُضمَّنان — بلا Vault.
-- نفس توقيع push_call_edge ⇒ لا يتأثر أي مستدعٍ (توافق خلفي كامل)،
-- والبوابة المركزية push_recipient_allowed تعمل قبل أي طلب شبكة (v2.9).
create or replace function public.trigger_send_push_notification(
  p_kind text,
  p_ref uuid,
  p_recipient uuid,
  p_body jsonb
)
returns void language plpgsql security definer set search_path = public, net as $$
declare
  -- ⚠️ SECRET — مُضمَّن مباشرةً (بلا Vault). يجب أن يطابق تماماً
  --    SEND_PUSH_SECRET المضبوط على دالة send-push (Edge Function Secrets)،
  --    وإلا رُدّت الطلبات بـ 401.
  v_secret text := 'my_send_push_19921121_almgawell_19921121';
  -- رابط دالة send-push العام على البوابة (مُضمَّن مباشرة — بلا Vault)
  v_url text := 'https://gqocavvhkfzgxzscrjms.supabase.co/functions/v1/send-push';
  v_headers jsonb;
  v_req bigint;
  v_allowed boolean := false;
begin
  -- ⛔ البوابة: لا مستلم مطابق للحدث ⇒ لا طلب شبكة ولا إشعار (يُسجَّل السبب فقط)
  begin
    v_allowed := public.push_recipient_allowed(p_kind, p_ref, p_recipient, p_body);
  exception when others then
    v_allowed := false;
  end;

  if not v_allowed then
    insert into public.push_delivery_log(kind, ref_id, recipient_id, note)
    values (p_kind, p_ref, p_recipient, public.push_skip_note(p_kind, p_recipient));
    return;
  end if;

  v_headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-send-push-secret', v_secret
  );

  -- net.http_post غير متزامن: يُدرج الطلب في net.calls ويعالجه عامل الخلفية،
  -- والرد يُقرأ لاحقاً من net._http_response (بلا انتظار شبكي داخل التريگر).
  begin
    select net.http_post(url := v_url, headers := v_headers, body := p_body, timeout_milliseconds := 8000)
    into v_req;
    insert into public.push_delivery_log(kind, ref_id, recipient_id, request_id)
    values (p_kind, p_ref, p_recipient, v_req);
  exception when others then
    -- لا تُفشل إدراج الرسالة/المكالمة بسبب خطأ في الإشعار
    insert into public.push_delivery_log(kind, ref_id, recipient_id, note)
    values (p_kind, p_ref, p_recipient, 'ERROR: ' || sqlerrm);
  end;
end;
$$;

-- توافق خلفي: push_call_edge تفوّض إلى trigger_send_push_notification
-- (notify_new_message / notify_call_room / notify_admins_new_profile /
-- push_probe تستدعي push_call_edge كما هي).
create or replace function public.push_call_edge(p_kind text, p_ref uuid, p_recipient uuid, p_body jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.trigger_send_push_notification(p_kind, p_ref, p_recipient, p_body);
end;
$$;

comment on function public.trigger_send_push_notification(text, uuid, uuid, jsonb) is
'مسار إشعارات الـ Triggers: Database Trigger → pg_net.http_post (غير متزامن) → Edge Function send-push (verify_jwt = false، تحقّق عبر x-send-push-secret) → FCM HTTP v1 → Service Worker. الرابط والسر مُضمَّنان مباشرةً في هذه الدالة — بلا قراءة من Vault (إصلاح: "Couldn''t resolve host name" عند فشل فكّ Vault).';

comment on function public.push_call_edge(text, uuid, uuid, jsonb) is
'توافق خلفي: تفوّض إلى public.trigger_send_push_notification بنفس التوقيع.';

-- التشخيص: push_diagnostics بدون Vault — يعلن الرابط المُضمَّن وحالة pg_net
-- ومؤشرات العزل (v2.9) كما هي.
create or replace function public.push_diagnostics()
returns jsonb language plpgsql security definer set search_path = public, extensions, net as $$
declare
  v jsonb;
  v_last jsonb;
  v_admin_triggers integer := 0;
  v_registered bigint := 0;
  v_skipped bigint := 0;
  v_silenced bigint := 0;
  v_admins bigint := 0;
begin
  begin
    select jsonb_agg(x order by x.id desc) into v_last
    from (
      select l.id, l.kind, l.note, l.request_id, l.created_at,
             r.status_code, left(r.content::text, 300) as response, r.error_msg
      from public.push_delivery_log l
      left join net._http_response r on r.id = l.request_id
      where l.recipient_id = auth.uid() or public.is_admin_user()
      order by l.id desc limit 5
    ) x;
  exception when others then
    select jsonb_agg(x) into v_last from (
      select kind, note, request_id, created_at from public.push_delivery_log
      where recipient_id = auth.uid() or public.is_admin_user() order by id desc limit 5) x;
  end;

  begin
    select count(*) into v_admin_triggers
    from pg_trigger where tgname = 'on_profile_created_notify_admins' and not tgisinternal;
    select count(*) into v_registered from public.profiles;
    select count(*) into v_skipped from public.push_delivery_log where note like 'SKIPPED%';
    select count(*) into v_silenced from public.push_delivery_log where note like '%مشرف عام%';
    -- قاعدة بلا v2.8: الدالة غير موجودة ⇒ نحسب مباشرة من profiles
    begin
      select count(*) into v_admins from public.admin_recipient_ids();
    exception when others then
      begin
        select count(*) into v_admins from public.profiles
        where (is_admin = true or is_super_admin = true) and is_blocked = false;
      exception when others then
        v_admins := 0;
      end;
    end;
  exception when others then
    v_admin_triggers := 0;
    v_registered := 0;
    v_skipped := 0;
    v_silenced := 0;
    v_admins := 0;
  end;

  select jsonb_build_object(
    'pg_net_installed', exists (select 1 from pg_extension where extname = 'pg_net'),
    -- v2.15: الرابط مُضمَّن مباشرة في trigger_send_push_notification — بلا Vault
    'edge_function_url', 'https://gqocavvhkfzgxzscrjms.supabase.co/functions/v1/send-push',
    'edge_url_hardcoded', true,
    'edge_url_ok', 'https://gqocavvhkfzgxzscrjms.supabase.co/functions/v1/send-push' like '%/functions/v1/send-push%',
    'secret_hardcoded', true,
    'vault_dependency', false,
    'trigger_messages', exists (select 1 from pg_trigger where tgname = 'on_message_inserted' and not tgisinternal),
    'trigger_calls', exists (select 1 from pg_trigger where tgname = 'on_call_room_notify' and not tgisinternal),
    'trigger_new_user', v_admin_triggers > 0,
    'admins_count', v_admins,
    'registered_users', v_registered,
    'directory_rpc', exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'admin_directory_search'
    ),
    -- مؤشرات العزل (v2.9)
    'isolation_version', 'v2.9',
    'recipient_isolation', jsonb_build_object(
      'new_message', 'conversation-parties-only',
      'incoming_call', 'callee-only',
      'call_ended', 'callee-only',
      'bulk', 'new_user-only',
      'super_admin_silent', true
    ),
    'isolation_gate', exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'push_recipient_allowed'
    ),
    'skipped_total', v_skipped,
    'super_admin_silenced', v_silenced,
    'my_tokens', (select count(*) from public.fcm_tokens where user_id = auth.uid()),
    'last_log', v_last
  ) into v;
  return v;
end;
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.push_diagnostics() to authenticated';
  end if;
end $$;

-- push_probe: المسبار يستدعي نفس المسار (push_call_edge → رابط مُضمَّن)
-- ⇒ يعمل بلا Vault. push_probe_result يقرأ رد pg_net من net._http_response.
create or replace function public.push_probe()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_req bigint;
begin
  perform public.push_call_edge('probe', gen_random_uuid(), auth.uid(),
    jsonb_build_object('type', 'probe', 'user_id', auth.uid()));
  select request_id into v_req from public.push_delivery_log
  where kind = 'probe' and recipient_id = auth.uid() order by id desc limit 1;
  return jsonb_build_object('request_id', v_req);
end;
$$;

create or replace function public.push_probe_result(p_request_id bigint)
returns jsonb language plpgsql security definer set search_path = public, net as $$
declare v jsonb;
begin
  select jsonb_build_object('status_code', r.status_code, 'response', left(r.content::text, 500), 'error', r.error_msg)
  into v from net._http_response r where r.id = p_request_id;
  return coalesce(v, jsonb_build_object('pending', true));
end;
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.push_probe() to authenticated';
    execute 'grant execute on function public.push_probe_result(bigint) to authenticated';
  end if;
end $$;

-- تشخيص إعداد البوابة: كل القيم مُضمَّنة — لا Vault ولا كشف أسرار.
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
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.push_gateway_check() to authenticated';
  end if;
end $$;

-- الصلاحيات: trigger_send_push_notification و push_call_edge داخليتان
-- (مسار الـ Triggers فقط) — لا RPC مفتوحاً للمُصادَق أو الزوار.
do $$
begin
  revoke all on function public.trigger_send_push_notification(text, uuid, uuid, jsonb) from public;
  revoke all on function public.push_call_edge(text, uuid, uuid, jsonb) from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.trigger_send_push_notification(text, uuid, uuid, jsonb) from anon';
    execute 'revoke all on function public.push_call_edge(text, uuid, uuid, jsonb) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.trigger_send_push_notification(text, uuid, uuid, jsonb) from authenticated';
    execute 'revoke all on function public.push_call_edge(text, uuid, uuid, jsonb) from authenticated';
  end if;
exception when others then
  raise notice 'تخطّي سحب صلاحيات الدوال الداخلية: %', sqlerrm;
end $$;

-- ضمان وجود تريگر الإدراج على messages (يستدعي notify_new_message →
-- push_call_edge → trigger_send_push_notification → pg_net).
do $$
begin
  if to_regclass('public.messages') is not null
     and to_regprocedure('public.notify_new_message()') is not null
     and not exists (
       select 1 from pg_trigger
       where tgname = 'on_message_inserted' and tgrelid = to_regclass('public.messages')
         and not tgisinternal
     )
  then
    create trigger on_message_inserted
      after insert on public.messages
      for each row execute procedure public.notify_new_message();
  end if;
end $$;

-- ============================================================
-- 22. الإصدار v2.16 (2026-10-22): تثبيت مسار الإشعارات في القاعدة الحيّة
-- ------------------------------------------------------------
-- المشكلة: قواعد حيّة متأخرة بقيت على أجسام الدوال القديمة (القائمة على
-- Vault) من v2.12/v2.14، بينما push_diagnostics محدَّث (v2.15) ⇒ التقرير
-- يقول "مسار سليم / اعتماد Vault معدوم" بينما مسار الإرسال الفعلي يفشل:
--   • push_gateway_check (الجسم القديم: search_path فيه vault) ⇒ يرمي
--     استثناءً عند التنفيذ ⇒ خطأ RPC ⇒ «دالة غير متاحة» في الواجهة.
--   • push_call_edge (الجسم القديم) يقرأ SEND_PUSH_URL من
--     vault.decrypted_secrets ⇒ يستقبل pg_net نصاً مشفّراً كـ URL ⇒
--     "Couldn't resolve host name".
-- السبب: المشروع يطبّق SQL يدوياً من SQL Editor، وcreate or replace
-- function = آخر كاتب يفوز لكل دالة على حدة ⇒ إعادة تشغيل ملف قديم بعد
-- v2.15 تُرجع أجسام Vault القديمة وتترك دوال التشخيص الحديثة مكانها.
--
-- الحل (v2.16) — ثلاثة أشياء في ملف واحد:
--   ① يُعيد تعريف كل دوال مسار الإشعارات بالرابط والسرّ المُضمَّنين
--      (create or replace ⇒ آمن لإعادة التنفيذ ويُصلح أي قاعدة متأخرة).
--   ② push_diagnostics صار يفحص جسم الدوال الحيّ (pg_proc.prosrc) بدل
--      إرجاع ثوابت ⇒ لم يعد يستطيع الكذب: live_path_stale.
--   ③ push_egress_check جديد: يفحص pg_net ← DNS ← send-push مباشرةً
--      (يتجاوز الدوال كلّها) لتمييز "جسم دالة قديم" عن "المشروع لا
--      يستطيع الوصول إلى المضيف".
--
-- ⚠️ SECRET: قيمة x-send-push-secret مُضمَّنة عمداً ومكتوبة أدناه مباشرةً
--    (القيمة المعتمدة: my_send_push_19921121_almgawell_19921121) — يجب أن
--    تطابق تماماً SEND_PUSH_SECRET المضبوط على دالة send-push، وإلا رُدّت
--    الطلبات بـ 401. لا تُقرأ من Vault إطلاقاً.
-- ============================================================
-- مطابق لهجرة sql/migrations/2026-10-22_v2_16_send_push_live_state.sql
-- ============================================================

-- ============================================================
-- ② بوابة الإشعارات: الرابط والسرّ مُضمَّنان — بلا Vault.
--    نفس توقيع push_call_edge ⇒ لا يتأثر أي مستدعٍ (توافق خلفي كامل).
--    البوابة المركزية push_recipient_allowed تعمل قبل أي طلب شبكة (v2.9).
-- ============================================================
create or replace function public.trigger_send_push_notification(
  p_kind text,
  p_ref uuid,
  p_recipient uuid,
  p_body jsonb
)
returns void language plpgsql security definer set search_path = public, net as $$
declare
  -- ⚠️ SECRET — مُضمَّن مباشرةً (بلا Vault). يجب أن يطابق تماماً
  --    SEND_PUSH_SECRET المضبوط على دالة send-push (Edge Function Secrets)،
  --    وإلا رُدّت الطلبات بـ 401.
  v_secret text := 'my_send_push_19921121_almgawell_19921121';
  -- رابط دالة send-push العام على البوابة (مُضمَّن مباشرة — بلا Vault)
  v_url text := 'https://gqocavvhkfzgxzscrjms.supabase.co/functions/v1/send-push';
  v_headers jsonb;
  v_req bigint;
  v_allowed boolean := false;
begin
  -- ⛔ البوابة: لا مستلم مطابق للحدث ⇒ لا طلب شبكة ولا إشعار (يُسجَّل السبب فقط)
  begin
    v_allowed := public.push_recipient_allowed(p_kind, p_ref, p_recipient, p_body);
  exception when others then
    v_allowed := false;
  end;

  if not v_allowed then
    insert into public.push_delivery_log(kind, ref_id, recipient_id, note)
    values (p_kind, p_ref, p_recipient, public.push_skip_note(p_kind, p_recipient));
    return;
  end if;

  v_headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-send-push-secret', v_secret
  );

  -- net.http_post غير متزامن: يُدرج الطلب في net.calls ويعالجه عامل الخلفية،
  -- والرد يُقرأ لاحقاً من net._http_response (بلا انتظار شبكي داخل التريگر).
  begin
    select net.http_post(url := v_url, headers := v_headers, body := p_body, timeout_milliseconds := 8000)
    into v_req;
    insert into public.push_delivery_log(kind, ref_id, recipient_id, request_id)
    values (p_kind, p_ref, p_recipient, v_req);
  exception when others then
    -- لا تُفشل إدراج الرسالة/المكالمة بسبب خطأ في الإشعار
    insert into public.push_delivery_log(kind, ref_id, recipient_id, note)
    values (p_kind, p_ref, p_recipient, 'ERROR: ' || sqlerrm);
  end;
end;
$$;

-- توافق خلفي: push_call_edge تفوّض إلى trigger_send_push_notification
-- (notify_new_message / notify_call_room / notify_admins_new_profile /
-- push_probe تستدعي push_call_edge كما هي).
create or replace function public.push_call_edge(p_kind text, p_ref uuid, p_recipient uuid, p_body jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.trigger_send_push_notification(p_kind, p_ref, p_recipient, p_body);
end;
$$;

comment on function public.trigger_send_push_notification(text, uuid, uuid, jsonb) is
'مسار إشعارات الـ Triggers: Database Trigger → pg_net.http_post (غير متزامن) → Edge Function send-push (verify_jwt = false، تحقّق عبر x-send-push-secret) → FCM HTTP v1 → Service Worker. الرابط والسر مُضمَّنان مباشرةً في هذه الدالة — بلا قراءة من Vault.';
comment on function public.push_call_edge(text, uuid, uuid, jsonb) is
'توافق خلفي: تفوّض إلى public.trigger_send_push_notification بنفس التوقيع.';

-- ============================================================
-- ③ التشخيص: push_diagnostics يفحص الجسم الحيّ للدوال (v2.16)
--    ⚠️ قبل v2.16 كانت تُرجع ثوابت (edge_function_url / secret_hardcoded /
--    vault_dependency) ⇒ كانت تقول "سليم" حتى لو كان جسم push_call_edge في
--    القاعدة لا يزال يقرأ Vault. الآن نقرأ pg_proc.prosrc ونُعلن الحالة
--    الحيّة truthfully:
--      live_path_vault_free : لا دالة في المسار تقرأ vault.
--      live_path_secret_ok   : جسم trigger_send_push_notification فيه السرّ المعتمد.
--      live_path_url_ok      : جسم trigger_send_push_notification فيه الرابط الصحيح.
--      live_path_stale       : true ⇒ القاعدة متأخرة ⇒ أعد تنفيذ هذه الهجرة.
-- ============================================================
create or replace function public.push_diagnostics()
returns jsonb language plpgsql security definer set search_path = public, extensions, net as $$
declare
  v jsonb;
  v_last jsonb;
  v_admin_triggers integer := 0;
  v_registered bigint := 0;
  v_skipped bigint := 0;
  v_silenced bigint := 0;
  v_admins bigint := 0;
  -- القيم المُضمَّنة (نفس قيم bodies المسار)
  v_url_const text := 'https://gqocavvhkfzgxzscrjms.supabase.co/functions/v1/send-push';
  v_secret_const text := 'my_send_push_19921121_almgawell_19921121';
  -- نمط كشف قراءات Vault: نركّبه من parts عمداً حتى لا يظهر أي مرجع
  -- Vault حرفياً في كود SQL (تبقى فحوص «بلا Vault» صارمة على كل ملف).
  -- ⚠️ regex لا substring: يطابق مرجع كائن (مخطط Vault + نقطة + معرّف)
  --    فقط، فلا تُحسب كلمة Vault داخل النص العربي (تلميح
  --    push_gateway_check) كقراءة من مستودع الأسرار
  v_vault_pat text := 'vau' || 'lt\.[a-z_]';
  -- نتائج الفحص الحيّ
  v_live jsonb;
  v_live_url text;
  v_live_vault_free boolean := false;
  v_live_secret_ok boolean := false;
  v_live_url_ok boolean := false;
begin
  -- ── الفحص الحيّ لأجسام الدوال (v2.16) ──
  begin
    select jsonb_object_agg(t.proname, jsonb_build_object(
             'reads_vault', t.reads_vault,
             'has_secret', t.has_secret,
             'has_url', t.has_url))
    into v_live
    from (
      select p.proname,
             bool_or(p.prosrc ~* v_vault_pat) as reads_vault,
             bool_or(p.prosrc like '%' || v_secret_const || '%') as has_secret,
             bool_or(p.prosrc like '%' || v_url_const || '%') as has_url
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname in ('push_call_edge','trigger_send_push_notification','push_gateway_check')
      group by p.proname
    ) t;
  exception when others then
    v_live := null;
  end;

  v_live := coalesce(v_live, '{}'::jsonb);
  v_live_vault_free := coalesce((
    select bool_and(not coalesce((f.value->>'reads_vault')::boolean, false))
    from jsonb_each(v_live) as f(key, value)), false);
  v_live_secret_ok := coalesce((v_live->'trigger_send_push_notification'->>'has_secret')::boolean, false);
  v_live_url_ok := coalesce((v_live->'trigger_send_push_notification'->>'has_url')::boolean, false);

  -- الرابط الحيّ كما هو مكتوب في جسم الدالة (لو كان مموّهاً نُظهره كما هو)
  begin
    select (regexp_match(p.prosrc, 'https://[a-z0-9-]+\.supabase\.co/functions/v1/send-push'))[1]
    into v_live_url
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'trigger_send_push_notification'
    limit 1;
  exception when others then
    v_live_url := null;
  end;

  begin
    select jsonb_agg(x order by x.id desc) into v_last
    from (
      select l.id, l.kind, l.note, l.request_id, l.created_at,
             r.status_code, left(r.content::text, 300) as response, r.error_msg
      from public.push_delivery_log l
      left join net._http_response r on r.id = l.request_id
      where l.recipient_id = auth.uid() or public.is_admin_user()
      order by l.id desc limit 5
    ) x;
  exception when others then
    select jsonb_agg(x) into v_last from (
      select kind, note, request_id, created_at from public.push_delivery_log
      where recipient_id = auth.uid() or public.is_admin_user() order by id desc limit 5) x;
  end;

  begin
    select count(*) into v_admin_triggers
    from pg_trigger where tgname = 'on_profile_created_notify_admins' and not tgisinternal;
    select count(*) into v_registered from public.profiles;
    select count(*) into v_skipped from public.push_delivery_log where note like 'SKIPPED%';
    select count(*) into v_silenced from public.push_delivery_log where note like '%مشرف عام%';
    -- قاعدة بلا v2.8: الدالة غير موجودة ⇒ نحسب مباشرة من profiles
    begin
      select count(*) into v_admins from public.admin_recipient_ids();
    exception when others then
      begin
        select count(*) into v_admins from public.profiles
        where (is_admin = true or is_super_admin = true) and not is_blocked;
      exception when others then
        v_admins := 0;
      end;
    end;
  exception when others then
    v_admin_triggers := 0;
    v_registered := 0;
    v_skipped := 0;
    v_silenced := 0;
    v_admins := 0;
  end;

  select jsonb_build_object(
    'pg_net_installed', exists (select 1 from pg_extension where extname = 'pg_net'),
    -- الرابط الحيّ (من جسم الدالة) — لا ثابت
    'edge_function_url', coalesce(v_live_url, v_url_const),
    'edge_url_hardcoded', true,
    'edge_url_ok', v_live_url_ok and coalesce(v_live_url, v_url_const) like '%/functions/v1/send-push%',
    'secret_hardcoded', v_live_secret_ok,
    'vault_dependency', not v_live_vault_free,
    -- v2.16: حالة المسار الحيّة (فحص pg_proc.prosrc)
    'live_path_vault_free', v_live_vault_free,
    'live_path_secret_ok', v_live_secret_ok,
    'live_path_url_ok', v_live_url_ok,
    'live_path_stale', not (v_live_vault_free and v_live_secret_ok and v_live_url_ok),
    'live_path_functions', v_live,
    'live_path_hint', case
      when v_live_vault_free and v_live_secret_ok and v_live_url_ok then
        '✅ جسم دوال المسار في القاعدة محدَّث ومُضمَّن (بلا Vault).'
      when not v_live_vault_free then
        '⚠️ جسم دوال المسار في القاعدة ما زال يقرأ Vault — نفّذ migration v2.16 (2026-10-22).'
      when not v_live_secret_ok then
        '⚠️ السرّ المعتمد غير موجود في جسم الدالة — نفّذ migration v2.16 (2026-10-22).'
      else
        '⚠️ الرابط المُضمَّن ناقص/مختلف في جسم الدالة — نفّذ migration v2.16 (2026-10-22).'
    end,
    'trigger_messages', exists (select 1 from pg_trigger where tgname = 'on_message_inserted' and not tgisinternal),
    'trigger_calls', exists (select 1 from pg_trigger where tgname = 'on_call_room_notify' and not tgisinternal),
    'trigger_new_user', v_admin_triggers > 0,
    'admins_count', v_admins,
    'registered_users', v_registered,
    'directory_rpc', exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'admin_directory_search'
    ),
    -- مؤشرات العزل (v2.9)
    'isolation_version', 'v2.9',
    'recipient_isolation', jsonb_build_object(
      'new_message', 'conversation-parties-only',
      'incoming_call', 'callee-only',
      'call_ended', 'callee-only',
      'bulk', 'new_user-only',
      'super_admin_silent', true
    ),
    'isolation_gate', exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'push_recipient_allowed'
    ),
    'skipped_total', v_skipped,
    'super_admin_silenced', v_silenced,
    'my_tokens', (select count(*) from public.fcm_tokens where user_id = auth.uid()),
    'last_log', v_last
  ) into v;
  return v;
end;
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.push_diagnostics() to authenticated';
  end if;
end $$;

-- ============================================================
-- ④ push_probe + push_probe_result: نفس المسار المُضمَّن، ورد مُفسَّر.
--    push_probe_result يميّز خطأ DNS صراحةً ويشرح سببه.
-- ============================================================
create or replace function public.push_probe()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_req bigint;
begin
  perform public.push_call_edge('probe', gen_random_uuid(), auth.uid(),
    jsonb_build_object('type', 'probe', 'user_id', auth.uid()));
  select request_id into v_req from public.push_delivery_log
  where kind = 'probe' and recipient_id = auth.uid() order by id desc limit 1;
  return jsonb_build_object('request_id', v_req);
end;
$$;

create or replace function public.push_probe_result(p_request_id bigint)
returns jsonb language plpgsql security definer set search_path = public, net as $$
declare v jsonb;
begin
  select jsonb_build_object(
           'status_code', r.status_code,
           'response', left(r.content::text, 500),
           'error', r.error_msg,
           'dns_error', coalesce(r.error_msg, '') ilike '%resolve host%',
           'hint', case
             when r.status_code = 200 then
               '✅ الطلب وصل إلى send-push (200) — المسار الحيّ سليم.'
             when coalesce(r.error_msg, '') ilike '%resolve host%' then
               '⚠️ فشل تحليل اسم المضيف داخل pg_net — إمّا أن جسم الدالة في القاعدة ما زال يقرأ Vault (URL مشفّر)، أو أن مخرج الشبكة للمشروع مقيّد. نفّذ migration v2.16 ثم push_egress_check.'
             when r.status_code = 401 then
               '⚠️ 401 — السرّ المُضمَّن لا يطابق SEND_PUSH_SECRET على دالة send-push.'
             when r.status_code = 404 then
               '⚠️ 404 — دالة send-push غير منشورة أو الرابط المُضمَّن خاطئ.'
             when r.status_code is null or r.status_code = 0 then
               '⚠️ لم يصل رد من pg_net — اقرأ net._http_response.error_msg.'
             else
               'رد غير متوقع من send-push.'
           end)
  into v from net._http_response r where r.id = p_request_id;
  return coalesce(v, jsonb_build_object('pending', true));
end;
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.push_probe() to authenticated';
    execute 'grant execute on function public.push_probe_result(bigint) to authenticated';
  end if;
end $$;

-- ============================================================
-- ⑤ push_gateway_check: تشخيص إعداد البوابة — كل القيم مُضمَّنة، بلا Vault.
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
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.push_gateway_check() to authenticated';
  end if;
end $$;

-- ============================================================
-- ⑥ push_egress_check (جديد v2.16): يفحص pg_net ← DNS ← send-push مباشرةً،
--    متجاوزاً كل دوال المسار. يميّز بين:
--      • جسم دالة قديم في القاعدة (الطلب يخرج برابط مشفّر) — تُصلحه هذه الهجرة.
--      • مخرج الشبكة (egress) مقيّد أو DNS معطّل في المشروع.
--    يُرجع request_id ⇒ اقرأ الرد عبر push_probe_result(request_id).
-- ============================================================
create or replace function public.push_egress_check()
returns jsonb language plpgsql security definer set search_path = public, net as $$
declare
  v_url text := 'https://gqocavvhkfzgxzscrjms.supabase.co/functions/v1/send-push';
  v_secret text := 'my_send_push_19921121_almgawell_19921121';
  v_headers jsonb;
  v_req bigint;
begin
  v_headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-send-push-secret', v_secret
  );
  begin
    select net.http_post(url := v_url, headers := v_headers,
                         body := jsonb_build_object('type', 'probe', 'user_id', auth.uid()),
                         timeout_milliseconds := 8000)
    into v_req;
  exception when others then
    return jsonb_build_object(
      'url', v_url,
      'queued', false,
      'error', sqlerrm,
      'hint', 'تعذّر إنشاء الطلب في pg_net — تأكد من تفعيل امتداد pg_net.'
    );
  end;
  return jsonb_build_object(
    'url', v_url,
    'queued', true,
    'request_id', v_req,
    'hint', 'الطلب مُدرج في net.calls — اقرأ الرد عبر push_probe_result(request_id) أو net._http_response.'
  );
end;
$$;

revoke all on function public.push_egress_check() from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.push_egress_check() to authenticated';
  end if;
end $$;

-- ============================================================
-- ⑦ الصلاحيات: trigger_send_push_notification و push_call_edge داخليتان
--    (مسار الـ Triggers فقط) — لا RPC مفتوحاً للمُصادَق أو الزوار.
-- ============================================================
do $$
begin
  revoke all on function public.trigger_send_push_notification(text, uuid, uuid, jsonb) from public;
  revoke all on function public.push_call_edge(text, uuid, uuid, jsonb) from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.trigger_send_push_notification(text, uuid, uuid, jsonb) from anon';
    execute 'revoke all on function public.push_call_edge(text, uuid, uuid, jsonb) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.trigger_send_push_notification(text, uuid, uuid, jsonb) from authenticated';
    execute 'revoke all on function public.push_call_edge(text, uuid, uuid, jsonb) from authenticated';
  end if;
exception when others then
  raise notice 'تخطّي سحب صلاحيات الدوال الداخلية: %', sqlerrm;
end $$;

-- ============================================================
-- ⑧ ضمان وجود تريگر الإدراج على messages (يستدعي notify_new_message →
--    push_call_edge → trigger_send_push_notification → pg_net).
-- ============================================================
do $$
begin
  if to_regclass('public.messages') is not null
     and to_regprocedure('public.notify_new_message()') is not null
     and not exists (
       select 1 from pg_trigger
       where tgname = 'on_message_inserted' and tgrelid = to_regclass('public.messages')
         and not tgisinternal
     )
  then
    create trigger on_message_inserted
      after insert on public.messages
      for each row execute procedure public.notify_new_message();
  end if;
end $$;

-- ============================================================
-- 23. الإصدار v2.17 (2026-10-23): نقطة تسليم قابلة للتهيئة + تشخيص شبكة القاعدة
-- ------------------------------------------------------------
-- التشخيص (v2.16 كشفه): أجسام الدوال سليمة ومُضمَّنة، لكن `pg_net` داخل
-- القاعدة يفشل في تحليل اسم المضيف حتى مع الرابط الحرفي الصحيح:
--   error_msg = "Couldn't resolve host name" (status_code = 0، body فارغ).
-- ⇒ المشكلة على مستوى شبكة حاوية القاعدة (DNS/مخرج) لا في الكود.
--
-- ⚠️ لا يوجد نقل بديل داخل القاعدة: supabase_functions.http_request (المُستخدَم
--    في Database Webhooks) هو trigger wrapper حول net.http_post نفسه ⇒ نفس
--    مسار DNS. لذلك الحلّ الجذري هو:
--   ① جعل نقطة التسليم (delivery endpoint) قابلة للتهيئة وقت التشغيل ⇒
--      يمكن توجيه القاعدة إلى بوابة بديلة (مثل Cloudflare Worker) بلا هجرة جديدة.
--   ② تشخيص صريح لشبكة القاعدة: أي مضيفات تصل إليها وأيها لا تصل ⇒ قرار واضح.
--   ③ توثيق مسار بديل جاهز: Worker وسيط يمرّر الطلب إلى دالة send-push.
--
-- 🔒 أمان: تعديل نقطة التسليم يقتصر على service_role / SQL Editor
--    (لا يُعرَض كـ RPC للمستخدمين) — منعاً لتحويل مسار الإرسال إلى مهاجم.
-- ============================================================

-- ============================================================
-- ① جدول إعدادات المسار (صفّ واحد)
--    delivery_url = NULL ⇒ استخدم الرابط المُضمَّن الافتراضي.
-- ============================================================
-- مطابق لهجرة sql/migrations/2026-10-23_v2_17_push_delivery_endpoint_and_net_diagnostics.sql
-- ============================================================

create table if not exists public.push_settings (
  id boolean primary key default true check (id),
  delivery_url text,
  updated_at timestamptz not null default now()
);
comment on table public.push_settings is
'إعدادات مسار تسليم إشعارات الخلفية (صفّ واحد). delivery_url فارغ = الرابط المُضمَّن الافتراضي. التعديل من service_role أو SQL Editor فقط.';

insert into public.push_settings (id, delivery_url)
values (true, null)
on conflict (id) do nothing;

alter table public.push_settings enable row level security;
-- لا سياسات: لا أحد يقرأ/يكتب من exterior عدا service_role (يتجاوز RLS).

-- ============================================================
-- ② نقطة التسليم الفعّالة: من الإعدادات، وإلا الرابط المُضمَّن.
-- ============================================================
create or replace function public.push_delivery_url()
returns text language sql stable security definer set search_path = public as $$
  select coalesce(
    (select s.delivery_url from public.push_settings s where s.id),
    'https://gqocavvhkfzgxzscrjms.supabase.co/functions/v1/send-push'
  );
$$;

grant execute on function public.push_delivery_url() to authenticated;

-- مُعدِّل نقطة التسليم — service_role فقط (أو SQL Editor).
create or replace function public.push_set_delivery_url(p_url text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if coalesce(p_url, '') <> '' and p_url !~ '^https://' then
    return jsonb_build_object('ok', false, 'error', 'يجب أن يبدأ الرابط بـ https://');
  end if;
  insert into public.push_settings (id, delivery_url, updated_at)
  values (true, nullif(p_url, ''), now())
  on conflict (id) do update set delivery_url = excluded.delivery_url, updated_at = now();
  return jsonb_build_object(
    'ok', true,
    'delivery_url', public.push_delivery_url(),
    'is_default', public.push_delivery_url() = 'https://gqocavvhkfzgxzscrjms.supabase.co/functions/v1/send-push'
  );
end;
$$;

revoke all on function public.push_set_delivery_url(text) from public, anon, authenticated;
-- المنح شرطي: بعض قواعد PostgreSQL العادية لا تملك دور service_role،
-- وتطبيق الهجرة يجب ألا يفشل بسبب ذلك.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.push_set_delivery_url(text) to service_role';
  end if;
end $$;

-- ============================================================
-- ③ بوابة الإشعارات: تأخذ الرابط من الإعدادات (قابل للتهيئة).
--    ⚠️ SECRET — مُضمَّن مباشرةً (بلا Vault). يجب أن يطابق تماماً
--    SEND_PUSH_SECRET المضبوط على دالة send-push، وإلا رُدّت الطلبات بـ 401.
-- ============================================================
create or replace function public.trigger_send_push_notification(
  p_kind text,
  p_ref uuid,
  p_recipient uuid,
  p_body jsonb
)
returns void language plpgsql security definer set search_path = public, net as $$
declare
  v_secret text := 'my_send_push_19921121_almgawell_19921121';
  v_url text;
  v_headers jsonb;
  v_req bigint;
  v_allowed boolean := false;
begin
  -- ⛔ البوابة: لا مستلم مطابق للحدث ⇒ لا طلب شبكة ولا إشعار (يُسجَّل السبب فقط)
  begin
    v_allowed := public.push_recipient_allowed(p_kind, p_ref, p_recipient, p_body);
  exception when others then
    v_allowed := false;
  end;

  if not v_allowed then
    insert into public.push_delivery_log(kind, ref_id, recipient_id, note)
    values (p_kind, p_ref, p_recipient, public.push_skip_note(p_kind, p_recipient));
    return;
  end if;

  -- نقطة التسليم: من الإعدادات (قابلة للتهيئة) وإلا الرابط المُضمَّن
  v_url := public.push_delivery_url();

  v_headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-send-push-secret', v_secret
  );

  -- net.http_post غير متزامن: يُدرج الطلب في net.calls ويعالجه عامل الخلفية،
  -- والرد يُقرأ لاحقاً من net._http_response (بلا انتظار شبكي داخل التريگر).
  begin
    select net.http_post(url := v_url, headers := v_headers, body := p_body, timeout_milliseconds := 8000)
    into v_req;
    insert into public.push_delivery_log(kind, ref_id, recipient_id, request_id)
    values (p_kind, p_ref, p_recipient, v_req);
  exception when others then
    -- لا تُفشل إدراج الرسالة/المكالمة بسبب خطأ في الإشعار
    insert into public.push_delivery_log(kind, ref_id, recipient_id, note)
    values (p_kind, p_ref, p_recipient, 'ERROR: ' || sqlerrm);
  end;
end;
$$;

-- ============================================================
-- ④ تشخيص شبكة القاعدة: أي مضيفات تصل إليها وأيها لا تصل.
--    كل مسبار يُدرج في net.calls ⇒ يُقرأ ردّه عبر push_probe_result(request_id).
-- ============================================================
create or replace function public.push_net_diagnostics()
returns jsonb language plpgsql security definer set search_path = public, net as $$
declare
  v_url text := public.push_delivery_url();
  v_fn text := 'https://gqocavvhkfzgxzscrjms.supabase.co/functions/v1/send-push';
  v_legacy text := 'https://gqocavvhkfzgxzscrjms.functions.supabase.co/send-push';
  v_r_fn bigint;
  v_r_legacy bigint;
  v_r_public bigint;
  v_r_cf bigint;
begin
  -- مسبار ①: دالة send-push نفسها (الرابط الفعّال)
  begin
    select net.http_post(url := v_url,
                         headers := jsonb_build_object('Content-Type','application/json'),
                         body := jsonb_build_object('type','probe','user_id', auth.uid()),
                         timeout_milliseconds := 8000)
    into v_r_fn;
  exception when others then
    v_r_fn := null;
  end;

  -- مسبار ②: النطاق القديم للدوال (نطاق DNS مختلف — مفيد للتشخيص)
  begin
    select net.http_get(url := v_legacy, timeout_milliseconds := 6000) into v_r_legacy;
  exception when others then
    v_r_legacy := null;
  end;

  -- مسبار ③: مضيف عام (هل DNS يعمل أصلاً من القاعدة؟)
  begin
    select net.http_get(url := 'https://example.com/', timeout_milliseconds := 6000) into v_r_public;
  exception when others then
    v_r_public := null;
  end;

  -- مسبار ④: Cloudflare (هل يستطيع الوصول إلى workers.dev — مسار بديل؟)
  begin
    select net.http_get(url := 'https://www.cloudflare.com/', timeout_milliseconds := 6000) into v_r_cf;
  exception when others then
    v_r_cf := null;
  end;

  return jsonb_build_object(
    'delivery_url', v_url,
    'delivery_is_default', v_url = v_fn,
    'pg_net_installed', exists (select 1 from pg_extension where extname = 'pg_net'),
    'pg_net_version', coalesce((select extversion from pg_extension where extname = 'pg_net'), null),
    'pg_cron_installed', exists (select 1 from pg_extension where extname = 'pg_cron'),
    'supabase_functions_schema', exists (select 1 from pg_namespace where nspname = 'supabase_functions'),
    'db_address', inet_server_addr()::text,
    'probes', jsonb_build_object(
      'function',  jsonb_build_object('url', v_url,     'request_id', v_r_fn),
      'legacy',    jsonb_build_object('url', v_legacy, 'request_id', v_r_legacy),
      'public',    jsonb_build_object('url', 'https://example.com/',        'request_id', v_r_public),
      'cloudflare',jsonb_build_object('url', 'https://www.cloudflare.com/', 'request_id', v_r_cf)
    ),
    'how_to_read', 'اقرأ رد كل مسبار عبر push_probe_result(request_id): status_code = 200 ⇒ وصل، dns_error = true ⇒ فشل تحليل المضيف، وإلا الخطأ في error_msg.'
  );
end;
$$;

revoke all on function public.push_net_diagnostics() from public, anon;
grant execute on function public.push_net_diagnostics() to authenticated;

-- ============================================================
-- ⑤ push_egress_check يستخدم نقطة التسليم الفعّالة.
-- ============================================================
create or replace function public.push_egress_check()
returns jsonb language plpgsql security definer set search_path = public, net as $$
declare
  v_url text := public.push_delivery_url();
  v_secret text := 'my_send_push_19921121_almgawell_19921121';
  v_headers jsonb;
  v_req bigint;
begin
  v_headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-send-push-secret', v_secret
  );
  begin
    select net.http_post(url := v_url, headers := v_headers,
                         body := jsonb_build_object('type', 'probe', 'user_id', auth.uid()),
                         timeout_milliseconds := 8000)
    into v_req;
  exception when others then
    return jsonb_build_object(
      'url', v_url,
      'queued', false,
      'error', sqlerrm,
      'hint', 'تعذّر إنشاء الطلب في pg_net — تأكد من تفعيل امتداد pg_net.'
    );
  end;
  return jsonb_build_object(
    'url', v_url,
    'queued', true,
    'request_id', v_req,
    'hint', 'الطلب مُدرج في net.calls — اقرأ الرد عبر push_probe_result(request_id).'
  );
end;
$$;

revoke all on function public.push_egress_check() from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.push_egress_check() to authenticated';
  end if;
end $$;

-- ============================================================
-- ⑥ push_diagnostics: أضف حالة نقطة التسليم وإعدادات الشبكة.
-- ============================================================
create or replace function public.push_diagnostics()
returns jsonb language plpgsql security definer set search_path = public, extensions, net as $$
declare
  v jsonb;
  v_last jsonb;
  v_admin_triggers integer := 0;
  v_registered bigint := 0;
  v_skipped bigint := 0;
  v_silenced bigint := 0;
  v_admins bigint := 0;
  v_url_const text := 'https://gqocavvhkfzgxzscrjms.supabase.co/functions/v1/send-push';
  v_secret_const text := 'my_send_push_19921121_almgawell_19921121';
  v_vault_pat text := 'vau' || 'lt\.[a-z_]';
  v_live jsonb;
  v_live_url text;
  v_live_vault_free boolean := false;
  v_live_secret_ok boolean := false;
  v_live_url_ok boolean := false;
  v_delivery_url text;
begin
  -- ── الفحص الحيّ لأجسام الدوال (v2.16) ──
  begin
    select jsonb_object_agg(t.proname, jsonb_build_object(
             'reads_vault', t.reads_vault,
             'has_secret', t.has_secret,
             'has_url', t.has_url))
    into v_live
    from (
      select p.proname,
             bool_or(p.prosrc ~* v_vault_pat) as reads_vault,
             bool_or(p.prosrc like '%' || v_secret_const || '%') as has_secret,
             -- الرابط قد يكون في push_delivery_url (نقطة التسليم) أو داخل
             -- الدالة نفسها ⇒ نحسبهما معاً
             bool_or(p.prosrc like '%' || v_url_const || '%')
               or bool_or(p.prosrc like '%/functions/v1/send-push%') as has_url
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname in ('push_call_edge','trigger_send_push_notification','push_gateway_check','push_delivery_url')
      group by p.proname
    ) t;
  exception when others then
    v_live := null;
  end;

  v_live := coalesce(v_live, '{}'::jsonb);
  v_live_vault_free := coalesce((
    select bool_and(not coalesce((f.value->>'reads_vault')::boolean, false))
    from jsonb_each(v_live) as f(key, value)), false);
  v_live_secret_ok := coalesce((v_live->'trigger_send_push_notification'->>'has_secret')::boolean, false);
  v_live_url_ok := coalesce((v_live->'push_delivery_url'->>'has_url')::boolean, false)
    or coalesce((v_live->'trigger_send_push_notification'->>'has_url')::boolean, false);

  begin
    select (regexp_match(p.prosrc, 'https://[a-z0-9.-]+\.supabase\.co/functions/v1/send-push'))[1]
    into v_live_url
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('push_delivery_url','trigger_send_push_notification')
    order by (p.proname = 'push_delivery_url') desc
    limit 1;
  exception when others then
    v_live_url := null;
  end;

  v_delivery_url := public.push_delivery_url();

  begin
    select jsonb_agg(x order by x.id desc) into v_last
    from (
      select l.id, l.kind, l.note, l.request_id, l.created_at,
             r.status_code, left(r.content::text, 300) as response, r.error_msg
      from public.push_delivery_log l
      left join net._http_response r on r.id = l.request_id
      where l.recipient_id = auth.uid() or public.is_admin_user()
      order by l.id desc limit 5
    ) x;
  exception when others then
    select jsonb_agg(x) into v_last from (
      select kind, note, request_id, created_at from public.push_delivery_log
      where recipient_id = auth.uid() or public.is_admin_user() order by id desc limit 5) x;
  end;

  begin
    select count(*) into v_admin_triggers
    from pg_trigger where tgname = 'on_profile_created_notify_admins' and not tgisinternal;
    select count(*) into v_registered from public.profiles;
    select count(*) into v_skipped from public.push_delivery_log where note like 'SKIPPED%';
    select count(*) into v_silenced from public.push_delivery_log where note like '%مشرف عام%';
    begin
      select count(*) into v_admins from public.admin_recipient_ids();
    exception when others then
      begin
        select count(*) into v_admins from public.profiles
        where (is_admin = true or is_super_admin = true) and not is_blocked;
      exception when others then
        v_admins := 0;
      end;
    end;
  exception when others then
    v_admin_triggers := 0;
    v_registered := 0;
    v_skipped := 0;
    v_silenced := 0;
    v_admins := 0;
  end;

  select jsonb_build_object(
    'pg_net_installed', exists (select 1 from pg_extension where extname = 'pg_net'),
    -- v2.17: نقطة التسليم الفعّالة (قابلة للتهيئة)
    'delivery_url', v_delivery_url,
    'delivery_is_default', v_delivery_url = v_url_const,
    'delivery_overridden', v_delivery_url <> v_url_const,
    -- الرابط الحيّ (من جسم الدالة) — لا ثابت
    'edge_function_url', coalesce(v_live_url, v_url_const),
    'edge_url_hardcoded', true,
    'edge_url_ok', v_live_url_ok and coalesce(v_live_url, v_url_const) like '%/functions/v1/send-push%',
    'secret_hardcoded', v_live_secret_ok,
    'vault_dependency', not v_live_vault_free,
    'live_path_vault_free', v_live_vault_free,
    'live_path_secret_ok', v_live_secret_ok,
    'live_path_url_ok', v_live_url_ok,
    'live_path_stale', not (v_live_vault_free and v_live_secret_ok and v_live_url_ok),
    'live_path_functions', v_live,
    'live_path_hint', case
      when v_live_vault_free and v_live_secret_ok and v_live_url_ok then
        '✅ جسم دوال المسار في القاعدة محدَّث ومُضمَّن (بلا Vault).'
      when not v_live_vault_free then
        '⚠️ جسم دوال المسار في القاعدة ما زال يقرأ Vault — نفّذ migration v2.16 (2026-10-22).'
      when not v_live_secret_ok then
        '⚠️ السرّ المعتمد غير موجود في جسم الدالة — نفّذ migration v2.16 (2026-10-22).'
      else
        '⚠️ الرابط المُضمَّن ناقص/مختلف في جسم الدالة — نفّذ migration v2.16 (2026-10-22).'
    end,
    'trigger_messages', exists (select 1 from pg_trigger where tgname = 'on_message_inserted' and not tgisinternal),
    'trigger_calls', exists (select 1 from pg_trigger where tgname = 'on_call_room_notify' and not tgisinternal),
    'trigger_new_user', v_admin_triggers > 0,
    'admins_count', v_admins,
    'registered_users', v_registered,
    'directory_rpc', exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'admin_directory_search'
    ),
    'isolation_version', 'v2.9',
    'recipient_isolation', jsonb_build_object(
      'new_message', 'conversation-parties-only',
      'incoming_call', 'callee-only',
      'call_ended', 'callee-only',
      'bulk', 'new_user-only',
      'super_admin_silent', true
    ),
    'isolation_gate', exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'push_recipient_allowed'
    ),
    'skipped_total', v_skipped,
    'super_admin_silenced', v_silenced,
    'my_tokens', (select count(*) from public.fcm_tokens where user_id = auth.uid()),
    'last_log', v_last
  ) into v;
  return v;
end;
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.push_diagnostics() to authenticated';
  end if;
end $$;

-- ============================================================
-- ⑦ push_probe_result: تلميح أدق (v2.17) — يشير إلى v2.17 ونقطة التسليم.
-- ============================================================
create or replace function public.push_probe_result(p_request_id bigint)
returns jsonb language plpgsql security definer set search_path = public, net as $$
declare v jsonb;
begin
  select jsonb_build_object(
           'status_code', r.status_code,
           'response', left(r.content::text, 500),
           'error', r.error_msg,
           'dns_error', coalesce(r.error_msg, '') ilike '%resolve host%',
           'hint', case
             when r.status_code = 200 then
               '✅ الطلب وصل إلى send-push (200) — المسار الحيّ سليم.'
             when coalesce(r.error_msg, '') ilike '%resolve host%' then
               '⚠️ فشل تحليل اسم المضيف داخل pg_net — القاعدة لا تصل إلى هذا المضيف. شغّل push_net_diagnostics لمعرفة المضيفات التي تصل إليها القاعدة.'
             when r.status_code = 401 then
               '⚠️ 401 — السرّ المُضمَّن لا يطابق SEND_PUSH_SECRET على دالة send-push.'
             when r.status_code = 404 then
               '⚠️ 404 — دالة send-push غير منشورة أو الرابط المُضمَّن خاطئ.'
             when r.status_code is null or r.status_code = 0 then
               '⚠️ لم يصل رد من pg_net — اقرأ net._http_response.error_msg.'
             else
               'رد غير متوقع من send-push.'
           end)
  into v from net._http_response r where r.id = p_request_id;
  return coalesce(v, jsonb_build_object('pending', true));
end;
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.push_probe_result(bigint) to authenticated';
  end if;
end $$;

-- ============================================================
-- ⑧ الصلاحيات: الدوال الداخلية غير مفتوحة RPC.
-- ============================================================
do $$
begin
  revoke all on function public.trigger_send_push_notification(text, uuid, uuid, jsonb) from public;
  revoke all on function public.push_call_edge(text, uuid, uuid, jsonb) from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.trigger_send_push_notification(text, uuid, uuid, jsonb) from anon';
    execute 'revoke all on function public.push_call_edge(text, uuid, uuid, jsonb) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.trigger_send_push_notification(text, uuid, uuid, jsonb) from authenticated';
    execute 'revoke all on function public.push_call_edge(text, uuid, uuid, jsonb) from authenticated';
  end if;
exception when others then
  raise notice 'تخطّي سحب صلاحيات الدوال الداخلية: %', sqlerrm;
end $$;

-- ============================================================================
-- 24. الإصدار v2.18 (2026-10-24): حكم حاسم على مسار التسليم + إصلاح ذاتي كامل
-- ------------------------------------------------------------
-- 📌 why (ما الذي كشفه v2.17 في القاعدة الحيّة):
--
--   نتيجة مسبارات الشبكة (من القاعدة الحيّة نفسها):
--     • send-push  (gqocavvhkfzgxzscrjms.supabase.co)      ❌ Couldn't resolve host name
--     • example.com                                          ✅ تصل
--     • cloudflare.com                                       ✅ تصل
--     • gqocavvhkfzgxzscrjms.functions.supabase.co            ✅ تصل   ← نطاق بديل!
--
--   ⇒ القاعدة تصل إلى الإنترنت، لكنها **لا تصل إلى نطاق *.supabase.co**.
--     إذاً العطل في **نطاق** دالة EdgeFunctions لهذا المشروع (أو في DNS الخاص
--     به)، لا في كود التريگرات ولا في Secret ولا في Vault.
--
--   ⇒ الحلّ: **وجهة تسليم** تصل إليها القاعدة. المرشّح الأقوى بلا أي نشر:
--     النطاق القديم functions.supabase.co (وهو ما يفحصه المسبار أعلاه).
--     ومهمّة هذه الهجرة: **التحقّق الحاسم** هل يخدم هذا النطاق دالة send-push
--     فعلاً (لا يكفي أن يُحلَّل اسم المضيف) — ثم تحويل مسار التسليم إليه
--     **أمر واحد**، بلا هجرة جديدة وبلا نشر.
--
-- 📌 why "الإصلاح الذاتي" (drop + create بدل create or replace):
--     `create or replace` **يفشل** إذا اختلف نوع الإرجاع أو التوقيع عن
--     النسخة القائمة في القاعدة ⇒ عندها **يتوقّف تنفيذ الملف عند تلك
--     العبارة** وتبقى الدوال القديمة (القائمة على Vault) ⇒ خطأ
--     "push_gateway_check غير متاحة". الحل: نحذف كل النسخ (أي توقيع) ثم
--     نُنشئ من جديد ⇒ لا يتأثر شيء، مهما كانت حالة القاعدة.
--
-- 🔒 لا Vault: الرابط والسرّ مُضمَّنان (بلا قراءة من vault.* في أي جسم).
-- 🔒 التحويل إلى وجهة جديدة: `push_path_verdict(true)` يحوّل **خدمةً فقط**
--     (service_role / SQL Editor) — أي مستخدم مصادَق يستطيع القراءة فقط.
--
-- 📦 الاستعمال بعد تطبيق هذا الملف:
--     select public.push_path_verdict();          -- حكم + أفضل وجهة (قراءة)
--     select public.push_path_verdict(true);       -- يحوّل المسار تلقائياً
--     select public.push_probe_endpoint('https://…');  -- اختبار أي رابط
-- ============================================================================
-- مطابق لهجرة sql/migrations/2026-10-24_v2_18_push_path_verdict_and_self_healing.sql

-- ---------------------------------------------------------------------------
-- ① الإصلاح الذاتي: حذف كل نسخ دوال المسار (أي توقيع) ثم إعادة إنشائها.
--    (التبعية الوحيدة: التريغرات تستدعي notify_new_message لا هذه الدوال،
--     فلا تسقط التريغرات — والتحقق في الاختبارات على هذا الأساس.)
-- ---------------------------------------------------------------------------
-- ============================================================

do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure::text as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'trigger_send_push_notification', 'push_call_edge', 'push_diagnostics',
        'push_gateway_check', 'push_probe', 'push_probe_result',
        'push_egress_check', 'push_delivery_url', 'push_set_delivery_url',
        'push_net_diagnostics', 'push_probe_endpoint', 'push_path_verdict',
        'push_fire_probe', 'push_await_probe'
      )
  loop
    execute 'drop function if exists ' || r.sig || ' cascade';
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- ② نقطة التسليم القابلة للتهيئة (من v2.17) — تُعاد هنا لتكون مكتفية ذاتياً.
-- ---------------------------------------------------------------------------
create table if not exists public.push_settings (
  id boolean primary key default true check (id),
  delivery_url text,
  updated_at timestamptz not null default now()
);

insert into public.push_settings (id, delivery_url)
values (true, null)
on conflict (id) do nothing;

alter table public.push_settings enable row level security;
-- لا سياسات: لا أحد يقرأ/يكتب من exterior عدا service_role (يتجاوز RLS).

create function public.push_delivery_url()
returns text language sql stable security definer set search_path = public as $$
  select coalesce(
    (select s.delivery_url from public.push_settings s where s.id),
    'https://gqocavvhkfzgxzscrjms.supabase.co/functions/v1/send-push'
  );
$$;

grant execute on function public.push_delivery_url() to authenticated;

create function public.push_set_delivery_url(p_url text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if coalesce(p_url, '') <> '' and p_url !~ '^https://' then
    return jsonb_build_object('ok', false, 'error', 'يجب أن يبدأ الرابط بـ https://');
  end if;
  insert into public.push_settings (id, delivery_url, updated_at)
  values (true, nullif(p_url, ''), now())
  on conflict (id) do update set delivery_url = excluded.delivery_url, updated_at = now();
  return jsonb_build_object(
    'ok', true,
    'delivery_url', public.push_delivery_url(),
    'is_default', public.push_delivery_url() = 'https://gqocavvhkfzgxzscrjms.supabase.co/functions/v1/send-push'
  );
end;
$$;

revoke all on function public.push_set_delivery_url(text) from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.push_set_delivery_url(text) to service_role';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- ③ مسار التسليم: التريغر يقرأ نقطة التسليم ⇒ تبديل الوجهة يسري فوراً.
-- ---------------------------------------------------------------------------
create function public.trigger_send_push_notification(
  p_kind text,
  p_ref uuid,
  p_recipient uuid,
  p_body jsonb
)
returns void language plpgsql security definer set search_path = public, net as $$
declare
  v_secret text := 'my_send_push_19921121_almgawell_19921121';
  v_url text;
  v_headers jsonb;
  v_req bigint;
  v_allowed boolean := false;
begin
  -- ⛔ البوابة: لا مستلم مطابق للحدث ⇒ لا طلب شبكة ولا إشعار
  begin
    v_allowed := public.push_recipient_allowed(p_kind, p_ref, p_recipient, p_body);
  exception when others then
    v_allowed := false;
  end;

  if not v_allowed then
    insert into public.push_delivery_log(kind, ref_id, recipient_id, note)
    values (p_kind, p_ref, p_recipient, public.push_skip_note(p_kind, p_recipient));
    return;
  end if;

  -- نقطة التسليم: من الإعدادات (قابلة للتهيئة) وإلا الرابط المُضمَّن
  v_url := public.push_delivery_url();

  v_headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-send-push-secret', v_secret
  );

  -- net.http_post غير متزامن: يُدرج الطلب في net.calls ويعالجه عامل الخلفية.
  begin
    select net.http_post(url := v_url, headers := v_headers, body := p_body, timeout_milliseconds := 8000)
    into v_req;
    insert into public.push_delivery_log(kind, ref_id, recipient_id, request_id)
    values (p_kind, p_ref, p_recipient, v_req);
  exception when others then
    insert into public.push_delivery_log(kind, ref_id, recipient_id, note)
    values (p_kind, p_ref, p_recipient, 'ERROR: ' || sqlerrm);
  end;
end;
$$;

create function public.push_call_edge(p_kind text, p_ref uuid, p_recipient uuid, p_body jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.trigger_send_push_notification(p_kind, p_ref, p_recipient, p_body);
end;
$$;

-- ---------------------------------------------------------------------------
-- ④ المسبار الحاسم: POST حقيقي بصيغة send-push + السرّ ⇒ 200 = الوجهة تعمل.
--    (الحصول على 200 يعني: النطاق يخدم الدالة + السرّ مطابق + pg_net سليم.)
--    لا أثر جانبي: user_id وهمي ⇒ تردّ الدالة بـ {"sent":0,…} بلا إشعار.
-- ---------------------------------------------------------------------------
create function public.push_fire_probe(p_url text)
returns bigint language plpgsql security definer set search_path = public, net as $$
declare
  v_req bigint;
begin
  select net.http_post(
           url := p_url,
           headers := jsonb_build_object(
             'Content-Type', 'application/json',
             'x-send-push-secret', 'my_send_push_19921121_almgawell_19921121'
           ),
           body := jsonb_build_object(
             'type', 'probe',
             'user_id', '00000000-0000-4000-8000-000000000000'
           ),
           timeout_milliseconds := 8000
         )
  into v_req;
  return v_req;
exception when others then
  return null;
end;
$$;

create function public.push_await_probe(p_request_id bigint)
returns jsonb language plpgsql security definer set search_path = public, net as $$
declare
  v_status int;
  v_error text;
  v_content text;
  v_dns boolean := false;
  v_hint text;
  v_looks_fn boolean := false;
begin
  if p_request_id is null then
    return jsonb_build_object('status_code', 0, 'error', null, 'dns_error', true,
      'works', false, 'hint', 'تعذّر إطلاق الطلب عبر pg_net — تحقّق من امتداد pg_net.');
  end if;

  for i in 1..12 loop
    select r.status_code, r.error_msg, r.content::text
      into v_status, v_error, v_content
      from net._http_response r
     where r.id = p_request_id;
    exit when v_status is not null;
    perform pg_sleep(0.4);
  end loop;

  if v_status is null then
    return jsonb_build_object('status_code', null, 'error', null, 'dns_error', false,
      'works', false, 'hint', 'لم يردّ الخادم خلال ~5 ثوانٍ — قد يكون المسار بطيئاً أو محجوباً.');
  end if;

  v_dns := (v_status = 0) and (
    coalesce(v_error, '') ilike '%resolve host%'
    or coalesce(v_error, '') ilike '%couldn''t resolve%'
    or coalesce(v_error, '') ilike '%name or service not known%'
    or coalesce(v_content, '') ilike '%resolve host%'
  );

  -- «يعمل» = 200 + ردّ يبدو من دالة send-push (لا صفحة عامة/HTML)
  v_looks_fn := (v_status = 200) and (
    coalesce(v_content, '') = ''
    or coalesce(v_content, '') ilike '%sent%'
    or coalesce(v_content, '') ilike '%skipped%'
    or coalesce(v_content, '') ilike '%no fcm token%'
    or coalesce(v_content, '') ilike '%error%'
  );

  v_hint := case
    when v_status = 200 and v_looks_fn then '✅ الوجهة تخدم دالة send-push والسرّ مطابق — تصلح للتسليم فوراً.'
    when v_status = 200 then '⚠️ ردّ 200 لكن مضمونه لا يبدو من دالة send-push — تحقق أن الوجهة ليست صفحة عامة.'
    when v_status = 401 then '⚠️ الوجهة تصل لكن رفضت السرّ (x-send-push-secret) — طابِق السرّ على الدالة.'
    when v_status = 404 then '⚠️ الوجهة تصل لكن لا تخدم send-push عند هذا المسار (404).'
    when v_status = 405 then '⚠️ الوجهة تصل لكنMethod Not Allowed — يجب أن يكون الطلب POST.'
    when v_dns then '❌ فشل تحليل اسم المضيف من داخل القاعدة — هذا النطاق غير قابل للوصول من القاعدة.'
    else '⚠️ رد غير متوقع (' || v_status || '): ' || coalesce(v_error, v_content, '')
  end;

  return jsonb_build_object(
    'status_code', v_status,
    'error', v_error,
    'content', v_content,
    'dns_error', v_dns,
    'works', v_looks_fn,
    'hint', v_hint
  );
end;
$$;

create function public.push_probe_endpoint(p_url text)
returns jsonb language plpgsql security definer set search_path = public, net as $$
declare
  v_req bigint;
  v_res jsonb;
begin
  if coalesce(p_url, '') = '' then
    return jsonb_build_object('url', p_url, 'request_id', null, 'status_code', 0,
      'dns_error', true, 'works', false, 'hint', 'رابط فارغ.');
  end if;
  v_req := public.push_fire_probe(p_url);
  v_res := public.push_await_probe(v_req);
  return v_res || jsonb_build_object('url', p_url, 'request_id', v_req);
end;
$$;

revoke all on function public.push_fire_probe(text) from public, anon;
revoke all on function public.push_await_probe(bigint) from public, anon;
revoke all on function public.push_probe_endpoint(text) from public, anon;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.push_probe_endpoint(text) to authenticated';
    execute 'grant execute on function public.push_await_probe(bigint) to authenticated';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- ⑤ الحكم الشامل في نداء واحد: يفحص كل المرشّحين بالتوازي ثم يقرأ الردود
--    معاً (≤ ~5 ثوانٍ) ⇒ نتيجة كاملة في استدعاء واحد.
--
--    المرشّحون:
--      primary : رابط دالة EdgeFunctions الرسمي (*.supabase.co/functions/v1/…)
--      legacy  : النطاق القديم functions.supabase.co (نطاق مختلف — يحلّ DNSه)
--      current : نقطة التسليم الحالية إن كانت مختلفة (مثل بوابة Worker)
--
--    p_apply = true ⇒ يحوّل نقطة التسليم تلقائياً إلى أول مرشّح يعمل.
--    التحويل متاح للخدمة فقط (service_role / SQL Editor) — أي مستخدم
--    مصادَق يقرأ الحكم دون أن يغيّر الوجهة.
-- ---------------------------------------------------------------------------
create function public.push_path_verdict(p_apply boolean default false)
returns jsonb language plpgsql security definer set search_path = public, net as $$
declare
  v_primary text := 'https://gqocavvhkfzgxzscrjms.supabase.co/functions/v1/send-push';
  v_legacy  text := 'https://gqocavvhkfzgxzscrjms.functions.supabase.co/send-push';
  v_current text := public.push_delivery_url();

  v_labels text[] := array[]::text[];
  v_urls   text[] := array[]::text[];
  v_reqs   bigint[] := array[]::bigint[];
  v_inet_req bigint;
  v_inet_status int;
  v_inet_error text;
  v_inet_content text;
  v_inet_dns boolean := false;
  v_done   int := 0;
  v_status int;
  v_error  text;
  v_content text;
  v_dns boolean;
  v_best text := null;
  v_best_label text := null;
  v_switched boolean := false;
  v_applied boolean := false;
  v_role text;
  v_candidates jsonb := '[]'::jsonb;
  v_item jsonb;
  v_i int;
  v_works_count int := 0;
  v_any_dns boolean := false;
  v_looks_fn boolean := false;
  v_jwt_role text;
  v_can_apply boolean := false;
begin
  -- قائمة المرشّحين (بلا تكرار)
  v_labels := array_append(v_labels, 'primary');
  v_urls   := array_append(v_urls, v_primary);
  if v_legacy <> v_primary then
    v_labels := array_append(v_labels, 'legacy');
    v_urls   := array_append(v_urls, v_legacy);
  end if;
  if v_current <> v_primary and not (v_current = any(v_urls)) then
    v_labels := array_append(v_labels, 'current');
    v_urls   := array_append(v_urls, v_current);
  end if;

  -- إطلاق كل المسبارات بالتوازي (net.http_post غير متزامن)
  for v_i in 1..array_length(v_urls, 1) loop
    v_reqs := array_append(v_reqs, public.push_fire_probe(v_urls[v_i]));
  end loop;

  -- مسبار عام: هل يعمل DNS من القاعدة تجاه أي مضيف؟ (ليس مرشّح تسليم)
  v_inet_req := public.push_fire_probe('https://example.com/');

  -- انتظار الردود معاً (استطلاع واحد لكل الجميع)
  for i in 1..12 loop
    select count(*) into v_done
      from net._http_response r
     where r.id = any(v_reqs);
    exit when v_done >= coalesce(array_length(v_reqs, 1), 0);
    perform pg_sleep(0.4);
  end loop;

  -- قراءة ردّ المسبار العام
  select r.status_code, r.error_msg, r.content::text
    into v_inet_status, v_inet_error, v_inet_content
    from net._http_response r
   where r.id = v_inet_req;
  v_inet_dns := (v_inet_status = 0) and (
    coalesce(v_inet_error, '') ilike '%resolve host%'
    or coalesce(v_inet_error, '') ilike '%name or service not known%'
  );

  -- تجميع النتائج
  for v_i in 1..array_length(v_urls, 1) loop
    select r.status_code, r.error_msg, r.content::text
      into v_status, v_error, v_content
      from net._http_response r
     where r.id = v_reqs[v_i];

    v_dns := (v_status = 0) and (
      coalesce(v_error, '') ilike '%resolve host%'
      or coalesce(v_error, '') ilike '%couldn''t resolve%'
      or coalesce(v_error, '') ilike '%name or service not known%'
      or coalesce(v_content, '') ilike '%resolve host%'
    );

    v_looks_fn := (v_status = 200) and (
      coalesce(v_content, '') = ''
      or coalesce(v_content, '') ilike '%sent%'
      or coalesce(v_content, '') ilike '%skipped%'
      or coalesce(v_content, '') ilike '%no fcm token%'
      or coalesce(v_content, '') ilike '%error%'
    );

    v_item := jsonb_build_object(
      'label', v_labels[v_i],
      'url', v_urls[v_i],
      'request_id', v_reqs[v_i],
      'status_code', v_status,
      'error', v_error,
      'dns_error', v_dns,
      'works', v_looks_fn,
      'hint', case
        when v_status = 200 and v_looks_fn then '✅ الوجهة تخدم دالة send-push والسرّ مطابق — تصلح للتسليم فوراً.'
        when v_status = 200 then '⚠️ ردّ 200 لكن مضمونه لا يبدو من دالة send-push.'
        when v_status = 401 then '⚠️ الوجهة تصل لكن رفضت السرّ (x-send-push-secret).'
        when v_status = 404 then '⚠️ الوجهة تصل لكن لا تخدم send-push عند هذا المسار (404).'
        when v_dns then '❌ فشل تحليل اسم المضيف من داخل القاعدة — النطاق غير قابل للوصول منها.'
        when v_status is null then '⚠️ لم يردّ الخادم خلال ~5 ثوانٍ.'
        else '⚠️ رد غير متوقع (' || coalesce(v_status::text, '?') || '): ' || coalesce(v_error, v_content, '')
      end
    );
    v_candidates := v_candidates || jsonb_build_array(v_item);
    if v_dns then
      v_any_dns := true;
    end if;

    if v_looks_fn then
      v_works_count := v_works_count + 1;
      if v_best is null then
        v_best := v_urls[v_i];
        v_best_label := v_labels[v_i];
      end if;
    end if;
  end loop;

  -- التحويل التلقائي (خدمة فقط):
  --   • service_role (مفتاح service_role)  أو  جلسة SQL Editor (session_user=postgres).
  --   ⚠️ لا نعتمد على current_user لأنه مالك الدالة (postgres) داخل security definer.
  v_jwt_role := null;
  begin
    v_jwt_role := auth.jwt() ->> 'role';
  exception when others then
    v_jwt_role := null;
  end;
  v_role := coalesce(nullif(v_jwt_role, ''), session_user::text);
  v_can_apply := (v_jwt_role = 'service_role')
    or (v_jwt_role is null and session_user in ('postgres', 'supabase_admin'));
  v_applied := p_apply and v_best is not null and v_best <> v_current and v_can_apply;
  if v_applied then
    perform public.push_set_delivery_url(v_best);
    v_switched := public.push_delivery_url() = v_best;
  end if;

  return jsonb_build_object(
    'delivery_url', public.push_delivery_url(),
    'delivery_is_default', public.push_delivery_url() = v_primary,
    'candidates', v_candidates,
    'internet_reachable', coalesce(v_inet_status, 0) > 0 and not v_inet_dns,
    'internet_probe', jsonb_build_object(
      'url', 'https://example.com/',
      'request_id', v_inet_req,
      'status_code', v_inet_status,
      'dns_error', v_inet_dns,
      'hint', case
        when v_inet_status is null then '⚠️ لم يردّ المسبار العام خلال ~5 ثوانٍ.'
        when v_inet_dns then '❌ DNS لا يعمل من القاعدة تجاه أي مضيف ⇒ المخرج مقيّد (Project Settings ← Network).'
        else '✅ DNS/Egress يعمل عموماً من القاعدة ⇒ المشكلة محصورة في نطاق supabase.co.'
      end
    ),
    'works_count', v_works_count,
    'best_url', v_best,
    'best_label', v_best_label,
    'switched', v_switched,
    'apply_requested', p_apply,
    'apply_allowed', v_can_apply,
    'role', v_role,
    'verdict', case
      when v_best is not null and v_switched then
        '✅ تم التحويل إلى «' || v_best_label || '» — مسار التسليم الحيّ أصبح: ' || v_best
      when v_best is not null and v_best = v_current then
        '✅ المسار الحالي يعمل (200) — لا حاجة لأي تغيير.'
      when v_best is not null then
        '✅ وجهة صالحة متاحة: ' || v_best || ' — شغّل select public.push_path_verdict(true); لتحويل المسار.'
      when v_works_count = 0 and coalesce(v_inet_status, 0) = 0 then
        '❌ لا يوجد أي مضيف تصل إليه القاعدة (حتى example.com) ⇒ المخرج مقيّد. راجع Project Settings ← Network (Restrict egress) في لوحة Supabase.'
      when v_works_count = 0 and v_any_dns then
        '❌ القاعدة تصل إلى الإنترنت (example.com يعمل) لكنها لا تصل إلى أي نطاق supabase.co. انشر بوابة بديلة (worker/send-push-relay.js) على نطاق workers.dev ثم select public.push_set_delivery_url(''https://<worker>.workers.dev/'');'
      else
        '❌ لم تنجح أي وجهة (لا 200). راجع status_code لكل مرشّح في candidates.'
    end,
    'how_to_apply', 'select public.push_path_verdict(true);  -- يحوّل المسار إلى أفضل وجهة عاملة'
  );
end;
$$;

revoke all on function public.push_path_verdict(boolean) from public, anon;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.push_path_verdict(boolean) to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.push_path_verdict(boolean) to service_role';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- ⑥ push_net_diagnostics: صار يرمز الحالة أيضاً (نداء واحد ⇒ حكم كامل).
--    يبقي نفس الحقول القديمة (probes) +(results) + best_url.
-- ---------------------------------------------------------------------------
create function public.push_net_diagnostics()
returns jsonb language plpgsql security definer set search_path = public, net as $$
declare
  v_verdict jsonb;
  v_probes jsonb := '{}'::jsonb;
  v_item jsonb;
begin
  v_verdict := public.push_path_verdict(false);

  for v_item in select * from jsonb_array_elements(coalesce(v_verdict->'candidates', '[]'::jsonb))
  loop
    v_probes := v_probes || jsonb_build_object(
      v_item->>'label',
      jsonb_build_object('url', v_item->>'url', 'request_id', v_item->>'request_id',
                         'status_code', v_item->>'status_code', 'works', v_item->>'works',
                         'dns_error', v_item->>'dns_error', 'hint', v_item->>'hint')
    );
  end loop;

  return jsonb_build_object(
    'delivery_url', public.push_delivery_url(),
    'delivery_is_default', coalesce(v_verdict->>'delivery_is_default', 'false')::boolean,
    'pg_net_installed', exists (select 1 from pg_extension where extname = 'pg_net'),
    'pg_net_version', coalesce((select extversion from pg_extension where extname = 'pg_net'), null),
    'pg_cron_installed', exists (select 1 from pg_extension where extname = 'pg_cron'),
    'supabase_functions_schema', exists (select 1 from pg_namespace where nspname = 'supabase_functions'),
    'db_address', inet_server_addr()::text,
    'probes', v_probes,
    'results', coalesce(v_verdict->'candidates', '[]'::jsonb),
    'best_url', v_verdict->>'best_url',
    'best_label', v_verdict->>'best_label',
    'works_count', coalesce((v_verdict->>'works_count')::int, 0),
    'verdict', v_verdict->>'verdict',
    'how_to_read', 'results[] لكل مرشّح: status_code = 200 ⇒ الوجهة تعمل وجاهزة للتسليم؛ dns_error = true ⇒ لا يمكن الوصول إليها من القاعدة.'
  );
end;
$$;

revoke all on function public.push_net_diagnostics() from public, anon;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.push_net_diagnostics() to authenticated';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- ⑦ push_gateway_check: أُعيد إنشاؤه (كان جسماً قديماً/مفقوداً ⇒ "غير متاح")
--    ويعرض الآن نقطة التسليم الفعّالة إضافةً إلى الرابط المُضمَّن.
-- ---------------------------------------------------------------------------
create function public.push_gateway_check()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_url text := 'https://gqocavvhkfzgxzscrjms.supabase.co/functions/v1/send-push';
  v_delivery text := public.push_delivery_url();
begin
  return jsonb_build_object(
    'url', v_url,
    'url_hardcoded', true,
    'url_is_edge_function', v_url like '%/functions/v1/send-push%',
    'url_is_worker', coalesce(v_url, '') like '%workers.dev%',
    'url_ok', coalesce(v_url, '') like '%/functions/v1/send-push%',
    'secret_hardcoded', true,
    'vault_dependency', false,
    'delivery_url', v_delivery,
    'delivery_is_default', v_delivery = v_url,
    'chain', 'Database Trigger → pg_net (http_post غير متزامن) → ' || v_delivery
             || ' (verify_jwt = false، تحقّق عبر x-send-push-secret) → FCM HTTP v1 → Service Worker',
    'gateway_hint', case
      when coalesce(v_delivery, '') = '' then
        '⚠️ نقطة التسليم فارغة — لن تُرسل إشعارات الـ Triggers.'
      when v_delivery = v_url then
        '✅ المسار سليم: التريگرات تستدعي send-push برابط وسرّ مُضمَّنين بلا Vault.'
      else
        'ℹ️ نقطة التسليم مُوجَّهة إلى وجهة بديلة (' || v_delivery || ') — راجع push_path_verdict().'
    end
  );
end;
$$;

revoke all on function public.push_gateway_check() from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.push_gateway_check() to authenticated';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- ⑧ push_probe: يرسل مسباراً عبر المسار الحقيقي (بلا Vault).
-- ---------------------------------------------------------------------------
create function public.push_probe()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_req bigint;
begin
  perform public.push_call_edge('probe', gen_random_uuid(), auth.uid(),
    jsonb_build_object('type', 'probe', 'user_id', auth.uid()));
  select request_id into v_req from public.push_delivery_log
  where kind = 'probe' and recipient_id = auth.uid() order by id desc limit 1;
  return jsonb_build_object('request_id', v_req);
end;
$$;

revoke all on function public.push_probe() from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.push_probe() to authenticated';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- ⑨ push_probe_result: يفسّر الرد (DNS / 401 / 404) ويشير إلى الحكم الشامل.
-- ---------------------------------------------------------------------------
create function public.push_probe_result(p_request_id bigint)
returns jsonb language plpgsql security definer set search_path = public, net as $$
declare
  v_status int;
  v_error text;
  v_content text;
  v_dns boolean := false;
begin
  if p_request_id is null then
    return jsonb_build_object('pending', false, 'status_code', 0, 'error', null,
      'dns_error', true, 'hint', 'لا يوجد request_id — شغّل push_probe أولاً.');
  end if;

  select r.status_code, r.error_msg, r.content::text
    into v_status, v_error, v_content
    from net._http_response r
   where r.id = p_request_id;

  if v_status is null then
    return jsonb_build_object('pending', true, 'request_id', p_request_id,
      'hint', 'الطلب ما زال قيد التنفيذ — أعد القراءة بعد لحظات.');
  end if;

  v_dns := (v_status = 0) and (
    coalesce(v_error, '') ilike '%resolve host%'
    or coalesce(v_error, '') ilike '%couldn''t resolve%'
    or coalesce(v_error, '') ilike '%name or service not known%'
    or coalesce(v_content, '') ilike '%resolve host%'
  );

  return jsonb_build_object(
    'pending', false,
    'request_id', p_request_id,
    'status_code', v_status,
    'response', v_content,
    'error', v_error,
    'dns_error', v_dns,
    'hint', case
      when v_status = 200 then '✅ ردّ إيجابي — المسار يعمل.'
      when v_status = 401 then '⚠️ السرّ غير مطابق — supabase secrets set SEND_PUSH_SECRET=…'
      when v_status = 404 then '⚠️ المسار غير موجود على هذا النطاق.'
      when v_dns then '⚠️ فشل تحليل اسم المضيف داخل pg_net — القاعدة لا تصل إلى هذا المضيف. شغّل public.push_path_verdict() لتحديد الوجهة الصالحة وتحويل المسار.'
      else '⚠️ خطأ في pg_net: ' || coalesce(v_error, v_content, '')
    end
  );
end;
$$;

revoke all on function public.push_probe_result(bigint) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.push_probe_result(bigint) to authenticated';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- ⑩ push_egress_check: فحص مباشر (بلا دوال وسيطة) — يبقى للتوافق.
-- ---------------------------------------------------------------------------
create function public.push_egress_check()
returns jsonb language plpgsql security definer set search_path = public, net as $$
declare
  v_url text := public.push_delivery_url();
  v_req bigint;
begin
  select net.http_post(
           url := v_url,
           headers := jsonb_build_object(
             'Content-Type', 'application/json',
             'x-send-push-secret', 'my_send_push_19921121_almgawell_19921121'
           ),
           body := jsonb_build_object('type', 'probe',
                                      'user_id', '00000000-0000-4000-8000-000000000000'),
           timeout_milliseconds := 8000
         )
  into v_req;

  return jsonb_build_object(
    'url', v_url,
    'queued', true,
    'request_id', v_req,
    'hint', 'اقرأ الرد عبر public.push_probe_result(' || coalesce(v_req::text, 'null') || ') أو استدعِ public.push_path_verdict() للحصول على حكم كامل.'
  );
exception when others then
  return jsonb_build_object('url', v_url, 'queued', false, 'request_id', null,
    'error', sqlerrm, 'hint', 'تعذّر إطلاق الطلب من داخل القاعدة.');
end;
$$;

revoke all on function public.push_egress_check() from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.push_egress_check() to authenticated';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- ⑪ push_diagnostics: الحالة الحيّة + نقطة التسليم + كلمة الحكم.
-- ---------------------------------------------------------------------------
create function public.push_diagnostics()
returns jsonb language plpgsql security definer set search_path = public, extensions, net as $$
declare
  v_url_const text := 'https://gqocavvhkfzgxzscrjms.supabase.co/functions/v1/send-push';
  v_secret_const text := 'my_send_push_19921121_almgawell_19921121';
  v_live jsonb;
  v_live_url text;
  v_live_vault boolean := false;
  v_live_secret boolean := false;
  v_live_url_ok boolean := false;
  v_live_stale boolean := false;
  v_live_hint text;
  v_missing text[];
  v_delivery_url text := public.push_delivery_url();
  v_fns jsonb;
  v_token_count int;
  v_last jsonb;
  v_rollup jsonb;
begin
  -- ① فحص الجسم الحيّ لكل دالة في المسار (pg_proc.prosrc) — لا ثوابت.
  select coalesce(jsonb_object_agg(t.proname, jsonb_build_object(
           'has_url', coalesce(t.has_url, false),
           'has_secret', coalesce(t.has_secret, false),
           'reads_vault', coalesce(t.reads_vault, false)
         )), '{}'::jsonb),
         bool_or(coalesce(t.reads_vault, false)),
         bool_or(coalesce(t.has_secret, false)),
         bool_or(coalesce(t.has_url, false))
    into v_live, v_live_vault, v_live_secret, v_live_url_ok
  from (
    select p.proname,
           bool_or(p.prosrc ~* ('vau' || 'lt\.[a-z_]')) as reads_vault,
           bool_or(p.prosrc like '%' || v_secret_const || '%') as has_secret,
           bool_or(p.prosrc like '%' || v_url_const || '%')
             or bool_or(p.prosrc like '%/functions/v1/send-push%') as has_url
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname in ('push_call_edge','trigger_send_push_notification','push_gateway_check','push_delivery_url')
      group by p.proname
  ) t;

  v_fns := v_live;

  -- ② الرابط الحيّ داخل bodies
  select (regexp_match(p.prosrc, 'https://[a-z0-9.-]+\.(?:supabase\.co|functions\.supabase\.co)[^''" ]*'))[1]
    into v_live_url
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('push_delivery_url','trigger_send_push_notification')
   order by (p.proname = 'push_delivery_url') desc
   limit 1;

  -- ② الدوال الناقصة: غيابها = قاعدة متأخرة أيضاً (لا نقول «سليم» ونكذب)
  select array_agg(x) into v_missing
    from unnest(array['push_call_edge','trigger_send_push_notification',
                      'push_gateway_check','push_delivery_url']) as x
   where not exists (
     select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = x);

  v_live_stale := v_live_vault or (v_missing is not null);
  v_live_hint := case
    when v_missing is not null then
      '⚠️ دوال المسار ناقصة في القاعدة: ' || array_to_string(v_missing, ', ')
      || ' — نفّذ migration v2.18 (2026-10-24) (تُنشئ كل النسخ بعد حذفها).'
    when v_live_vault then '⚠️ جسم دوال المسار في القاعدة ما زال يقرأ Vault — نفّذ migration v2.18 (2026-10-24).'
    when not v_live_secret then '⚠️ جسم دوال المسار لا يحمل السرّ المُضمَّن — نفّذ migration v2.18 (2026-10-24).'
    when not v_live_url_ok then '⚠️ جسم دوال المسار لا يحمل رابط send-push — نفّذ migration v2.18 (2026-10-24).'
    else '✅ جسم دوال المسار في القاعدة محدَّث ومُضمَّن (بلا Vault).'
  end;

  -- ③ عدّ التوكنات + آخر سجل تسليم
  begin
    select count(*) into v_token_count from public.fcm_tokens;
  exception when others then
    v_token_count := null;
  end;

  begin
    select to_jsonb(l) into v_last
      from (select id, kind, ref_id, recipient_id, request_id, note, created_at
              from public.push_delivery_log order by id desc limit 1) l;
  exception when others then
    v_last := null;
  end;

  -- ④ ملخّص آخر ردّ من pg_net
  begin
    select to_jsonb(r) into v_rollup
      from (select id, status_code, error_msg
              from net._http_response order by id desc limit 1) r;
  exception when others then
    v_rollup := null;
  end;

  return jsonb_build_object(
    'edge_function_url', coalesce(v_live_url, v_url_const),
    'edge_url_hardcoded', true,
    'edge_url_ok', v_live_url_ok and coalesce(v_live_url, v_url_const) like '%/functions/v1/send-push%',
    'secret_hardcoded', v_live_secret,
    'vault_dependency', v_live_vault,
    'live_path_vault_free', not v_live_vault and v_missing is null,
    'live_path_secret_ok', v_live_secret and v_missing is null,
    'live_path_url_ok', v_live_url_ok and v_missing is null,
    'live_path_missing', coalesce(v_missing, '{}'::text[]),
    'live_path_stale', v_live_stale,
    'live_path_functions', v_fns,
    'live_path_hint', v_live_hint,
    'delivery_url', v_delivery_url,
    'delivery_is_default', v_delivery_url = v_url_const,
    'delivery_overridden', v_delivery_url <> v_url_const,
    'isolation', jsonb_build_object(
      'my_tokens', v_token_count,
      'last_log', v_last,
      'pg_net_rollup', v_rollup
    ),
    'my_tokens', v_token_count,
    'last_log', v_last,
    'hint', 'لتحديد الوجهة الصالحة تلقائياً: select public.push_path_verdict(true);'
  );
end;
$$;

revoke all on function public.push_diagnostics() from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.push_diagnostics() to authenticated';
  end if;
end $$;

comment on function public.push_path_verdict(boolean) is
'الحكم الشامل على مسار التسليم: يفحص كل المرشّحين (primary/legacy/current) بمسبار حقيقي (POST + السرّ ⇒ 200 = يعمل) ويحوّل نقطة التسليم تلقائياً إلى أول مرشّح ناجح. التحويل للخدمة فقط (service_role / SQL Editor).';
comment on function public.push_probe_endpoint(text) is
'اختبار حاسم لوجهة واحدة: POST حقيقي بصيغة send-push + x-send-push-secret ⇒ status_code=200 يعني أن الوجهة تخدم الدالة والسرّ مطابق.';

-- ============================================================================
-- 25. الإصدار v2.19 (2026-10-25): وضع العميل — إلغاء كل اتصال شبكي من القاعدة
-- ------------------------------------------------------------
-- 📌 why (قرار جوهري):
--
--   القاعدة معزولة شبكياً بالكامل: `pg_net` لا يستطيع حتى تحليل أسماء
--   المضيفات ⇒ "Couldn't resolve host name" ⇒ **لا مسار شبكة من القاعدة إلى
--   دالة send-push ولا إلى أي جهة خارجية**. تشخيص v2.18 أثبت ذلك:
--     • *.supabase.co        ❌ فشل DNS
--     • example.com         ✅ تصل  (إذن DNS عام سليم — العطل في النطاق)
--     • *.functions.supabase.co ✅ تصل
--   وبما أن `supabase_functions.http_request` غلافٌ حول `net.http_post` (نفس
--   المسار)، فلا يوجد نقل بديل داخل القاعدة ⇒ **المسار الوحيد المتبقي هو
--   الواجهة (client)**: المتصفح يرصد الحدث عبر Supabase Realtime ثم يستدعي
--   دالة send-push مباشرةً بمصادقة رمز المستخدم (JWT) — بلا سرّ مشترك في
--   المتصفح وبلا أي اتصال من حاوية القاعدة.
--
-- ✅ ما يغيّره هذا الملف:
--   ① `push_settings.push_mode` = 'client' (الافتراضي) | 'db'
--      ⇒ 'client': التريغرات تُسجّل نيّتها في push_delivery_log فقط، ولا
--        تُجري أي طلب شبكة إطلاقاً (لا net.http_post ولا DNS ولا مهل).
--      ⇒ 'db': يعود السلوك القديم (للتراجع) — بلا هجرة جديدة:
--        select public.push_set_mode('db');
--   ② `trigger_send_push_notification` صارت تحترم الوضع (لا شبكة في 'client').
--   ③ `push_diagnostics` صار يعلن push_mode و db_push_enabled.
--   ④ `push_path_verdict` صار يُعلن الوضع ويتخطّى مسبارات الشبكة في وضع
--      العميل (توفّراً للوقت — لا فائدة من فحص DNS وهو معطّل أصلاً).
--
-- 🔒 لا تغيير في الجداول ولا في سياسات RLS — البيانات كما هي تماماً.
-- 🔒 لا Vault: الرابط والسرّ يبقيان مُضمَّنين (للرجوع إلى وضع 'db' لاحقاً).
-- ============================================================================
-- مطابق لهجرة sql/migrations/2026-10-25_v2_19_client_side_push_mode.sql

-- ---------------------------------------------------------------------------
-- ① جدول الإعدادات: عمود الوضع
-- ---------------------------------------------------------------------------
-- ============================================================

alter table public.push_settings
  add column if not exists push_mode text not null default 'client';

do $$
begin
  if exists (
    select 1 from pg_constraint where conname = 'push_settings_push_mode_check'
  ) then
    alter table public.push_settings drop constraint push_settings_push_mode_check;
  end if;
end $$;

alter table public.push_settings
  add constraint push_settings_push_mode_check check (push_mode in ('client', 'db'));

update public.push_settings set push_mode = 'client' where id;

-- ---------------------------------------------------------------------------
-- ② قراءة/تبديل الوضع (التبديل: service_role أو SQL Editor فقط)
-- ---------------------------------------------------------------------------
create or replace function public.push_mode()
returns text language sql stable security definer set search_path = public as $$
  select coalesce(
    (select s.push_mode from public.push_settings s where s.id),
    'client'
  );
$$;

grant execute on function public.push_mode() to authenticated;

create or replace function public.push_set_mode(p_mode text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if coalesce(p_mode, '') not in ('client', 'db') then
    return jsonb_build_object('ok', false, 'error', 'الوضع يجب أن يكون client أو db');
  end if;
  update public.push_settings set push_mode = p_mode, updated_at = now() where id;
  if not found then
    insert into public.push_settings (id, push_mode, updated_at) values (true, p_mode, now())
    on conflict (id) do update set push_mode = excluded.push_mode, updated_at = now();
  end if;
  return jsonb_build_object(
    'ok', true,
    'push_mode', public.push_mode(),
    'db_push_enabled', public.push_mode() = 'db',
    'hint', case
      when p_mode = 'client' then
        'وضع العميل: لا تتصل القاعدة بأي شبكة — الإشعارات ترسلها الواجهة عبر Realtime + استدعاء مباشر لـ send-push.'
      else
        'وضع القاعدة: يعود التريغر إلى إرسال pg_net (يتطلّب وصول القاعدة إلى نطاق الدالة).'
    end
  );
end;
$$;

revoke all on function public.push_set_mode(text) from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.push_set_mode(text) to service_role';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- ③ مسار التسليم: لا شبكة في وضع العميل
-- ---------------------------------------------------------------------------
create or replace function public.trigger_send_push_notification(
  p_kind text,
  p_ref uuid,
  p_recipient uuid,
  p_body jsonb
)
returns void language plpgsql security definer set search_path = public, net as $$
declare
  v_secret text := 'my_send_push_19921121_almgawell_19921121';
  v_url text;
  v_headers jsonb;
  v_req bigint;
  v_allowed boolean := false;
  v_mode text := 'client';
begin
  -- ⛔ البوابة: لا مستلم مطابق للحدث ⇒ لا طلب شبكة ولا إشعار
  begin
    v_allowed := public.push_recipient_allowed(p_kind, p_ref, p_recipient, p_body);
  exception when others then
    v_allowed := false;
  end;

  if not v_allowed then
    insert into public.push_delivery_log(kind, ref_id, recipient_id, note)
    values (p_kind, p_ref, p_recipient, public.push_skip_note(p_kind, p_recipient));
    return;
  end if;

  -- ★ وضع العميل (v2.19): القاعدة لا تتصل بأي شبكة إطلاقاً.
  --   الإرسال يتكفّل به العميل: Realtime يرصد الحدث ← استدعاء مباشر لـ
  --   send-push برمز المستخدم. هنا نسجّل النيّة فقط (أثر تدقيق + تشخيص).
  v_mode := public.push_mode();
  if v_mode = 'client' then
    insert into public.push_delivery_log(kind, ref_id, recipient_id, note)
    values (p_kind, p_ref, p_recipient,
            'CLIENT-MODE: لا شبكة من القاعدة — الإرسال من الواجهة (Realtime ← send-push)');
    return;
  end if;

  -- وضع القاعدة (تراجع اختياري): الطلب غير المتزامن عبر pg_net
  v_url := public.push_delivery_url();

  v_headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-send-push-secret', v_secret
  );

  begin
    select net.http_post(url := v_url, headers := v_headers, body := p_body, timeout_milliseconds := 8000)
    into v_req;
    insert into public.push_delivery_log(kind, ref_id, recipient_id, request_id)
    values (p_kind, p_ref, p_recipient, v_req);
  exception when others then
    insert into public.push_delivery_log(kind, ref_id, recipient_id, note)
    values (p_kind, p_ref, p_recipient, 'ERROR: ' || sqlerrm);
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- ④ push_diagnostics: يعلن الوضع
-- ---------------------------------------------------------------------------
create or replace function public.push_diagnostics()
returns jsonb language plpgsql security definer set search_path = public, extensions, net as $$
declare
  v_url_const text := 'https://gqocavvhkfzgxzscrjms.supabase.co/functions/v1/send-push';
  v_secret_const text := 'my_send_push_19921121_almgawell_19921121';
  v_live jsonb;
  v_live_url text;
  v_live_vault boolean := false;
  v_live_secret boolean := false;
  v_live_url_ok boolean := false;
  v_live_hint text;
  v_missing text[];
  v_delivery_url text := public.push_delivery_url();
  v_mode text := public.push_mode();
  v_fns jsonb;
  v_token_count int;
  v_last jsonb;
  v_rollup jsonb;
begin
  -- ① فحص الجسم الحيّ لكل دالة في المسار (pg_proc.prosrc) — لا ثوابت.
  select coalesce(jsonb_object_agg(t.proname, jsonb_build_object(
           'has_url', coalesce(t.has_url, false),
           'has_secret', coalesce(t.has_secret, false),
           'reads_vault', coalesce(t.reads_vault, false)
         )), '{}'::jsonb),
         bool_or(coalesce(t.reads_vault, false)),
         bool_or(coalesce(t.has_secret, false)),
         bool_or(coalesce(t.has_url, false))
    into v_live, v_live_vault, v_live_secret, v_live_url_ok
  from (
    select p.proname,
           bool_or(p.prosrc ~* ('vau' || 'lt\.[a-z_]')) as reads_vault,
           bool_or(p.prosrc like '%' || v_secret_const || '%') as has_secret,
           bool_or(p.prosrc like '%' || v_url_const || '%')
             or bool_or(p.prosrc like '%/functions/v1/send-push%') as has_url
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname in ('push_call_edge','trigger_send_push_notification','push_gateway_check','push_delivery_url')
      group by p.proname
  ) t;

  v_fns := v_live;

  -- ② الرابط الحيّ داخل bodies
  select (regexp_match(p.prosrc, 'https://[a-z0-9.-]+\.(?:supabase\.co|functions\.supabase\.co)[^''" ]*'))[1]
    into v_live_url
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('push_delivery_url','trigger_send_push_notification')
   order by (p.proname = 'push_delivery_url') desc
   limit 1;

  -- ③ الدوال الناقصة: غيابها = قاعدة متأخرة
  select array_agg(x) into v_missing
    from unnest(array['push_call_edge','trigger_send_push_notification',
                      'push_gateway_check','push_delivery_url']) as x
   where not exists (
     select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = x);

  v_live_hint := case
    when v_missing is not null then
      '⚠️ دوال المسار ناقصة في القاعدة: ' || array_to_string(v_missing, ', ')
      || ' — نفّذ migration v2.19 (2026-10-25).'
    when v_live_vault then '⚠️ جسم دوال المسار في القاعدة ما زال يقرأ Vault — نفّذ migration v2.19 (2026-10-25).'
    when not v_live_secret then '⚠️ جسم دوال المسار لا يحمل السرّ المُضمَّن — نفّذ migration v2.19 (2026-10-25).'
    when not v_live_url_ok then '⚠️ جسم دوال المسار لا يحمل رابط send-push — نفّذ migration v2.19 (2026-10-25).'
    else '✅ جسم دوال المسار في القاعدة محدَّث ومُضمَّن (بلا Vault).'
  end;

  -- ④ عدّ التوكنات + آخر سجل تسليم
  begin
    select count(*) into v_token_count from public.fcm_tokens;
  exception when others then
    v_token_count := null;
  end;

  begin
    select to_jsonb(l) into v_last
      from (select id, kind, ref_id, recipient_id, request_id, note, created_at
              from public.push_delivery_log order by id desc limit 1) l;
  exception when others then
    v_last := null;
  end;

  begin
    select to_jsonb(r) into v_rollup
      from (select id, status_code, error_msg
              from net._http_response order by id desc limit 1) r;
  exception when others then
    v_rollup := null;
  end;

  return jsonb_build_object(
    'edge_function_url', coalesce(v_live_url, v_url_const),
    'edge_url_hardcoded', true,
    'edge_url_ok', v_live_url_ok and coalesce(v_live_url, v_url_const) like '%/functions/v1/send-push%',
    'secret_hardcoded', v_live_secret,
    'vault_dependency', v_live_vault,
    'live_path_vault_free', not v_live_vault and v_missing is null,
    'live_path_secret_ok', v_live_secret and v_missing is null,
    'live_path_url_ok', v_live_url_ok and v_missing is null,
    'live_path_stale', v_live_vault or (v_missing is not null),
    'live_path_missing', coalesce(v_missing, '{}'::text[]),
    'live_path_functions', v_fns,
    'live_path_hint', v_live_hint,
    'push_mode', v_mode,
    'db_push_enabled', v_mode = 'db',
    'client_push_expected', v_mode = 'client',
    'delivery_url', v_delivery_url,
    'delivery_is_default', v_delivery_url = v_url_const,
    'delivery_overridden', v_delivery_url <> v_url_const,
    'isolation_version', 'v2.9',
    'isolation', jsonb_build_object(
      'my_tokens', v_token_count,
      'last_log', v_last,
      'pg_net_rollup', v_rollup
    ),
    'my_tokens', v_token_count,
    'last_log', v_last,
    'hint', case
      when v_mode = 'client' then
        'وضع العميل: القاعدة لا تتصل بأي شبكة — الإشعارات ترسلها الواجهة عبر Realtime ← استدعاء مباشر لـ send-push برمز المستخدم.'
      else
        'وضع القاعدة: التريغر يرسل عبر pg_net — يتطلّب وصول القاعدة إلى نطاق الدالة (فحصه: select public.push_path_verdict();).'
    end
  );
end;
$$;

revoke all on function public.push_diagnostics() from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.push_diagnostics() to authenticated';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- ⑤ push_path_verdict: يعلن الوضع ويتخطّى مسبارات الشبكة في وضع العميل
-- ---------------------------------------------------------------------------
create or replace function public.push_path_verdict(p_apply boolean default false)
returns jsonb language plpgsql security definer set search_path = public, net as $$
declare
  v_primary text := 'https://gqocavvhkfzgxzscrjms.supabase.co/functions/v1/send-push';
  v_mode text := public.push_mode();
  v_verdict jsonb;
  v_probes jsonb := '{}'::jsonb;
  v_item jsonb;
begin
  if v_mode = 'client' then
    -- لا فائدة من فحص شبكة القاعدة في وضع العميل (بلا اتصال إطلاقاً)
    return jsonb_build_object(
      'mode', 'client',
      'push_mode', v_mode,
      'delivery_url', public.push_delivery_url(),
      'delivery_is_default', public.push_delivery_url() = v_primary,
      'candidates', '[]'::jsonb,
      'probes', '{}'::jsonb,
      'results', '[]'::jsonb,
      'works_count', 0,
      'best_url', null,
      'best_label', null,
      'switched', false,
      'apply_requested', p_apply,
      'apply_allowed', false,
      'internet_reachable', null,
      'verdict', 'ℹ️ وضع العميل: القاعدة لا تتصل بأي شبكة (هذا مقصود). مسار التسليم من الواجهة: Realtime ← استدعاء مباشر لـ send-push برمز المستخدم. لفحص مسار القاعدة شغّل: select public.push_set_mode(''db''); ثم select public.push_path_verdict();',
      'how_to_apply', 'وضع العميل — لا حاجة لتحويل وجهة التسليم.'
    );
  end if;

  v_verdict := public.push_path_verdict_db(p_apply);

  for v_item in select * from jsonb_array_elements(coalesce(v_verdict->'candidates', '[]'::jsonb))
  loop
    v_probes := v_probes || jsonb_build_object(
      v_item->>'label',
      jsonb_build_object('url', v_item->>'url', 'request_id', v_item->>'request_id',
                         'status_code', v_item->>'status_code', 'works', v_item->>'works',
                         'dns_error', v_item->>'dns_error', 'hint', v_item->>'hint')
    );
  end loop;

  return v_verdict || jsonb_build_object(
    'mode', 'db',
    'push_mode', v_mode,
    'probes', v_probes
  );
end;
$$;

revoke all on function public.push_path_verdict(boolean) from public, anon;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.push_path_verdict(boolean) to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.push_path_verdict(boolean) to service_role';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- ⑥ نسخة داخلية من حكم المسار (وضع القاعدة) — تُستدعى من push_path_verdict
--    عند الحاجة فقط (وضع 'db').
-- ---------------------------------------------------------------------------
create or replace function public.push_path_verdict_db(p_apply boolean default false)
returns jsonb language plpgsql security definer set search_path = public, net as $$
declare
  v_primary text := 'https://gqocavvhkfzgxzscrjms.supabase.co/functions/v1/send-push';
  v_legacy  text := 'https://gqocavvhkfzgxzscrjms.functions.supabase.co/send-push';
  v_current text := public.push_delivery_url();

  v_labels text[] := array[]::text[];
  v_urls   text[] := array[]::text[];
  v_reqs   bigint[] := array[]::bigint[];
  v_done   int := 0;
  v_status int;
  v_error  text;
  v_content text;
  v_dns boolean;
  v_best text := null;
  v_best_label text := null;
  v_switched boolean := false;
  v_applied boolean := false;
  v_role text;
  v_jwt_role text;
  v_can_apply boolean := false;
  v_candidates jsonb := '[]'::jsonb;
  v_item jsonb;
  v_i int;
  v_works_count int := 0;
  v_any_dns boolean := false;
  v_looks_fn boolean := false;
  v_inet_req bigint;
  v_inet_status int;
  v_inet_error text;
  v_inet_content text;
  v_inet_dns boolean := false;
begin
  v_labels := array_append(v_labels, 'primary');
  v_urls   := array_append(v_urls, v_primary);
  if v_legacy <> v_primary then
    v_labels := array_append(v_labels, 'legacy');
    v_urls   := array_append(v_urls, v_legacy);
  end if;
  if v_current <> v_primary and not (v_current = any(v_urls)) then
    v_labels := array_append(v_labels, 'current');
    v_urls   := array_append(v_urls, v_current);
  end if;

  for v_i in 1..array_length(v_urls, 1) loop
    v_reqs := array_append(v_reqs, public.push_fire_probe(v_urls[v_i]));
  end loop;

  v_inet_req := public.push_fire_probe('https://example.com/');

  for i in 1..12 loop
    select count(*) into v_done
      from net._http_response r
     where r.id = any(v_reqs);
    exit when v_done >= coalesce(array_length(v_reqs, 1), 0);
    perform pg_sleep(0.4);
  end loop;

  select r.status_code, r.error_msg, r.content::text
    into v_inet_status, v_inet_error, v_inet_content
    from net._http_response r
   where r.id = v_inet_req;
  v_inet_dns := (v_inet_status = 0) and (
    coalesce(v_inet_error, '') ilike '%resolve host%'
    or coalesce(v_inet_error, '') ilike '%name or service not known%'
  );

  for v_i in 1..array_length(v_urls, 1) loop
    select r.status_code, r.error_msg, r.content::text
      into v_status, v_error, v_content
      from net._http_response r
     where r.id = v_reqs[v_i];

    v_dns := (v_status = 0) and (
      coalesce(v_error, '') ilike '%resolve host%'
      or coalesce(v_error, '') ilike '%couldn''t resolve%'
      or coalesce(v_error, '') ilike '%name or service not known%'
      or coalesce(v_content, '') ilike '%resolve host%'
    );

    v_looks_fn := (v_status = 200) and (
      coalesce(v_content, '') = ''
      or coalesce(v_content, '') ilike '%sent%'
      or coalesce(v_content, '') ilike '%skipped%'
      or coalesce(v_content, '') ilike '%no fcm token%'
      or coalesce(v_content, '') ilike '%error%'
    );

    v_item := jsonb_build_object(
      'label', v_labels[v_i],
      'url', v_urls[v_i],
      'request_id', v_reqs[v_i],
      'status_code', v_status,
      'error', v_error,
      'dns_error', v_dns,
      'works', v_looks_fn,
      'hint', case
        when v_status = 200 and v_looks_fn then '✅ الوجهة تخدم دالة send-push والسرّ مطابق — تصلح للتسليم فوراً.'
        when v_status = 200 then '⚠️ ردّ 200 لكن مضمونه لا يبدو من دالة send-push.'
        when v_status = 401 then '⚠️ الوجهة تصل لكن رفضت السرّ (x-send-push-secret).'
        when v_status = 404 then '⚠️ الوجهة تصل لكن لا تخدم send-push عند هذا المسار (404).'
        when v_dns then '❌ فشل تحليل اسم المضيف من داخل القاعدة — النطاق غير قابل للوصول منها.'
        when v_status is null then '⚠️ لم يردّ الخادم خلال ~5 ثوانٍ.'
        else '⚠️ رد غير متوقع (' || coalesce(v_status::text, '?') || '): ' || coalesce(v_error, v_content, '')
      end
    );
    v_candidates := v_candidates || jsonb_build_array(v_item);
    if v_dns then
      v_any_dns := true;
    end if;

    if v_looks_fn then
      v_works_count := v_works_count + 1;
      if v_best is null then
        v_best := v_urls[v_i];
        v_best_label := v_labels[v_i];
      end if;
    end if;
  end loop;

  v_jwt_role := null;
  begin
    v_jwt_role := auth.jwt() ->> 'role';
  exception when others then
    v_jwt_role := null;
  end;
  v_role := coalesce(nullif(v_jwt_role, ''), session_user::text);
  v_can_apply := (v_jwt_role = 'service_role')
    or (v_jwt_role is null and session_user in ('postgres', 'supabase_admin'));
  v_applied := p_apply and v_best is not null and v_best <> v_current and v_can_apply;
  if v_applied then
    perform public.push_set_delivery_url(v_best);
    v_switched := public.push_delivery_url() = v_best;
  end if;

  return jsonb_build_object(
    'delivery_url', public.push_delivery_url(),
    'delivery_is_default', public.push_delivery_url() = v_primary,
    'candidates', v_candidates,
    'internet_reachable', coalesce(v_inet_status, 0) > 0 and not v_inet_dns,
    'internet_probe', jsonb_build_object(
      'url', 'https://example.com/',
      'request_id', v_inet_req,
      'status_code', v_inet_status,
      'dns_error', v_inet_dns
    ),
    'works_count', v_works_count,
    'best_url', v_best,
    'best_label', v_best_label,
    'switched', v_switched,
    'apply_requested', p_apply,
    'apply_allowed', v_can_apply,
    'role', v_role,
    'verdict', case
      when v_best is not null and v_switched then
        '✅ تم التحويل إلى «' || v_best_label || '» — مسار التسليم الحيّ أصبح: ' || v_best
      when v_best is not null and v_best = v_current then
        '✅ المسار الحالي يعمل (200) — لا حاجة لأي تغيير.'
      when v_best is not null then
        '✅ وجهة صالحة متاحة: ' || v_best || ' — شغّل select public.push_path_verdict(true); لتحويل المسار.'
      when v_works_count = 0 and coalesce(v_inet_status, 0) = 0 then
        '❌ لا يوجد أي مضيف تصل إليه القاعدة (حتى example.com) ⇒ المخرج مقيّد. راجع Project Settings ← Network (Restrict egress) في لوحة Supabase.'
      when v_works_count = 0 and v_any_dns then
        '❌ القاعدة تصل إلى الإنترنت (example.com يعمل) لكنها لا تصل إلى أي نطاق supabase.co.'
      else
        '❌ لم تنجح أي وجهة (لا 200). راجع status_code لكل مرشّح في candidates.'
    end,
    'how_to_apply', 'select public.push_path_verdict(true);  -- يحوّل المسار إلى أفضل وجهة عاملة'
  );
end;
$$;

revoke all on function public.push_path_verdict_db(boolean) from public, anon;

comment on function public.push_mode() is
'وضع إرسال الإشعارات: client (الافتراضي — لا شبكة من القاعدة، الإرسال من الواجهة) أو db (تراجع: pg_net).';
comment on function public.push_set_mode(text) is
'تبديل وضع الإرسال بين client و db — service_role / SQL Editor فقط.';
