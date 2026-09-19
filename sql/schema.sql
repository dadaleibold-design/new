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
  email text unique not null,
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
  created_at timestamptz default now()
);

-- Hardcoded admin list is enforced from the client config (js/config.js)
-- but we also flag it server-side on first insert via trigger below.

create or replace function public.is_admin_email(p_email text)
returns boolean language sql immutable as $$
  select p_email in (
    'aabntlal680@gmail.com',
    'almgawell17@gmail.com',
    'almgawell@gmail.com',
    'almgawell1992@gmail.com',
    'almgawell1121@gmail.com',
    'almgawell1212@gmail.com'
  );
$$;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles (id, email, display_name, is_admin)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email,'@',1)),
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

create policy "push subs select own" on public.push_subscriptions
  for select using (auth.uid() = user_id);
create policy "push subs insert own" on public.push_subscriptions
  for insert with check (auth.uid() = user_id);
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

-- Profiles: everyone authenticated can read (needed for contact lists / names)
create policy "profiles readable by authenticated" on public.profiles
  for select using (auth.role() = 'authenticated');
create policy "profiles updatable by owner" on public.profiles
  for update using (auth.uid() = id);

-- Conversations: only the two participants can see/manage
create policy "conversations select own" on public.conversations
  for select using (auth.uid() = user_id or auth.uid() = admin_id);
create policy "conversations insert own" on public.conversations
  for insert with check (auth.uid() = user_id or auth.uid() = admin_id);
create policy "conversations update own" on public.conversations
  for update using (auth.uid() = user_id or auth.uid() = admin_id);

-- Messages: only participants of the parent conversation
create policy "messages select in own conversation" on public.messages
  for select using (
    exists (select 1 from public.conversations c
            where c.id = conversation_id
            and (c.user_id = auth.uid() or c.admin_id = auth.uid()))
  );
create policy "messages insert in own conversation" on public.messages
  for insert with check (
    sender_id = auth.uid() and
    exists (select 1 from public.conversations c
            where c.id = conversation_id
            and (c.user_id = auth.uid() or c.admin_id = auth.uid()))
  );
create policy "messages update in own conversation" on public.messages
  for update using (
    exists (select 1 from public.conversations c
            where c.id = conversation_id
            and (c.user_id = auth.uid() or c.admin_id = auth.uid()))
  );

-- Reactions
create policy "reactions select in own conversation" on public.message_reactions
  for select using (
    exists (select 1 from public.messages m join public.conversations c on c.id = m.conversation_id
            where m.id = message_id and (c.user_id = auth.uid() or c.admin_id = auth.uid()))
  );
create policy "reactions insert own" on public.message_reactions
  for insert with check (user_id = auth.uid());
create policy "reactions delete own" on public.message_reactions
  for delete using (user_id = auth.uid());

-- Typing status
create policy "typing select in own conversation" on public.typing_status
  for select using (
    exists (select 1 from public.conversations c
            where c.id = conversation_id and (c.user_id = auth.uid() or c.admin_id = auth.uid()))
  );
create policy "typing upsert own" on public.typing_status
  for insert with check (user_id = auth.uid());
create policy "typing update own" on public.typing_status
  for update using (user_id = auth.uid());

-- ------------------------------------------------------------
-- REALTIME: enable replication on the tables the client listens to
-- ------------------------------------------------------------
alter publication supabase_realtime add table public.messages;
alter publication supabase_realtime add table public.typing_status;
alter publication supabase_realtime add table public.profiles;
alter publication supabase_realtime add table public.message_reactions;

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

create policy "avatar upload own" on storage.objects
  for insert with check (bucket_id = 'avatars' and auth.role() = 'authenticated');
create policy "avatar public read" on storage.objects
  for select using (bucket_id = 'avatars');

create policy "attachments upload own" on storage.objects
  for insert with check (bucket_id = 'attachments' and auth.role() = 'authenticated');
create policy "attachments public read" on storage.objects
  for select using (bucket_id = 'attachments');

create policy "wallpapers upload own" on storage.objects
  for insert with check (bucket_id = 'wallpapers' and auth.role() = 'authenticated');
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

-- عدّل القيمتين التاليتين بعد نشر الدالة (Settings > Edge Functions):
--   1. project-ref.functions.supabase.co/send-push  -> رابط دالتك الفعلي
--   2. SERVICE_ROLE_KEY -> مفتاح service_role (Settings > API) — لا تكشفه في الكود الأمامي أبداً
create or replace function public.notify_new_message()
returns trigger language plpgsql security definer as $$
declare
  v_function_url text := 'https://YOUR-PROJECT-REF.functions.supabase.co/send-push';
  v_service_key  text := 'YOUR-SERVICE-ROLE-KEY';
begin
  perform net.http_post(
    url := v_function_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_service_key
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

create policy "fcm tokens select own" on public.fcm_tokens
  for select using (auth.uid() = user_id);
create policy "fcm tokens upsert own" on public.fcm_tokens
  for insert with check (auth.uid() = user_id);
create policy "fcm tokens update own" on public.fcm_tokens
  for update using (auth.uid() = user_id);
create policy "fcm tokens delete own" on public.fcm_tokens
  for delete using (auth.uid() = user_id);

alter publication supabase_realtime add table public.fcm_tokens;

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
  select p_email = 'almgawell17@gmail.com';
$$;

-- 9.2 تحديث trigger التسجيل التلقائي ليضبط is_super_admin (و is_admin ضمنياً)
--     لأي حساب جديد يُنشأ ببريد المشرف العام
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles (id, email, display_name, is_admin, is_super_admin)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email,'@',1)),
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
where email = 'almgawell17@gmail.com';

-- 9.4 سياسات RLS إضافية (Permissive — تُضاف بجانب السياسات الحالية ولا تستبدلها):
--     تمنح المشرف العام قراءة/كتابة كاملة على كل المحادثات والرسائل، بصرف
--     النظر عن كونه طرفاً فيها أصلاً أم لا.
create policy "conversations full access superadmin" on public.conversations
  for all using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_super_admin)
  )
  with check (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_super_admin)
  );

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
