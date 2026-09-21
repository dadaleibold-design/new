-- ============================================================
-- Migration v2.1 — 2026-09-21
-- (أ) موثوقية إشعارات الخلفية: تسجيل الفشل، عدم كسر الإدراج، وفهرس التوكنات
-- (ب) عدّاد غير المقروء: فهرس + دالة عدّ سريعة
-- (ج) الترتيب حسب آخر تفاعل: تحديث last_message_at لأي رسالة (Trigger)
-- آمن لإعادة التنفيذ.
-- ============================================================

-- (أ) --------------------------------------------------------
create index if not exists idx_fcm_tokens_user on public.fcm_tokens(user_id);

-- سجل محاولات الإرسال لتشخيص "الإشعار لا يصل" من لوحة Supabase مباشرة
create table if not exists public.push_delivery_log (
  id bigserial primary key,
  kind text not null,               -- new_message | incoming_call | call_ended
  ref_id uuid,                      -- message_id أو room_id
  recipient_id uuid,
  request_id bigint,                -- معرّف طلب pg_net
  note text,
  created_at timestamptz not null default now()
);
alter table public.push_delivery_log enable row level security;
drop policy if exists "push log superadmin read" on public.push_delivery_log;
create policy "push log superadmin read" on public.push_delivery_log
  for select using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_super_admin));

create or replace function public.push_call_edge(p_kind text, p_ref uuid, p_recipient uuid, p_body jsonb)
returns void language plpgsql security definer set search_path = public, vault, net as $$
declare
  v_url text;
  v_secret text;
  v_req bigint;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'SEND_PUSH_URL' limit 1;
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'SEND_PUSH_SECRET' limit 1;

  if coalesce(v_url, '') = '' or coalesce(v_secret, '') = '' then
    insert into public.push_delivery_log(kind, ref_id, recipient_id, note)
    values (p_kind, p_ref, p_recipient, 'SKIPPED: SEND_PUSH_URL/SEND_PUSH_SECRET غير مضبوطين في Vault');
    return;
  end if;

  begin
    select net.http_post(
      url := v_url,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-send-push-secret', v_secret),
      body := p_body,
      timeout_milliseconds := 8000
    ) into v_req;
    insert into public.push_delivery_log(kind, ref_id, recipient_id, request_id)
    values (p_kind, p_ref, p_recipient, v_req);
  exception when others then
    -- لا تُفشل إدراج الرسالة/المكالمة بسبب خطأ في الإشعار
    insert into public.push_delivery_log(kind, ref_id, recipient_id, note)
    values (p_kind, p_ref, p_recipient, 'ERROR: ' || sqlerrm);
  end;
end;
$$;

create or replace function public.notify_new_message()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_recipient uuid;
begin
  if new.message_type = 'call' then
    return new;
  end if;
  select case when c.user_id = new.sender_id then c.admin_id else c.user_id end
    into v_recipient
  from public.conversations c where c.id = new.conversation_id;

  perform public.push_call_edge(
    'new_message', new.id, v_recipient,
    jsonb_build_object(
      'message_id', new.id,
      'conversation_id', new.conversation_id,
      'sender_id', new.sender_id,
      'content', coalesce(new.content, case new.attachment_type when 'image' then '📷 صورة' when 'audio' then '🎤 رسالة صوتية' else '📎 مرفق' end)
    )
  );
  return new;
end;
$$;
drop trigger if exists on_message_inserted on public.messages;
create trigger on_message_inserted
  after insert on public.messages
  for each row execute procedure public.notify_new_message();

create or replace function public.notify_call_room()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_type text;
begin
  if tg_op = 'INSERT' and new.status = 'ringing' then
    v_type := 'incoming_call';
  elsif tg_op = 'UPDATE' and old.status is distinct from new.status
        and new.status in ('missed', 'ended', 'declined', 'failed', 'network_lost') then
    v_type := 'call_ended';
  else
    return new;
  end if;

  perform public.push_call_edge(
    v_type, new.id, new.callee_id,
    jsonb_build_object(
      'type', v_type,
      'room_id', new.id,
      'conversation_id', new.conversation_id,
      'caller_id', new.caller_id,
      'callee_id', new.callee_id,
      'call_type', new.call_type,
      'status', new.status
    )
  );
  return new;
end;
$$;
drop trigger if exists on_call_room_notify on public.call_rooms;
create trigger on_call_room_notify
  after insert or update on public.call_rooms
  for each row execute procedure public.notify_call_room();

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
