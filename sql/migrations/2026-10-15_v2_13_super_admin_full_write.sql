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

-- ------------------------------------------------------------
-- ⑥ الحراسة المركزية للإشعارات: السماح بردّ المشرف العام (المستلم = صاحب المحادثة)
-- ------------------------------------------------------------

-- ------------------------------------------------------------
-- ⑦ الصلاحيات: الدالتان داخليتان (Triggers + SECURITY DEFINER فقط)
-- ------------------------------------------------------------
do $$
begin

  if exists (select 1 from pg_roles where rolname = 'anon') then
  end if;

  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.is_super_admin_user(uuid) to authenticated';
  end if;
exception when others then
  raise notice 'تخطّي منح الصلاحيات (بيئة ناقصة الأدوار): %', sqlerrm;
end $$;
