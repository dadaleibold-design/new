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

-- خزّن SEND_PUSH_URL و SEND_PUSH_SECRET في Supabase Vault قبل التفعيل.
create or replace function public.notify_new_message()
returns trigger language plpgsql security definer set search_path = public, vault, net as $$
declare
  v_function_url text;
  v_push_secret text;
begin
  select decrypted_secret into v_function_url
  from vault.decrypted_secrets
  where name = 'SEND_PUSH_URL'
  limit 1;
  select decrypted_secret into v_push_secret
  from vault.decrypted_secrets
  where name = 'SEND_PUSH_SECRET'
  limit 1;

  if coalesce(v_function_url, '') = '' or coalesce(v_push_secret, '') = '' then
    raise warning 'send-push secrets are not configured in Supabase Vault';
    return new;
  end if;

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
returns void language plpgsql security definer set search_path = public, vault, net as $$
declare
  v_url text;
  v_secret text;
  v_req bigint;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'SEND_PUSH_URL' limit 1;
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'SEND_PUSH_SECRET' limit 1;

  if coalesce(v_url, '') = '' or coalesce(v_secret, '') = '' then
    insert into public.push_delivery_log(kind, ref_id, recipient_id, note)
    values (p_kind, p_ref, p_recipient, 'SKIPPED: SEND_PUSH_URL/SEND_PUSH_SECRET غير مضبوطين في Vault');
    return;
  end if;

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
returns jsonb language plpgsql security definer set search_path = public, vault, extensions as $$
declare
  v jsonb;
begin
  select jsonb_build_object(
    'pg_net_installed', exists (select 1 from pg_extension where extname = 'pg_net'),
    'vault_url_set', exists (select 1 from vault.decrypted_secrets where name = 'SEND_PUSH_URL' and coalesce(decrypted_secret,'') <> ''),
    'vault_secret_set', exists (select 1 from vault.decrypted_secrets where name = 'SEND_PUSH_SECRET' and coalesce(decrypted_secret,'') <> ''),
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
returns jsonb language plpgsql security definer set search_path = public, vault, extensions, net as $$
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
    'vault_url', (select decrypted_secret from vault.decrypted_secrets where name = 'SEND_PUSH_URL' limit 1),
    'vault_url_set', exists (select 1 from vault.decrypted_secrets where name = 'SEND_PUSH_URL' and coalesce(decrypted_secret,'') <> ''),
    'vault_secret_set', exists (select 1 from vault.decrypted_secrets where name = 'SEND_PUSH_SECRET' and coalesce(decrypted_secret,'') <> ''),
    'vault_secret_len', (select length(decrypted_secret) from vault.decrypted_secrets where name = 'SEND_PUSH_SECRET' limit 1),
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
-- (اختياري لكن موصى به) خزّن مفتاح anon في Vault:
--   select vault.create_secret('<SUPABASE_ANON_KEY>', 'SUPABASE_ANON_KEY');

create or replace function public.push_call_edge(p_kind text, p_ref uuid, p_recipient uuid, p_body jsonb)
returns void language plpgsql security definer set search_path = public, vault, net as $$
declare
  v_url text;
  v_secret text;
  v_auth text;
  v_headers jsonb;
  v_req bigint;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'SEND_PUSH_URL' limit 1;
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'SEND_PUSH_SECRET' limit 1;
  -- ترويسة Authorization: مفتاح anon من Vault إن وُجد، وإلا السر المشترك نفسه
  select decrypted_secret into v_auth from vault.decrypted_secrets where name = 'SUPABASE_ANON_KEY' limit 1;
  if coalesce(v_auth, '') = '' then
    select decrypted_secret into v_auth from vault.decrypted_secrets where name = 'SUPABASE_SERVICE_ROLE_KEY' limit 1;
  end if;
  -- لا مفتاح مكتوب في الكود: بلا JWT صالح في Vault لا يُرسَل أي طلب (fail-closed)
  if coalesce(v_auth, '') = '' or v_auth !~ '^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' then
    insert into public.push_delivery_log(kind, ref_id, recipient_id, note)
    values (p_kind, p_ref, p_recipient, 'SKIPPED: SUPABASE_ANON_KEY غير مضبوط في Vault');
    return;
  end if;

  if coalesce(v_url, '') = '' or coalesce(v_secret, '') = '' then
    insert into public.push_delivery_log(kind, ref_id, recipient_id, note)
    values (p_kind, p_ref, p_recipient, 'SKIPPED: SEND_PUSH_URL/SEND_PUSH_SECRET غير مضبوطين في Vault');
    return;
  end if;

  v_headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-send-push-secret', v_secret,
    'Authorization', 'Bearer ' || v_auth,
    'apikey', v_auth
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
set search_path = public, vault, net
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
returns jsonb language plpgsql security definer set search_path = public, vault, extensions, net as $$
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
    'vault_url', (select decrypted_secret from vault.decrypted_secrets where name = 'SEND_PUSH_URL' limit 1),
    'vault_url_set', exists (select 1 from vault.decrypted_secrets where name = 'SEND_PUSH_URL' and coalesce(decrypted_secret,'') <> ''),
    'vault_secret_set', exists (select 1 from vault.decrypted_secrets where name = 'SEND_PUSH_SECRET' and coalesce(decrypted_secret,'') <> ''),
    'vault_secret_len', (select length(decrypted_secret) from vault.decrypted_secrets where name = 'SEND_PUSH_SECRET' limit 1),
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
returns void language plpgsql security definer set search_path = public, vault, net as $$
declare
  v_url text;
  v_secret text;
  v_auth text;
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

  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'SEND_PUSH_URL' limit 1;
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'SEND_PUSH_SECRET' limit 1;
  -- ترويسة Authorization: مفتاح anon من Vault إن وُجد، وإلا السر المشترك نفسه
  select decrypted_secret into v_auth from vault.decrypted_secrets where name = 'SUPABASE_ANON_KEY' limit 1;
  if coalesce(v_auth, '') = '' then
    select decrypted_secret into v_auth from vault.decrypted_secrets where name = 'SUPABASE_SERVICE_ROLE_KEY' limit 1;
  end if;
  -- لا مفتاح مكتوب في الكود: بلا JWT صالح في Vault لا يُرسَل أي طلب (fail-closed)
  if coalesce(v_auth, '') = '' or v_auth !~ '^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' then
    insert into public.push_delivery_log(kind, ref_id, recipient_id, note)
    values (p_kind, p_ref, p_recipient, 'SKIPPED: SUPABASE_ANON_KEY غير مضبوط في Vault');
    return;
  end if;

  if coalesce(v_url, '') = '' or coalesce(v_secret, '') = '' then
    insert into public.push_delivery_log(kind, ref_id, recipient_id, note)
    values (p_kind, p_ref, p_recipient, 'SKIPPED: SEND_PUSH_URL/SEND_PUSH_SECRET غير مضبوطين في Vault');
    return;
  end if;

  v_headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-send-push-secret', v_secret,
    'Authorization', 'Bearer ' || v_auth,
    'apikey', v_auth
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
set search_path = public, vault, net
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
returns jsonb language plpgsql security definer set search_path = public, vault, extensions, net as $$
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
    'vault_url', (select decrypted_secret from vault.decrypted_secrets where name = 'SEND_PUSH_URL' limit 1),
    'vault_url_set', exists (select 1 from vault.decrypted_secrets where name = 'SEND_PUSH_URL' and coalesce(decrypted_secret,'') <> ''),
    'vault_secret_set', exists (select 1 from vault.decrypted_secrets where name = 'SEND_PUSH_SECRET' and coalesce(decrypted_secret,'') <> ''),
    'vault_secret_len', (select length(decrypted_secret) from vault.decrypted_secrets where name = 'SEND_PUSH_SECRET' limit 1),
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
