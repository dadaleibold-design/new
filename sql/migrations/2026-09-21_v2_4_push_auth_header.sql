-- ============================================================
-- Migration v2.4 — إصلاح 401 "Missing authorization header" من بوابة Supabase
-- البوابة ترفض طلبات pg_net قبل وصولها للدالة إن كان verify_jwt مفعّلاً.
-- الحل: إرسال ترويسة Authorization أيضاً (anon key أو service key من Vault)
-- إضافة إلى x-send-push-secret. يعمل سواء كان verify_jwt مفعّلاً أم لا.
-- ============================================================
-- (اختياري لكن موصى به) خزّن مفتاح anon في Vault:
--   select vault.create_secret('<SUPABASE_ANON_KEY>', 'SUPABASE_ANON_KEY');

create or replace function public.push_call_edge(p_kind text, p_ref uuid, p_recipient uuid, p_body jsonb)
returns void language plpgsql security definer set search_path = public, vault, net as $$
declare
  v_url text;
  v_secret text;
  v_auth text;
  v_headers jsonb;
  v_req bigint;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'SEND_PUSH_URL' limit 1;
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'SEND_PUSH_SECRET' limit 1;
  -- ترويسة Authorization: مفتاح anon من Vault إن وُجد، وإلا السر المشترك نفسه
  select decrypted_secret into v_auth from vault.decrypted_secrets where name = 'SUPABASE_ANON_KEY' limit 1;
  if coalesce(v_auth, '') = '' then
    select decrypted_secret into v_auth from vault.decrypted_secrets where name = 'SUPABASE_SERVICE_ROLE_KEY' limit 1;
  end if;
  if coalesce(v_auth, '') = '' then v_auth := v_secret; end if;

  if coalesce(v_url, '') = '' or coalesce(v_secret, '') = '' then
    insert into public.push_delivery_log(kind, ref_id, recipient_id, note)
    values (p_kind, p_ref, p_recipient, 'SKIPPED: SEND_PUSH_URL/SEND_PUSH_SECRET غير مضبوطين في Vault');
    return;
  end if;

  v_headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-send-push-secret', v_secret,
    'Authorization', 'Bearer ' || v_auth,
    'apikey', v_auth
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
