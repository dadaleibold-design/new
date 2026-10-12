-- ============================================================
-- Migration v2.5 — 2026-10-12
-- تثبيت Supabase Realtime (postgres_changes) على مستوى قاعدة البيانات.
--
-- لماذا؟
--   1) قناة `inbox-updates` تستمع إلى `conversations`، وكانت الجداول
--      المنشورة في supabase_realtime لا تشمله في بعض النشرات. الاشتراك بجدول
--      غير منشور يُرجع CHANNEL_ERROR دائماً ⇒ حلقة إعادة اشتراك لا تنتهي.
--   2) REPLICA IDENTITY الافتراضي (PK فقط) يعني أن أحداث UPDATE/DELETE لا تحمل
--      الأعمدة غير المفتاحية في `old`. فالفلاتر على conversation_id وحذف
--      التفاعلات (message_reactions.message_id) لا تصل للعميل بقيم صحيحة.
--   3) كل الإجراءات idempotent: آمنة لإعادة التنفيذ.
--
-- ⚠️ ملاحظة أمنية (مُعلنة، لا تُغيَّر هنا): مع REPLICA IDENTITY FULL على
--    messages تُبَثّ حمولة الرسالة المحذوفة كاملة لكل مشترك في الجدول، لأن
--    Realtime لا يطبّق RLS على أحداث DELETE. الحل الجذري هو بث الحذف عبر
--    قناة خاصة بالمحادثة (Broadcast من trigger) — راجع التقرير.
-- ============================================================

-- (1) نشر الجداول التي يشترك فيها العميل ------------------------------
do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'messages', 'typing_status', 'message_reactions', 'conversations',
    'profiles', 'call_rooms'
  ] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = v_table
    ) then
      execute format('alter publication supabase_realtime add table public.%I', v_table);
    end if;
  end loop;
end
$$;

-- (2) REPLICA IDENTITY FULL حيث تحتاج الفلاتر/الحذف قيمَ الصف القديم -----
alter table public.messages           replica identity full;
alter table public.typing_status      replica identity full;
alter table public.message_reactions  replica identity full;
alter table public.conversations      replica identity full;
alter table public.call_rooms         replica identity full;

-- (3) فهارس تخدم فلاتر Realtime (conversation_id) وتقلّل فحص RLS لكل مشترك
create index if not exists idx_messages_conversation_created
  on public.messages(conversation_id, created_at);
create index if not exists idx_typing_status_conversation
  on public.typing_status(conversation_id);
create index if not exists idx_message_reactions_message
  on public.message_reactions(message_id);

-- (4) تشخيص سريع: هل كل الجداول المطلوبة منشورة بهوية صحيحة؟ ---------
-- يُستخدم من الإعدادات/الاختبار اليدوي (يُرجع صفاً لكل جدول).
create or replace function public.realtime_publication_health()
returns table (table_name text, published boolean, replica_identity text)
language sql
stable
security invoker
set search_path = public
as $$
  select t.table_name::text,
         exists (
           select 1 from pg_publication_tables p
           where p.pubname = 'supabase_realtime'
             and p.schemaname = 'public'
             and p.tablename = t.table_name
         ) as published,
         case c.relreplident
           when 'f' then 'full'
           when 'd' then 'default'
           when 'n' then 'nothing'
           when 'i' then 'index'
           else c.relreplident::text
         end as replica_identity
  from (values ('messages'), ('typing_status'), ('message_reactions'),
               ('conversations'), ('profiles'), ('call_rooms')) as t(table_name)
  join pg_class c on c.relname = t.table_name
  join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public';
$$;

grant execute on function public.realtime_publication_health() to authenticated;
