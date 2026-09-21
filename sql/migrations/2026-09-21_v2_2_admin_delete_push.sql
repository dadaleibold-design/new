-- ============================================================
-- Migration v2.2 — 2026-09-21
-- (أ) حذف المستخدم بواسطة أي مشرف (is_admin أو is_super_admin) مع كل بياناته
--     في كل الجداول + ملفات التخزين، بدون أن تعيقه قيود المفاتيح الأجنبية.
-- (ب) دالة فحص جاهزية الإشعارات (لتشخيص «الإشعار لا يصل»).
-- آمن لإعادة التنفيذ. نفّذه بعد v2.1.
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
