-- ============================================================
-- Migration v2.3 — تشخيص مسار الإشعارات من قاعدة البيانات (Trigger → pg_net → send-push)
-- يكشف سبب «الإشعار التجريبي يعمل لكن إشعارات الرسائل لا تصل»:
-- عادةً 401 (SEND_PUSH_SECRET في Vault ≠ سر الدالة) أو 404 (رابط خاطئ) أو timeout.
-- ============================================================

-- نتيجة آخر طلبات pg_net الصادرة من الـ Trigger مع حالة HTTP وجسم الرد
create or replace function public.push_diagnostics()
returns jsonb language plpgsql security definer set search_path = public, vault, extensions, net as $$
declare
  v jsonb;
  v_last jsonb;
begin
  begin
    select jsonb_agg(x order by x.id desc) into v_last
    from (
      select l.id, l.kind, l.note, l.request_id, l.created_at,
             r.status_code, left(r.content::text, 300) as response, r.error_msg
      from public.push_delivery_log l
      left join net._http_response r on r.id = l.request_id
      where l.recipient_id = auth.uid() or public.is_admin_user()
      order by l.id desc limit 5
    ) x;
  exception when others then
    select jsonb_agg(x) into v_last from (
      select kind, note, request_id, created_at from public.push_delivery_log
      where recipient_id = auth.uid() or public.is_admin_user() order by id desc limit 5) x;
  end;

  select jsonb_build_object(
    'pg_net_installed', exists (select 1 from pg_extension where extname = 'pg_net'),
    'vault_url', (select decrypted_secret from vault.decrypted_secrets where name = 'SEND_PUSH_URL' limit 1),
    'vault_url_set', exists (select 1 from vault.decrypted_secrets where name = 'SEND_PUSH_URL' and coalesce(decrypted_secret,'') <> ''),
    'vault_secret_set', exists (select 1 from vault.decrypted_secrets where name = 'SEND_PUSH_SECRET' and coalesce(decrypted_secret,'') <> ''),
    'vault_secret_len', (select length(decrypted_secret) from vault.decrypted_secrets where name = 'SEND_PUSH_SECRET' limit 1),
    'trigger_messages', exists (select 1 from pg_trigger where tgname = 'on_message_inserted' and not tgisinternal),
    'trigger_calls', exists (select 1 from pg_trigger where tgname = 'on_call_room_notify' and not tgisinternal),
    'my_tokens', (select count(*) from public.fcm_tokens where user_id = auth.uid()),
    'last_log', v_last
  ) into v;
  return v;
end;
$$;
grant execute on function public.push_diagnostics() to authenticated;

-- اختبار المسار الكامل من قاعدة البيانات: يستدعي send-push بنفس طريقة الـ Trigger
-- (بالسر المشترك) ويرسل إشعاراً تجريبياً للمستخدم الحالي. يعيد request_id.
create or replace function public.push_probe()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_req bigint;
begin
  perform public.push_call_edge('probe', gen_random_uuid(), auth.uid(),
    jsonb_build_object('type', 'probe', 'user_id', auth.uid()));
  select request_id into v_req from public.push_delivery_log
  where kind = 'probe' and recipient_id = auth.uid() order by id desc limit 1;
  return jsonb_build_object('request_id', v_req);
end;
$$;
grant execute on function public.push_probe() to authenticated;

-- قراءة نتيجة طلب pg_net بعينه (بعد ثوانٍ من push_probe)
create or replace function public.push_probe_result(p_request_id bigint)
returns jsonb language plpgsql security definer set search_path = public, net as $$
declare v jsonb;
begin
  select jsonb_build_object('status_code', r.status_code, 'response', left(r.content::text, 500), 'error', r.error_msg)
  into v from net._http_response r where r.id = p_request_id;
  return coalesce(v, jsonb_build_object('pending', true));
end;
$$;
grant execute on function public.push_probe_result(bigint) to authenticated;
