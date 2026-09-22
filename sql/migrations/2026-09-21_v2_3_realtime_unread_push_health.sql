-- ============================================================
-- Migration v2.3 — 2026-09-21
-- (أ) صحة توكنات FCM: طابع آخر تحقق + مؤشرات تشخيص للنقر
-- (ب) قراءة المحادثة في طلب واحد: mark_conversation_read() تُعيد عدد الرسائل
-- (ج) تنظيف سجل محاولات الإرسال حتى لا ينمو بلا حد
--
-- آمن لإعادة التنفيذ (idempotent).
-- ============================================================

-- (أ) --------------------------------------------------------
alter table public.fcm_tokens
  add column if not exists last_verified_at timestamptz;

alter table public.fcm_tokens
  add column if not exists user_agent text;

-- فهرس يخدم "هل لهذا المستخدم توكن مسجَّل؟" في Edge Function والعميل
create index if not exists idx_fcm_tokens_user_updated
  on public.fcm_tokens(user_id, updated_at desc);

-- (ب) --------------------------------------------------------
-- تصفير عدّاد غير المقروء لمحادثة كاملة في طلب واحد.
-- يعيد عدد الرسائل التي تحوّلت إلى "مقروءة" — تثبيت ذرّي أدق من UPDATE من العميل،
-- ويسمح للواجهة بتأكيد أن التصفير حدث فعلاً (تشخيص فشل RLS/الشبكة).
create or replace function public.mark_conversation_read(p_conversation_id uuid)
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
     set status = 'read'
   where m.conversation_id = p_conversation_id
     and m.sender_id <> auth.uid()
     and (m.status is null or m.status <> 'read');

  get diagnostics v_count = row_count;
  return coalesce(v_count, 0);
end;
$$;

grant execute on function public.mark_conversation_read(uuid) to authenticated;

-- (ج) --------------------------------------------------------
-- سجل الإرسال للتشخيص فقط — احتفظ بآخر 7 أيام
create or replace function public.prune_push_delivery_log(p_keep_days integer default 7)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer := 0;
begin
  delete from public.push_delivery_log
   where created_at < now() - make_interval(days => greatest(1, coalesce(p_keep_days, 7)));
  get diagnostics v_deleted = row_count;
  return coalesce(v_deleted, 0);
end;
$$;

-- (د) --------------------------------------------------------
-- إثراء دالة التشخيص: عمر التوكنات + آخر تسليم + حالة الصف نفسه.
-- تُستخدم من زر "إرسال إشعار تجريبي" في الإعدادات.
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
    'my_tokens_platforms', (
      select coalesce(jsonb_agg(distinct platform), '[]'::jsonb)
      from public.fcm_tokens where user_id = auth.uid()
    ),
    'my_oldest_token_age_minutes', (
      select floor(extract(epoch from (now() - min(updated_at))) / 60)::int
      from public.fcm_tokens where user_id = auth.uid()
    ),
    'unread_counts_rpc', exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'unread_counts'
    ),
    'mark_read_rpc', exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'mark_conversation_read'
    ),
    'last_log', (
      select jsonb_agg(l) from (
        select kind, note, request_id, created_at
        from public.push_delivery_log
        where recipient_id = auth.uid() or public.is_admin_user()
        order by id desc limit 5
      ) l
    )
  ) into v;
  return v;
end;
$$;
grant execute on function public.push_diagnostics() to authenticated;

-- رسائل ثم تذكير: تأكد أن Realtime يبث تحديثات الرسائل (لتصفير العدّادات
-- من أي جهاز آخر) — لا يفشل السكربت إن كانت مضافة مسبقاً.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'messages'
  ) then
    alter publication supabase_realtime add table public.messages;
  end if;
end $$;
