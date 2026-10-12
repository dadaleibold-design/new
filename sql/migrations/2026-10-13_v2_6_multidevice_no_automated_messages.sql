-- ============================================================
-- Migration v2.6 — 2026-10-13
-- (أ) إلغاء كل الرسائل التلقائية: الترحيب وبوت الكلمات المفتاحية
-- (ب) تسجيل توكنات FCM لكل جهاز بشكل آمن مع تعدد الأجهزة لنفس الحساب
-- ============================================================

-- (أ) إزالة المُشغِّلات والدوال التي تُنشئ رسائل تلقائية
drop trigger if exists on_message_first_welcome on public.messages;
drop trigger if exists on_message_keyword_autoreply on public.messages;
drop trigger if exists on_conversation_created on public.conversations;
drop function if exists public.send_welcome_message();
drop function if exists public.handle_keyword_autoreply();

-- (ب) تسجيل/نقل توكن جهاز إلى المستخدم الحالي
-- المشكلة الأصلية: upsert مع onConflict(token) يُحدّث صفاً يملكه مستخدم آخر
-- (نفس الجهاز بحساب سابق) فتحجبه سياسة RLS بصمت، فلا يُسجَّل الحساب الجديد.
-- هذه الدالة SECURITY DEFINER تنقل التوكن إلى auth.uid() مباشرة.
create or replace function public.register_fcm_token(
  p_token text,
  p_platform text default 'web'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_id uuid;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if coalesce(btrim(p_token), '') = '' then
    raise exception 'token required' using errcode = '22023';
  end if;

  insert into public.fcm_tokens (user_id, token, platform, created_at, updated_at)
  values (v_uid, p_token, coalesce(p_platform, 'web'), now(), now())
  on conflict (token) do update
    set user_id = excluded.user_id,
        platform = excluded.platform,
        updated_at = now()
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.register_fcm_token(text, text) from public;
grant execute on function public.register_fcm_token(text, text) to authenticated;
