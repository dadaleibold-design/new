-- ============================================================
-- WhatsApp-Clone Chat App — Supabase Schema
-- Run this in Supabase SQL Editor (Project > SQL Editor > New query)
-- ============================================================

-- Extensions
create extension if not exists "uuid-ossp";

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
-- 7. رسالة ترحيبية تلقائية + بوت الردود بالكلمات المفتاحية (أزرار تفاعلية)
-- ------------------------------------------------------------

-- عمود لتخزين الأزرار التفاعلية المرفقة برسالة (مصفوفة JSON: [{label, value}, ...])
alter table public.messages add column if not exists buttons jsonb;

-- 7.1 عند إنشاء أي محادثة جديدة (عميل يبدأ التواصل لأول مرة مع مشرف)
--     تُرسَل تلقائياً رسالة ترحيبية من طرف المشرف تحتوي على زرّين تفاعليين
create or replace function public.send_welcome_message()
returns trigger language plpgsql security definer as $$
declare
  v_welcome_text text := 'مرحباً بك! 👋 نحن سعداء بتواصلك معنا. كيف يمكننا مساعدتك اليوم؟';
  v_buttons jsonb := '[
    {"label":"الاستفسار عن الخدمات","value":"الاستفسار عن الخدمات"},
    {"label":"الشكاوى والمقترحات","value":"الشكاوى والمقترحات"}
  ]'::jsonb;
begin
  insert into public.messages (conversation_id, sender_id, content, buttons, status)
  values (new.id, new.admin_id, v_welcome_text, v_buttons, 'sent');

  update public.conversations
  set last_message = v_welcome_text, last_message_at = now()
  where id = new.id;

  return new;
end;
$$;

drop trigger if exists on_conversation_created on public.conversations;
create trigger on_conversation_created
  after insert on public.conversations
  for each row execute procedure public.send_welcome_message();

-- 7.2 عند وصول رسالة من العميل (سواء بالنقر على أحد الزرين أو كتابة الكلمة يدوياً)
--     يتحقق البوت من تطابق الكلمة المفتاحية ويُرسل رداً تلقائياً فورياً من طرف المشرف
create or replace function public.handle_keyword_autoreply()
returns trigger language plpgsql security definer as $$
declare
  v_conv record;
  v_reply text;
begin
  if new.content is null then
    return new;
  end if;

  select user_id, admin_id into v_conv
  from public.conversations where id = new.conversation_id;

  -- طبّق البوت فقط على رسائل العميل (وليس المشرف) لمنع أي حلقة تكرارية لا نهائية
  if new.sender_id is distinct from v_conv.user_id then
    return new;
  end if;

  if new.content ilike '%الاستفسار عن الخدمات%' then
    v_reply := 'شكراً لتواصلك معنا 🌟 يسعدنا تقديم المعلومات الكاملة عن خدماتنا. سيقوم أحد ممثلينا بالتواصل معك خلال دقائق لمساعدتك بكل التفاصيل.';
  elsif new.content ilike '%الشكاوى%' or new.content ilike '%المقترحات%' then
    v_reply := 'نأسف لأي إزعاج ونقدّر ملاحظاتك 🙏 يرجى كتابة تفاصيل الشكوى أو الاقتراح وسنعمل على معالجته بأسرع وقت ممكن.';
  else
    return new; -- لا توجد كلمة مفتاحية مطابقة، يُترك الرد للمشرف نفسه
  end if;

  insert into public.messages (conversation_id, sender_id, content, status)
  values (new.conversation_id, v_conv.admin_id, v_reply, 'sent');

  update public.conversations
  set last_message = v_reply, last_message_at = now()
  where id = new.conversation_id;

  return new;
end;
$$;

drop trigger if exists on_message_keyword_autoreply on public.messages;
create trigger on_message_keyword_autoreply
  after insert on public.messages
  for each row execute procedure public.handle_keyword_autoreply();

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
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (token)
);

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

-- ============================================================
-- 12. الإصدار v2.1: موثوقية الإشعارات + عدّاد غير المقروء + الترتيب بآخر تفاعل
-- ============================================================
-- (أ) --------------------------------------------------------
create index if not exists idx_fcm_tokens_user on public.fcm_tokens(user_id);

-- سجل محاولات الإرسال لتشخيص "الإشعار لا يصل" من لوحة Supabase مباشرة
create table if not exists public.push_delivery_log (
  id bigserial primary key,
  kind text not null,               -- new_message | incoming_call | call_ended
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
    'my_tokens', (select count(*) from public.fcm_tokens where user_id = auth.uid()),
    'last_log', (select jsonb_agg(l) from (select kind, note, request_id, created_at from public.push_delivery_log where recipient_id = auth.uid() or public.is_admin_user() order by id desc limit 5) l)
  ) into v;
  return v;
end;
$$;
grant execute on function public.push_diagnostics() to authenticated;
