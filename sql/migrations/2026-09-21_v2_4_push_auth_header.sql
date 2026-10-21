-- ============================================================
-- Migration v2.4 — إصلاح 401 "Missing authorization header" من بوابة Supabase
-- البوابة ترفض طلبات pg_net قبل وصولها للدالة إن كان verify_jwt مفعّلاً.
-- الحل (تاريخي): إرسال ترويسة Authorization أيضاً إضافةً إلى x-send-push-secret.
-- منذ v2.15: الرابط والسرّ مُضمَّنان مباشرةً والدالة verify_jwt = false
--   ⇒ لا حاجة لأي مفتاح في Vault ولا لترويسة Authorization.
-- ============================================================
-- ملاحظة (v2.15): مسار التريگرات بلا Vault — الرابط والسرّ مُضمَّنان
--   مباشرةً، والدالة تُنشر بـ verify_jwt = false ⇒ لا مفتاح anon إطلاقاً.

create or replace function public.push_call_edge(p_kind text, p_ref uuid, p_recipient uuid, p_body jsonb)
returns void language plpgsql security definer set search_path = public, net as $$
declare
  v_url text := 'https://gqocavvhkfzgxzscrjms.supabase.co/functions/v1/send-push';
  v_secret text := 'my_send_push_19921121_almgawell_19921121';
  v_headers jsonb;
  v_req bigint;
begin
  -- الرابط والسرّ مُضمَّنان مباشرةً (بلا Vault) — لا ترويسة Authorization:
  --   الدالة منشورة بـ verify_jwt = false ⇒ التحقّق عبر x-send-push-secret
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
