-- ============================================================
-- v2.7 — أجهزة متعددة لكل مستخدم: هوية الجهاز + معلومات الجهاز
--
-- الهدف:
--   1) كل جهاز/متصفح صفّ مستقل في fcm_tokens (علاقة واحد-لكثير) مع device_id
--      ثابت محلياً وdevice_info (المنصة، اللغة، المنطقة، وضع PWA…).
--   2) تدوير التوكن على نفس الجهاز لا يترك صفاً قديماً (وإلا يصل الإشعار مرتين).
--   3) الدالة ترجع الإجراء (inserted | refreshed | moved) للتتبّع في السجلات.
--
-- آمنة للتشغيل أكثر من مرة (idempotent).
-- ============================================================

alter table public.fcm_tokens add column if not exists device_id text;
alter table public.fcm_tokens add column if not exists device_info jsonb not null default '{}'::jsonb;

create index if not exists idx_fcm_tokens_user_device
  on public.fcm_tokens (user_id, device_id);

-- توقيع الدالة تغيّر (معاملات جديدة + نوع الإرجاع): نُسقط القديمة صراحةً
drop function if exists public.register_fcm_token(text, text);

create or replace function public.register_fcm_token(
  p_token text,
  p_platform text default 'web',
  p_device_id text default null,
  p_device_info jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_owner uuid;
  v_action text;
  v_id uuid;
  v_device text := nullif(btrim(coalesce(p_device_id, '')), '');
  v_removed int := 0;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if coalesce(btrim(p_token), '') = '' then
    raise exception 'token required' using errcode = '22023';
  end if;

  -- تحديد الإجراء قبل الكتابة: جديد / تحديث لنفس الحساب / نقل من حساب آخر على الجهاز نفسه
  select user_id into v_owner from public.fcm_tokens where token = p_token;
  v_action := case
    when not found then 'inserted'
    when v_owner = v_uid then 'refreshed'
    else 'moved'
  end;

  -- تدوير التوكن على نفس الجهاز: احذف الصفوف القديمة لهذا الجهاز (لنفس المستخدم فقط)
  if v_device is not null then
    delete from public.fcm_tokens
    where user_id = v_uid
      and device_id = v_device
      and token <> p_token;
    get diagnostics v_removed = row_count;
  end if;

  insert into public.fcm_tokens (user_id, token, platform, device_id, device_info, created_at, updated_at)
  values (
    v_uid,
    p_token,
    coalesce(nullif(p_platform, ''), 'web'),
    v_device,
    coalesce(p_device_info, '{}'::jsonb),
    now(),
    now()
  )
  on conflict (token) do update
    set user_id = excluded.user_id,
        platform = excluded.platform,
        device_id = excluded.device_id,
        device_info = excluded.device_info,
        updated_at = now()
  returning id into v_id;

  return jsonb_build_object(
    'id', v_id,
    'action', v_action,
    'rotated_removed', v_removed
  );
end;
$$;

revoke all on function public.register_fcm_token(text, text, text, jsonb) from public;
grant execute on function public.register_fcm_token(text, text, text, jsonb) to authenticated;
