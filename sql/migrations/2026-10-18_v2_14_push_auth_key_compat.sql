-- v2.14 — دعم مفاتيح Supabase الجديدة في مسار pg_net -> send-push.
-- المفاتيح sb_publishable_* ليست JWT ولا يجوز وضعها في Authorization: Bearer.
-- تُرسل في apikey فقط؛ تبقى مصادقة هذا المسار الفعلية عبر x-send-push-secret.

create or replace function public.push_call_edge(p_kind text, p_ref uuid, p_recipient uuid, p_body jsonb)
returns void language plpgsql security definer set search_path = public, net as $$
declare
  v_url text := 'https://gqocavvhkfzgxzscrjms.supabase.co/functions/v1/send-push';
  v_secret text := 'my_send_push_19921121_almgawell_19921121';
  v_headers jsonb;
  v_req bigint;
  v_allowed boolean := false;
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


  v_headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-send-push-secret', v_secret
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

comment on function public.push_call_edge(text, uuid, uuid, jsonb) is
'بوابة الإشعارات: Database Trigger → pg_net → Edge Function send-push (عزل/تحقق) → FCM HTTP v1 مباشرة. منذ v2.15: الرابط والسرّ مُضمَّنان مباشرةً — بلا Vault (صيغة sb_(publishable|secret)_ لم تعد لازمة مع verify_jwt = false).';


-- تشخيص إعداد البوابة: الرابط والسرّ مُضمَّنان مباشرةً (بلا Vault).
create or replace function public.push_gateway_check()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_url text := 'https://gqocavvhkfzgxzscrjms.supabase.co/functions/v1/send-push';
begin
  return jsonb_build_object(
    'url', v_url,
    'url_hardcoded', true,
    'url_is_edge_function', v_url like '%/functions/v1/send-push%',
    'url_is_worker', coalesce(v_url, '') like '%workers.dev%',
    'url_ok', coalesce(v_url, '') like '%/functions/v1/send-push%',
    'secret_hardcoded', true,
    'vault_dependency', false,
    'chain', 'Database Trigger → pg_net (http_post غير متزامن) → Edge Function send-push (رابط وسرّ مُضمَّنان — verify_jwt = false) → FCM HTTP v1 → Service Worker',
    'gateway_hint', case
      when coalesce(v_url, '') like '%workers.dev%' then
        '⚠️ الرابط المُضمَّن يشير إلى الـ Worker مباشرة — يجب أن يشير إلى دالة send-push.'
      when coalesce(v_url, '') = '' then
        '⚠️ الرابط المُضمَّن فارغ — لن تُرسل إشعارات الـ Triggers.'
      when v_url not like '%/functions/v1/send-push%' then
        '⚠️ الرابط المُضمَّن يجب أن يشير إلى Edge Function send-push.'
      else
        '✅ المسار سليم: التريگرات تستدعي send-push برابط وسرّ مُضمَّنين بلا Vault.'
    end
  );
end;
$$;
revoke all on function public.push_gateway_check() from public;
grant execute on function public.push_gateway_check() to authenticated;
