-- ============================================================
-- Migration v2.1 — 2026-09-21
-- (أ) فهرس توكنات FCM (يخدم دالة send-push عند تحميل أجهزة المستلم)
-- (ب) عدّاد غير المقروء: فهرس + دالة عدّ سريعة
-- (ج) الترتيب حسب آخر تفاعل: تحديث last_message_at لأي رسالة (Trigger)
-- آمن لإعادة التنفيذ.
-- 🔁 v3.0: أُزيل تريگر الإشعارات ودالة push_call_edge (pg_net) من هذه الهجرة.
-- ============================================================

-- (أ) --------------------------------------------------------
create index if not exists idx_fcm_tokens_user on public.fcm_tokens(user_id);

-- (ب) --------------------------------------------------------
create index if not exists idx_messages_unread_by_conv
  on public.messages(conversation_id, sender_id) where status <> 'read';

create or replace function public.unread_counts(p_conversation_ids uuid[])
returns table(conversation_id uuid, unread bigint)
language sql stable security invoker set search_path = public as $$
  select m.conversation_id, count(*)::bigint
  from public.messages m
  where m.conversation_id = any(p_conversation_ids)
    and m.sender_id <> auth.uid()
    and m.status <> 'read'
  group by m.conversation_id;
$$;
grant execute on function public.unread_counts(uuid[]) to authenticated;

-- (ج) --------------------------------------------------------
-- أي رسالة جديدة (نص/مرفق/مكالمة) تحدّث آخر تفاعل للمحادثة، حتى إن لم يحدّثها العميل
create or replace function public.touch_conversation_on_message()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.conversations
  set last_message = coalesce(new.content, case new.attachment_type when 'image' then '📷 صورة' when 'audio' then '🎤 رسالة صوتية' when 'file' then '📎 ملف' else last_message end),
      last_message_at = greatest(coalesce(last_message_at, new.created_at), new.created_at)
  where id = new.conversation_id;
  return new;
end;
$$;
drop trigger if exists on_call_message_touch_conversation on public.messages;
drop trigger if exists on_message_touch_conversation on public.messages;
create trigger on_message_touch_conversation
  after insert on public.messages
  for each row execute procedure public.touch_conversation_on_message();

-- تأكد أن Realtime يبث تحديثات conversations (لإعادة الترتيب الفوري)
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'conversations') then
    alter publication supabase_realtime add table public.conversations;
  end if;
end $$;
