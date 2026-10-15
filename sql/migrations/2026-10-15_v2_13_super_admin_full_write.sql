-- ============================================================
-- Migration v2.13 (2026-10-15) — المشرف العام: كتابة كاملة على المحادثات والرسائل
-- ------------------------------------------------------------
-- يعيد هذا التعديل للمشرف العام (is_super_admin) صلاحية **الكتابة الكاملة** على
-- المحادثات والرسائل (عرض + كتابة + رد) التي كان v2.11 قد قصّرها إلى قراءة فقط،
-- فيستطيع الرد بسلاسة على محادثات المستخدمين مع المشرفين الآخرين بلا أي 403.
--
-- ما تغيّر وما بقي:
--   ✅ conversations / messages / typing_status / message_reactions:
--      قراءة وكتابة كاملة للمشرف العام (FOR ALL).
--   ✅ إشعار ردّ المشرف العام في محادثة ليست طرفاً فيها ⇒ يذهب إلى **المستخدم**
--      صاحب المحادثة (العميل المنتظر للجواب) — لا للمشرف المالك ولا لغيره.
--   ⛔ بقي قراءة فقط (خارج نطاق هذا الطلب عمداً):
--      غرف المكالمات (call_rooms) وسجلاتها، وإدارة المستخدمين
--      (admin_set_user_blocked / admin_delete_user)، وقراءة/تسليم رسائل
--      المحادثات المراقَبة لا يغيّر حالة أصحابها (وضع v2.9 الصامت).
--   ⛔ حماية عدم قابلة الرسائل للعبث (protect_message_immutable_fields) تبقى:
--      صلاحية التحديث لا تعني تغيير محتوى رسالة أرسلها غيره.
--
-- آمنة لإعادة التنفيذ (idempotent): سياسات + دوال فقط، بلا أي تغيير جداول.
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
