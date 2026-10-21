-- ============================================================
-- Migration v2.3 — 2026-09-21
-- (أ) صحة توكنات FCM: طابع آخر تحقق + مؤشرات تشخيص للنقر
-- (ب) قراءة المحادثة في طلب واحد: mark_conversation_read() تُعيد عدد الرسائل
-- (ج) تنظيف سجل تسليم الإشعارات (يكتبه Edge Function) حتى لا ينمو بلا حد
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
-- تأكيد بث Realtime (يستخدمه عدّاد غير المقروء على كل الأجهزة).

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
