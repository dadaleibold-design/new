-- v2.14 — دعم مفاتيح Supabase الجديدة في مسار pg_net -> send-push.
-- المفاتيح sb_publishable_* ليست JWT ولا يجوز وضعها في Authorization: Bearer.
-- تُرسل في apikey فقط؛ تبقى مصادقة هذا المسار الفعلية عبر x-send-push-secret.

create or replace function public.push_call_edge(p_kind text, p_ref uuid, p_recipient uuid, p_body jsonb)
returns void language plpgsql security definer set search_path = public, vault, net as $$
declare
  v_url text;
  v_secret text;
  v_api_key text;
  v_headers jsonb;
  v_req bigint;
  v_allowed boolean := false;
  v_is_jwt boolean := false;
begin
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

  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'SEND_PUSH_URL' limit 1;
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'SEND_PUSH_SECRET' limit 1;
  select decrypted_secret into v_api_key from vault.decrypted_secrets where name = 'SUPABASE_ANON_KEY' limit 1;
  if coalesce(v_api_key, '') = '' then
    select decrypted_secret into v_api_key from vault.decrypted_secrets where name = 'SUPABASE_SERVICE_ROLE_KEY' limit 1;
  end if;

  v_is_jwt := coalesce(v_api_key, '') ~ '^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$';
  if coalesce(v_api_key, '') = '' or not (
    v_is_jwt or v_api_key ~ '^sb_(publishable|secret)_[A-Za-z0-9_-]+$'
  ) then
    insert into public.push_delivery_log(kind, ref_id, recipient_id, note)
    values (p_kind, p_ref, p_recipient, 'SKIPPED: Supabase API key غير صالح أو غير مضبوط في Vault');
    return;
  end if;

  if coalesce(v_url, '') = '' or coalesce(v_secret, '') = '' then
    insert into public.push_delivery_log(kind, ref_id, recipient_id, note)
    values (p_kind, p_ref, p_recipient, 'SKIPPED: SEND_PUSH_URL/SEND_PUSH_SECRET غير مضبوطين في Vault');
    return;
  end if;

  v_headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-send-push-secret', v_secret,
    'apikey', v_api_key
  );
  -- لا تمرر sb_publishable_* كـ Bearer: ليس JWT وسيؤدي إلى فشل التحقق.
  if v_is_jwt then
    v_headers := v_headers || jsonb_build_object('Authorization', 'Bearer ' || v_api_key);
  end if;

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

comment on function public.push_call_edge(text, uuid, uuid, jsonb) is
'بوابة الإشعارات: Database Trigger → pg_net → Edge Function send-push (عزل/تحقق) → FCM HTTP v1 مباشرة. يدعم Vault SUPABASE_ANON_KEY بصيغة JWT القديمة أو sb_publishable_* الجديدة.';


-- تشخيص إعداد Vault يقبل صيغ مفاتيح Supabase القديمة والجديدة.
create or replace function public.push_gateway_check()
returns jsonb language plpgsql security definer set search_path = public, vault as $$
declare
  v_url text;
  v_secret_set boolean;
  v_auth_set boolean;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'SEND_PUSH_URL' limit 1;
  select exists (select 1 from vault.decrypted_secrets where name = 'SEND_PUSH_SECRET' and coalesce(decrypted_secret, '') <> '') into v_secret_set;
  select exists (
    select 1 from vault.decrypted_secrets
    where name in ('SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY')
      and (decrypted_secret ~ '^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'
        or decrypted_secret ~ '^sb_(publishable|secret)_[A-Za-z0-9_-]+$')
  ) into v_auth_set;

  return jsonb_build_object(
    'vault_url_set', coalesce(v_url, '') <> '',
    'vault_url_is_edge_function', v_url like '%/functions/v1/send-push%',
    'vault_url_is_worker', coalesce(v_url, '') like '%workers.dev%',
    'vault_url_ok', coalesce(v_url, '') <> '' and v_url like '%/functions/v1/send-push%',
    'vault_secret_set', v_secret_set,
    'auth_key_set', v_auth_set,
    'chain', 'Database Trigger → Edge Function → FCM HTTP v1 → Service Worker',
    'gateway_hint', case
      when coalesce(v_url, '') = '' then '⚠️ Vault SEND_PUSH_URL غير مضبوط.'
      when v_url not like '%/functions/v1/send-push%' then '⚠️ SEND_PUSH_URL يجب أن يشير إلى Edge Function send-push.'
      when not v_secret_set then '⚠️ Vault SEND_PUSH_SECRET غير مضبوط.'
      when not v_auth_set then '⚠️ أضف SUPABASE_ANON_KEY كـ JWT أو sb_publishable_* إلى Vault.'
      else '✅ المسار سليم: Trigger → send-push → FCM HTTP v1 مباشرة.'
    end
  );
end;
$$;
revoke all on function public.push_gateway_check() from public;
grant execute on function public.push_gateway_check() to authenticated;
