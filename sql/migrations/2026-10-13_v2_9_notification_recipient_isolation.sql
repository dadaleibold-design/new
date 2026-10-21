-- ============================================================
-- Migration v2.9 — 2026-10-13
-- الوضع الصامت للمشرف العام + وضع المراقبة للقراءة فقط
-- ============================================================
--
-- 🔁 v3.0 (2026-10-26): منطق عزل مستلمي الإشعارات (push_recipient_allowed,
--    notify_new_message, notify_call_room, notify_admins_new_profile) أُزيل من
--    القاعدة بالكامل وانتقل إلى دالة send-push (recipients.ts)، لأن الإرسال
--    صار عبر Database Webhooks لا عبر pg_net. ما تبقّى في هذه الهجرة هو ما
--    يخصّ القاعدة فعلاً:
--   ① RLS: المشرف العام يقرأ/يراقب كل المحادثات والرسائل وسجلات المكالمات
--      (Read-only / Admin mode) بلا قيود.
--   ② وضع المراقبة للقراءة فقط: اطلاع المشرف العام على محادثة ليس طرفاً فيها
--      لا يغيّر حالة التسليم/القراءة الخاصة بأصحابها.
--   ③ تقليص صلاحيات تنفيذ الدوال (لا RPC مفتوح للزوار).
--   ④ سياسات الحذف: المشرف العام مراقب فقط ⇒ مستثنى من الحذف.
--
-- آمنة لإعادة التنفيذ (idempotent). نفّذها بعد v2.8.
-- ============================================================

-- ============================================================
-- ① دوال RLS المساعدة
-- ============================================================

-- هل الحساب مشرف عام (is_super_admin)؟
create or replace function public.is_super_admin_user(p_user_id uuid default auth.uid())
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = p_user_id and is_super_admin = true
  );
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    -- سياسات RLS للمشرف العام تُستدعى من العميل ⇒ تحتاج صلاحية تنفيذها
    execute 'grant execute on function public.is_super_admin_user(uuid) to authenticated';
  end if;
end $$;

-- ============================================================
-- ② RLS — المشرف العام: مراقبة كاملة (Read-only / Admin mode)
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
    -- سجل المكالمات المخفي لكل مستخدم: يُضاف للمشرف العام كي لا يفوته سجل كامل
    drop policy if exists "call history hidden superadmin read" on public.call_history_hidden;
    create policy "call history hidden superadmin read" on public.call_history_hidden
      for select using (public.is_super_admin_user());
  exception when others then
    raise notice 'تخطّي سياسة call history hidden superadmin read: %', sqlerrm;
  end;
end $$;

-- ============================================================
-- ③ وضع المراقبة للقراءة فقط (Read-only Observer)
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
-- ④ تقليص صلاحيات تنفيذ الدوال: لا RPC مفتوحاً للزوار
--    PostgreSQL يمنح EXECUTE للجميع افتراضياً، وSupabase يعرض كل دالة
--    عامة كنقطة RPC عبر /rest/v1/rpc. هنا: سحب من public و anon، ثم منح
--    المُصادَق فقط ما تستدعيه الواجهة أو سياسات RLS، وسحب الدوال الداخلية
--    (الحراسة/تنظيف المكالمات) حتى من المُصادَق.
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
        'expire_stale_calls', 'expire_stale_ringing_calls',
        'is_admin_email', 'is_super_admin_email', 'is_internal_phone_email', 'force_admin_presence_online',
        'reset_call_presence',
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
-- ⑤ سياسات الحذف للمشرفين: المشرف العام مراقب فقط ⇒ مستثنى منها.
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
