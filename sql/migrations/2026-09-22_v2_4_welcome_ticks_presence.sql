-- ============================================================
-- Migration v2.4 — 2026-09-22
-- (أ) الرسالة الترحيبية: تُرسل عند أول رسالة *فعلية* من العميل
--     بدل إرسالها لمجرد فتح/إنشاء المحادثة، مع نص ترحيبي جديد يتضمّن
--     التنبيه المطلوب، والإبقاء على الأزرار التفاعلية نفسها دون أي تغيير.
-- (ب) حالة الرسائل (Ticks): دالة ذرّية لتثبيت "تم التسليم" من جهة المستقبِل.
-- (ج) حضور المشرفين: "متصل الآن" ثابت ودائم للمستخدم العادي، ولا تقطعه
--     نبضات الخروج/السكون التي يرسلها متصفح المشرف.
--
-- آمن لإعادة التنفيذ (idempotent).
-- ============================================================

-- (أ) ------------------------------------------------------------------
-- لم نعد نُرسل الترحيب عند إنشاء المحادثة (كان يظهر بمجرد فتح المستخدم
-- لصفحة المشرف دون أن يكتب حرفاً واحداً).
drop trigger if exists on_conversation_created on public.conversations;

-- نفس أسماء الدوال السابقة تُعاد صياغتها — فلا حاجة لتغيير أي شيء في الواجهة.
create or replace function public.send_welcome_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_welcome_text text := 'مرحباً بك! 👋 نحن سعداء بتواصلك معنا.' || chr(10) ||
    '⚠️ تنبيه مهم: التواصل مع العديد من المكاتب قد يعرّضك للحظر، ونرجو الالتزام بالتعليمات وعدم الفوضى مع فريق العمل.' || chr(10) ||
    'كيف يمكننا مساعدتك اليوم؟';
  -- ⚠️ الأزرار التفاعلية الأصلية — بلا أي تغيير
  v_buttons jsonb := '[
    {"label":"الاستفسار عن الخدمات","value":"الاستفسار عن الخدمات"},
    {"label":"الشكاوى والمقترحات","value":"الشكاوى والمقترحات"}
  ]'::jsonb;
  v_conv record;
  v_previous integer := 0;
begin
  -- 1) نعمل على رسائل العميل فقط (الطرف user_id في المحادثة)
  select user_id, admin_id into v_conv
  from public.conversations where id = new.conversation_id;

  -- FOUND أدقّ من اختبار السجل عند عدم وجود المحادثة (وتفادياً لأي اختلاف بين الإصدارات)
  if not found then
    return new;
  end if;

  if new.sender_id is distinct from v_conv.user_id then
    return new;
  end if;

  -- رسائل المكالمات/الوسائط بلا نص ليست "تفاعلاً مكتوباً"
  if coalesce(new.message_type, 'text') = 'call' then
    return new;
  end if;

  if new.content is null or btrim(new.content) = '' then
    return new;
  end if;

  -- 2) هل هذه أول رسالة فعلية من العميل؟ (نتجاهل الرسالة الحالية ورسائل المكالمات)
  select count(*) into v_previous
  from public.messages m
  where m.conversation_id = new.conversation_id
    and m.sender_id = v_conv.user_id
    and m.id <> new.id
    and coalesce(m.message_type, 'text') <> 'call';

  if v_previous > 0 then
    return new;
  end if;

  -- 3) حارس ضد التكرار (إدراج مُعاد/متزامن): لا ترحيب سابق بالكلمات التفاعلية
  if exists (
    select 1 from public.messages m
    where m.conversation_id = new.conversation_id
      and m.sender_id = v_conv.admin_id
      and m.buttons is not null
  ) then
    return new;
  end if;

  -- 4) أرسل الترحيب من طرف المشرف (نفس سلوك السابق: رسالة من admin_id)
  insert into public.messages (conversation_id, sender_id, content, buttons, status)
  values (new.conversation_id, v_conv.admin_id, v_welcome_text, v_buttons, 'sent');

  update public.conversations
     set last_message = v_welcome_text,
         last_message_at = now()
   where id = new.conversation_id;

  return new;
end;
$$;

-- الاسم الجديد يبدأ بـ on_message_... ليُنفَّذ قبل on_message_keyword_autoreply
-- (Postgres يشغّل المُشغِّلات أبجدياً) فيصل الترحيب أولاً ثم الرد السياقي.
drop trigger if exists on_message_first_welcome on public.messages;
create trigger on_message_first_welcome
  after insert on public.messages
  for each row execute procedure public.send_welcome_message();

-- (ب) ------------------------------------------------------------------
-- "تم التسليم": يثبّتها جهاز المستقبِل عند وصول الرسالة إليه فعلاً
-- (Realtime أو مزامنة العودة أو وصول الإشعار). المسار الثاني لها هو
-- Edge Function send-push بعد نجاح إرسال الإشعار — فيظهر ✓✓ حتى لو كان
-- تطبيق المستقبِل مغلقاً تماماً.
create or replace function public.mark_messages_delivered(p_conversation_id uuid)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
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

-- نفس المنطق لكن لكل محادثاتي دفعة واحدة: تُستدعى عند عودة التطبيق بعد
-- انقطاع/سكون، فتُصحَّح كل العلامات المعلّقة مرة واحدة (طلب واحد خفيف).
create or replace function public.mark_all_messages_delivered()
returns integer
language plpgsql
security invoker
set search_path = public
as $$
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

-- (ج) ------------------------------------------------------------------
-- حضور المشرف: يُثبَّت "متصل الآن" في قاعدة البيانات أيضاً (لا في الواجهة فقط)
-- حتى تظهر الحالة نفسها لأي واجهة/جهاز، ولا يقطعها تحديث آخر ظهور أو
-- نبضة خروج يرسلها متصفح المشرف عند إخفاء التطبيق.
create or replace function public.protect_profile_privileges()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- (1)حضور المشرف ثابت: يُقفل على is_online = true دائماً
  if coalesce(new.is_admin, old.is_admin, false)
     or public.is_admin_email(coalesce(old.email, new.email)) then
    new.is_online := true;
    new.last_seen := coalesce(new.last_seen, now());
  end if;

  -- الأدوار الخدمية (service_role) والمشرف العام مستثناة من قيود الهوية
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

-- حماية مباشرة: أي محاولة لإظهار مشرف كغير متصل تُصحَّح فوراً
create or replace function public.force_admin_presence_online()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
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

-- الحظر الإداري: لا يُسقط حضور المشرف (وأصلاً لا يُسمح بحظر حساب مشرف)
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
grant execute on function public.admin_set_user_blocked(uuid, boolean) to authenticated;

-- تصحيح فوري للحالة القائمة: كل مشرف يظهر متصلاً الآن
update public.profiles p
   set is_online = true,
       last_seen = coalesce(p.last_seen, now())
 where p.is_admin = true
    or public.is_admin_email(p.email);

-- (د) ------------------------------------------------------------------
-- إثراء دالة التشخيص بحالة الرسائل وحضور المشرفين (تُستخدم في شاشة التشخيص)
create or replace function public.push_diagnostics()
returns jsonb
language plpgsql
security definer
set search_path = public, vault, extensions
as $$
declare
  v jsonb;
begin
  select jsonb_build_object(
    'pg_net_installed', exists (select 1 from pg_extension where extname = 'pg_net'),
    'vault_url_set', exists (select 1 from vault.decrypted_secrets where name = 'SEND_PUSH_URL' and coalesce(decrypted_secret,'') <> ''),
    'vault_secret_set', exists (select 1 from vault.decrypted_secrets where name = 'SEND_PUSH_SECRET' and coalesce(decrypted_secret,'') <> ''),
    'trigger_messages', exists (select 1 from pg_trigger where tgname = 'on_message_first_welcome'),
    'trigger_keyword_bot', exists (select 1 from pg_trigger where tgname = 'on_message_keyword_autoreply'),
    'trigger_admin_presence', exists (select 1 from pg_trigger where tgname = 'on_profile_admin_presence'),
    'mark_read_rpc', exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'mark_conversation_read'
    ),
    'mark_delivered_rpc', exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'mark_messages_delivered'
    ),
    'unread_counts_rpc', exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'unread_counts'
    ),
    'my_unread_total', (
      select count(*) from public.messages m
      join public.conversations c on c.id = m.conversation_id
      where (c.user_id = auth.uid() or c.admin_id = auth.uid())
        and m.sender_id <> auth.uid()
        and m.status <> 'read'
    ),
    'my_messages_by_status', (
      select coalesce(jsonb_object_agg(s.status, s.n), '{}'::jsonb)
      from (
        select coalesce(m.status, 'null') as status, count(*) as n
        from public.messages m
        join public.conversations c on c.id = m.conversation_id
        where (c.user_id = auth.uid() or c.admin_id = auth.uid())
          and m.sender_id = auth.uid()
        group by 1
      ) s
    ),
    'my_tokens', (select count(*) from public.fcm_tokens where user_id = auth.uid())
  ) into v;
  return v;
end;
$$;
grant execute on function public.push_diagnostics() to authenticated;
