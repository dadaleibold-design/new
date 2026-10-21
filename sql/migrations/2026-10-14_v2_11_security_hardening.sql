-- ============================================================
-- v2.11 (2026-10-14) — تدقيق الأمان وتشديد RLS
-- ------------------------------------------------------------
-- 1) إزالة مفتاح anon الثابت من push_call_edge (لا مفاتيح في الكود)
--    ولا قراءة من Vault: منذ v2.15 الرابط والسرّ مُضمَّنان مباشرةً، والدالة
--    منشورة بـ verify_jwt = false ⇒ لا حاجة لمفتاح anon ولا لترويسة Authorization.
-- 2) المشرف العام = مراقب للقراءة فقط (لا كتابة على المحادثات/الرسائل/المكالمات)
--    ويُرفض حظر/حذف المستخدمين من حسابه (تتطلب كتابة).
-- 3) تقليص صلاحيات تنفيذ الدوال (لا RPC للزوار، لا دوال داخلية للمستخدمين).
-- 4) إزالة سياسات القراءة العامة من التخزين (منع سرد المرفقات).
-- آمنة لإعادة التنفيذ (idempotent).
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
