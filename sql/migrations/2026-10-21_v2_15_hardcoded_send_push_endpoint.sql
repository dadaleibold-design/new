-- ============================================================
-- Migration v2.15 (2026-10-21) — تضمين رابط وثابت send-push مباشرة في مسار الـ Triggers
-- ------------------------------------------------------------
-- المشكلة (تقرير): "Couldn't resolve host name" من pg_net.http_post داخل
-- تريگرات messages / call_rooms / profiles. السبب الجذري: قراءة SEND_PUSH_URL
-- و SEND_PUSH_SECRET من vault.decrypted_secrets (أو vault.secrets) تُرجع نصاً
-- مشفّراً (ciphertext) أو تفشل فكّ التشفير (pgsodium session) ⇒ pg_net
-- يستقبل نصاً غير صالح كـ URL ⇒ فشل DNS ("Couldn't resolve host name").
--
-- الحل (v2.15): تضمين الرابط العام والسر المشترك مباشرةً داخل دالة الـ Trigger
-- trigger_send_push_notification() بلا أي قراءة من vault.secrets أو
-- vault.decrypted_secrets:
--   • الرابط ليس سرّاً: https://gqocavvhkfzgxzscrjms.supabase.co/functions/v1/send-push
--     (دالة عامة على البوابة، منشورة بـ verify_jwt = false فلا حاجة لمفتاح JWT).
--   • التحقّق الفعلي في هذا المسار عبر الترويسة x-send-push-secret داخل send-push.
--   • pg_net.http_post غير متزامن: يعيد request_id فوراً والرد يُقرأ لاحقاً من
--     net._http_response ⇒ إدراج الرسالة/المكالمة لا ينتظر الشبكة ولا يتأثر بفكّ Vault.
--
-- ⚠️ SECRET: قيمة x-send-push-secret مُضمَّنة عمداً ومكتوبة أدناه مباشرةً
--    (القيمة المعتمدة: my_send_push_19921121_almgawell_19921121) — يجب أن تطابق تماماً سرّ الدالة
--    SEND_PUSH_SECRET (Edge Function Secrets)، وإلا رُدّت الطلبات بـ 401.
--    لا تُقرأ من Vault إطلاقاً.
--
-- آمنة لإعادة التنفيذ (idempotent): create or replace + تريگرات مُحصّنة.
-- ============================================================

-- ① امتداد pg_net: لازم لـ net.http_post غير المتزامن (محاط بحاجز: بيئات
--    بلا pg_net لا تُفشل الهجرة).
do $$
begin
  begin
    create extension if not exists pg_net;
  exception when others then
    raise notice 'pg_net غير متاح في هذه البيئة (تخطّي): %', sqlerrm;
  end;
end $$;

-- ============================================================
-- ② بوابة الإشعارات في مسار الـ Triggers: رابط وسرّ مُضمَّنان — بلا Vault
--    نفس توقيع push_call_edge ⇒ لا يتأثر أي مستدعٍ (توافق خلفي كامل).
--    البوابة المركزية push_recipient_allowed تعمل قبل أي طلب شبكة (v2.9).
-- ============================================================
create or replace function public.trigger_send_push_notification(
  p_kind text,
  p_ref uuid,
  p_recipient uuid,
  p_body jsonb
)
returns void language plpgsql security definer set search_path = public, net as $$
declare
  -- ⚠️ SECRET — مُضمَّن مباشرةً (بلا Vault). يجب أن يطابق تماماً
  --    SEND_PUSH_SECRET المضبوط على دالة send-push (Edge Function Secrets)،
  --    وإلا رُدّت الطلبات بـ 401.
  v_secret text := 'my_send_push_19921121_almgawell_19921121';
  -- رابط دالة send-push العام على البوابة (مُضمَّن مباشرة — بلا Vault)
  v_url text := 'https://gqocavvhkfzgxzscrjms.supabase.co/functions/v1/send-push';
  v_headers jsonb;
  v_req bigint;
  v_allowed boolean := false;
begin
  -- ⛔ البوابة: لا مستلم مطابق للحدث ⇒ لا طلب شبكة ولا إشعار (يُسجَّل السبب فقط)
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

  -- net.http_post غير متزامن: يُدرج الطلب في net.calls ويعالجه عامل الخلفية،
  -- والرد يُقرأ لاحقاً من net._http_response (بلا انتظار شبكي داخل التريگر).
  begin
    select net.http_post(url := v_url, headers := v_headers, body := p_body, timeout_milliseconds := 8000)
    into v_req;
    insert into public.push_delivery_log(kind, ref_id, recipient_id, request_id)
    values (p_kind, p_ref, p_recipient, v_req);
  exception when others then
    -- لا تُفشل إدراج الرسالة/المكالمة بسبب خطأ في الإشعار
    insert into public.push_delivery_log(kind, ref_id, recipient_id, note)
    values (p_kind, p_ref, p_recipient, 'ERROR: ' || sqlerrm);
  end;
end;
$$;

-- ============================================================
-- ③ توافق خلفي: push_call_edge تفوّض إلى trigger_send_push_notification
--    (notify_new_message / notify_call_room / notify_admins_new_profile /
--    push_probe تستدعي push_call_edge كما هي).
-- ============================================================
create or replace function public.push_call_edge(p_kind text, p_ref uuid, p_recipient uuid, p_body jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.trigger_send_push_notification(p_kind, p_ref, p_recipient, p_body);
end;
$$;

comment on function public.trigger_send_push_notification(text, uuid, uuid, jsonb) is
'مسار إشعارات الـ Triggers: Database Trigger → pg_net.http_post (غير متزامن) → Edge Function send-push (verify_jwt = false، تحقّق عبر x-send-push-secret) → FCM HTTP v1 → Service Worker. الرابط والسر مُضمَّنان مباشرةً في هذه الدالة — بلا قراءة من Vault (إصلاح: "Couldn''t resolve host name" عند فشل فكّ Vault).';

comment on function public.push_call_edge(text, uuid, uuid, jsonb) is
'توافق خلفي: تفوّض إلى public.trigger_send_push_notification بنفس التوقيع.';

-- ============================================================
-- ④ التشخيص: push_diagnostics بدون Vault — يعلن الرابط المُضمَّن وحالة pg_net
--    ومؤشرات العزل (v2.9) كما هي.
-- ============================================================
create or replace function public.push_diagnostics()
returns jsonb language plpgsql security definer set search_path = public, extensions, net as $$
declare
  v jsonb;
  v_last jsonb;
  v_admin_triggers integer := 0;
  v_registered bigint := 0;
  v_skipped bigint := 0;
  v_silenced bigint := 0;
  v_admins bigint := 0;
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

  begin
    select count(*) into v_admin_triggers
    from pg_trigger where tgname = 'on_profile_created_notify_admins' and not tgisinternal;
    select count(*) into v_registered from public.profiles;
    select count(*) into v_skipped from public.push_delivery_log where note like 'SKIPPED%';
    select count(*) into v_silenced from public.push_delivery_log where note like '%مشرف عام%';
    -- قاعدة بلا v2.8: الدالة غير موجودة ⇒ نحسب مباشرة من profiles
    begin
      select count(*) into v_admins from public.admin_recipient_ids();
    exception when others then
      begin
        select count(*) into v_admins from public.profiles
        where (is_admin = true or is_super_admin = true) and is_blocked = false;
      exception when others then
        v_admins := 0;
      end;
    end;
  exception when others then
    v_admin_triggers := 0;
    v_registered := 0;
    v_skipped := 0;
    v_silenced := 0;
    v_admins := 0;
  end;

  select jsonb_build_object(
    'pg_net_installed', exists (select 1 from pg_extension where extname = 'pg_net'),
    -- v2.15: الرابط مُضمَّن مباشرة في trigger_send_push_notification — بلا Vault
    'edge_function_url', 'https://gqocavvhkfzgxzscrjms.supabase.co/functions/v1/send-push',
    'edge_url_hardcoded', true,
    'edge_url_ok', 'https://gqocavvhkfzgxzscrjms.supabase.co/functions/v1/send-push' like '%/functions/v1/send-push%',
    'secret_hardcoded', true,
    'vault_dependency', false,
    'trigger_messages', exists (select 1 from pg_trigger where tgname = 'on_message_inserted' and not tgisinternal),
    'trigger_calls', exists (select 1 from pg_trigger where tgname = 'on_call_room_notify' and not tgisinternal),
    'trigger_new_user', v_admin_triggers > 0,
    'admins_count', v_admins,
    'registered_users', v_registered,
    'directory_rpc', exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'admin_directory_search'
    ),
    -- مؤشرات العزل (v2.9)
    'isolation_version', 'v2.9',
    'recipient_isolation', jsonb_build_object(
      'new_message', 'conversation-parties-only',
      'incoming_call', 'callee-only',
      'call_ended', 'callee-only',
      'bulk', 'new_user-only',
      'super_admin_silent', true
    ),
    'isolation_gate', exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'push_recipient_allowed'
    ),
    'skipped_total', v_skipped,
    'super_admin_silenced', v_silenced,
    'my_tokens', (select count(*) from public.fcm_tokens where user_id = auth.uid()),
    'last_log', v_last
  ) into v;
  return v;
end;
$$;

grant execute on function public.push_diagnostics() to authenticated;

-- ============================================================
-- ⑤ push_probe: المسبار يستدعي نفس المسار (push_call_edge → رابط مُضمَّن)
--    ⇒ يعمل بلا Vault. push_probe_result يقرأ رد pg_net من net._http_response.
-- ============================================================
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

-- ============================================================
-- ⑥ تشخيص إعداد البوابة: كل القيم مُضمَّنة — لا Vault ولا كشف أسرار.
-- ============================================================
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

-- ============================================================
-- ⑦ الصلاحيات: trigger_send_push_notification و push_call_edge داخليتان
--    (مسار الـ Triggers فقط) — لا RPC مفتوحاً للمُصادَق أو الزوار.
-- ============================================================
do $$
begin
  revoke all on function public.trigger_send_push_notification(text, uuid, uuid, jsonb) from public;
  revoke all on function public.push_call_edge(text, uuid, uuid, jsonb) from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.trigger_send_push_notification(text, uuid, uuid, jsonb) from anon';
    execute 'revoke all on function public.push_call_edge(text, uuid, uuid, jsonb) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.trigger_send_push_notification(text, uuid, uuid, jsonb) from authenticated';
    execute 'revoke all on function public.push_call_edge(text, uuid, uuid, jsonb) from authenticated';
  end if;
exception when others then
  raise notice 'تخطّي سحب صلاحيات الدوال الداخلية: %', sqlerrm;
end $$;

-- ============================================================
-- ⑧ ضمان وجود تريگر الإدراج على messages (يستدعي notify_new_message →
--    push_call_edge → trigger_send_push_notification → pg_net).
-- ============================================================
do $$
begin
  if to_regclass('public.messages') is not null
     and to_regprocedure('public.notify_new_message()') is not null
     and not exists (
       select 1 from pg_trigger
       where tgname = 'on_message_inserted' and tgrelid = to_regclass('public.messages')
         and not tgisinternal
     )
  then
    create trigger on_message_inserted
      after insert on public.messages
      for each row execute procedure public.notify_new_message();
  end if;
end $$;

-- ============================================================
-- ⑨ تحقّق سريع بعد التطبيق (يدوياً من SQL Editor):
--   • الرابط المُضمَّن والحالة:      select public.push_gateway_check();
--   • التشخيص الكامل:                select public.push_diagnostics();
--   • مسبار المسار:                  select public.push_probe();  (بجلسة مستخدم)
--   • نتيجة الطلب بعد ثوانٍ:         select public.push_probe_result(<request_id>);
--   • هل تريگر الرسائل يستدعي pg_net؟ اقرأ آخر صف في push_delivery_log
--     (request_id موجود ⇒ الطلب أُدرج؛ error_msg في net._http_response ⇒ خطأ شبكي).
-- ============================================================
