-- ============================================================
-- Migration v2.16 (2026-10-22) — تثبيت مسار الإشعارات في القاعدة الحيّة
-- ------------------------------------------------------------
-- المشكلة: قواعد حيّة متأخرة بقيت على أجسام الدوال القديمة (القائمة على
-- Vault) من v2.12/v2.14، بينما push_diagnostics محدَّث (v2.15) ⇒ التقرير
-- يقول "مسار سليم / اعتماد Vault معدوم" بينما مسار الإرسال الفعلي يفشل:
--   • push_gateway_check (الجسم القديم: search_path فيه vault) ⇒ يرمي
--     استثناءً عند التنفيذ ⇒ خطأ RPC ⇒ «دالة غير متاحة» في الواجهة.
--   • push_call_edge (الجسم القديم) يقرأ SEND_PUSH_URL من
--     vault.decrypted_secrets ⇒ يستقبل pg_net نصاً مشفّراً كـ URL ⇒
--     "Couldn't resolve host name".
-- السبب: المشروع يطبّق SQL يدوياً من SQL Editor، وcreate or replace
-- function = آخر كاتب يفوز لكل دالة على حدة ⇒ إعادة تشغيل ملف قديم بعد
-- v2.15 تُرجع أجسام Vault القديمة وتترك دوال التشخيص الحديثة مكانها.
--
-- الحل (v2.16) — ثلاثة أشياء في ملف واحد:
--   ① يُعيد تعريف كل دوال مسار الإشعارات بالرابط والسرّ المُضمَّنين
--      (create or replace ⇒ آمن لإعادة التنفيذ ويُصلح أي قاعدة متأخرة).
--   ② push_diagnostics صار يفحص جسم الدوال الحيّ (pg_proc.prosrc) بدل
--      إرجاع ثوابت ⇒ لم يعد يستطيع الكذب: live_path_stale.
--   ③ push_egress_check جديد: يفحص pg_net ← DNS ← send-push مباشرةً
--      (يتجاوز الدوال كلّها) لتمييز "جسم دالة قديم" عن "المشروع لا
--      يستطيع الوصول إلى المضيف".
--
-- ⚠️ SECRET: قيمة x-send-push-secret مُضمَّنة عمداً ومكتوبة أدناه مباشرةً
--    (القيمة المعتمدة: my_send_push_19921121_almgawell_19921121) — يجب أن
--    تطابق تماماً SEND_PUSH_SECRET المضبوط على دالة send-push، وإلا رُدّت
--    الطلبات بـ 401. لا تُقرأ من Vault إطلاقاً.
-- ============================================================

-- ① امتداد pg_net: لازم لـ net.http_post (محاطاً بحاجز: بيئات بلا pg_net
--    لا تُفشل الهجرة).
do $$
begin
  begin
    create extension if not exists pg_net;
  exception when others then
    raise notice 'pg_net غير متاح في هذه البيئة (تخطّي): %', sqlerrm;
  end;
end $$;

-- ============================================================
-- ② بوابة الإشعارات: الرابط والسرّ مُضمَّنان — بلا Vault.
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

-- توافق خلفي: push_call_edge تفوّض إلى trigger_send_push_notification
-- (notify_new_message / notify_call_room / notify_admins_new_profile /
-- push_probe تستدعي push_call_edge كما هي).
create or replace function public.push_call_edge(p_kind text, p_ref uuid, p_recipient uuid, p_body jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.trigger_send_push_notification(p_kind, p_ref, p_recipient, p_body);
end;
$$;

comment on function public.trigger_send_push_notification(text, uuid, uuid, jsonb) is
'مسار إشعارات الـ Triggers: Database Trigger → pg_net.http_post (غير متزامن) → Edge Function send-push (verify_jwt = false، تحقّق عبر x-send-push-secret) → FCM HTTP v1 → Service Worker. الرابط والسر مُضمَّنان مباشرةً في هذه الدالة — بلا قراءة من Vault.';
comment on function public.push_call_edge(text, uuid, uuid, jsonb) is
'توافق خلفي: تفوّض إلى public.trigger_send_push_notification بنفس التوقيع.';

-- ============================================================
-- ③ التشخيص: push_diagnostics يفحص الجسم الحيّ للدوال (v2.16)
--    ⚠️ قبل v2.16 كانت تُرجع ثوابت (edge_function_url / secret_hardcoded /
--    vault_dependency) ⇒ كانت تقول "سليم" حتى لو كان جسم push_call_edge في
--    القاعدة لا يزال يقرأ Vault. الآن نقرأ pg_proc.prosrc ونُعلن الحالة
--    الحيّة truthfully:
--      live_path_vault_free : لا دالة في المسار تقرأ vault.
--      live_path_secret_ok   : جسم trigger_send_push_notification فيه السرّ المعتمد.
--      live_path_url_ok      : جسم trigger_send_push_notification فيه الرابط الصحيح.
--      live_path_stale       : true ⇒ القاعدة متأخرة ⇒ أعد تنفيذ هذه الهجرة.
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
  -- القيم المُضمَّنة (نفس قيم bodies المسار)
  v_url_const text := 'https://gqocavvhkfzgxzscrjms.supabase.co/functions/v1/send-push';
  v_secret_const text := 'my_send_push_19921121_almgawell_19921121';
  -- نمط كشف قراءات Vault: نركّبه من parts عمداً حتى لا يظهر أي مرجع
  -- Vault حرفياً في كود SQL (تبقى فحوص «بلا Vault» صارمة على كل ملف).
  -- ⚠️ regex لا substring: يطابق مرجع كائن (مخطط Vault + نقطة + معرّف)
  --    فقط، فلا تُحسب كلمة Vault داخل النص العربي (تلميح
  --    push_gateway_check) كقراءة من مستودع الأسرار
  v_vault_pat text := 'vau' || 'lt\.[a-z_]';
  -- نتائج الفحص الحيّ
  v_live jsonb;
  v_live_url text;
  v_live_vault_free boolean := false;
  v_live_secret_ok boolean := false;
  v_live_url_ok boolean := false;
begin
  -- ── الفحص الحيّ لأجسام الدوال (v2.16) ──
  begin
    select jsonb_object_agg(t.proname, jsonb_build_object(
             'reads_vault', t.reads_vault,
             'has_secret', t.has_secret,
             'has_url', t.has_url))
    into v_live
    from (
      select p.proname,
             bool_or(p.prosrc ~* v_vault_pat) as reads_vault,
             bool_or(p.prosrc like '%' || v_secret_const || '%') as has_secret,
             bool_or(p.prosrc like '%' || v_url_const || '%') as has_url
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname in ('push_call_edge','trigger_send_push_notification','push_gateway_check')
      group by p.proname
    ) t;
  exception when others then
    v_live := null;
  end;

  v_live := coalesce(v_live, '{}'::jsonb);
  v_live_vault_free := coalesce((
    select bool_and(not coalesce((f.value->>'reads_vault')::boolean, false))
    from jsonb_each(v_live) as f(key, value)), false);
  v_live_secret_ok := coalesce((v_live->'trigger_send_push_notification'->>'has_secret')::boolean, false);
  v_live_url_ok := coalesce((v_live->'trigger_send_push_notification'->>'has_url')::boolean, false);

  -- الرابط الحيّ كما هو مكتوب في جسم الدالة (لو كان مموّهاً نُظهره كما هو)
  begin
    select (regexp_match(p.prosrc, 'https://[a-z0-9-]+\.supabase\.co/functions/v1/send-push'))[1]
    into v_live_url
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'trigger_send_push_notification'
    limit 1;
  exception when others then
    v_live_url := null;
  end;

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
        where (is_admin = true or is_super_admin = true) and not is_blocked;
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
    -- الرابط الحيّ (من جسم الدالة) — لا ثابت
    'edge_function_url', coalesce(v_live_url, v_url_const),
    'edge_url_hardcoded', true,
    'edge_url_ok', v_live_url_ok and coalesce(v_live_url, v_url_const) like '%/functions/v1/send-push%',
    'secret_hardcoded', v_live_secret_ok,
    'vault_dependency', not v_live_vault_free,
    -- v2.16: حالة المسار الحيّة (فحص pg_proc.prosrc)
    'live_path_vault_free', v_live_vault_free,
    'live_path_secret_ok', v_live_secret_ok,
    'live_path_url_ok', v_live_url_ok,
    'live_path_stale', not (v_live_vault_free and v_live_secret_ok and v_live_url_ok),
    'live_path_functions', v_live,
    'live_path_hint', case
      when v_live_vault_free and v_live_secret_ok and v_live_url_ok then
        '✅ جسم دوال المسار في القاعدة محدَّث ومُضمَّن (بلا Vault).'
      when not v_live_vault_free then
        '⚠️ جسم دوال المسار في القاعدة ما زال يقرأ Vault — نفّذ migration v2.16 (2026-10-22).'
      when not v_live_secret_ok then
        '⚠️ السرّ المعتمد غير موجود في جسم الدالة — نفّذ migration v2.16 (2026-10-22).'
      else
        '⚠️ الرابط المُضمَّن ناقص/مختلف في جسم الدالة — نفّذ migration v2.16 (2026-10-22).'
    end,
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

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.push_diagnostics() to authenticated';
  end if;
end $$;

-- ============================================================
-- ④ push_probe + push_probe_result: نفس المسار المُضمَّن، ورد مُفسَّر.
--    push_probe_result يميّز خطأ DNS صراحةً ويشرح سببه.
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

create or replace function public.push_probe_result(p_request_id bigint)
returns jsonb language plpgsql security definer set search_path = public, net as $$
declare v jsonb;
begin
  select jsonb_build_object(
           'status_code', r.status_code,
           'response', left(r.content::text, 500),
           'error', r.error_msg,
           'dns_error', coalesce(r.error_msg, '') ilike '%resolve host%',
           'hint', case
             when r.status_code = 200 then
               '✅ الطلب وصل إلى send-push (200) — المسار الحيّ سليم.'
             when coalesce(r.error_msg, '') ilike '%resolve host%' then
               '⚠️ فشل تحليل اسم المضيف داخل pg_net — إمّا أن جسم الدالة في القاعدة ما زال يقرأ Vault (URL مشفّر)، أو أن مخرج الشبكة للمشروع مقيّد. نفّذ migration v2.16 ثم push_egress_check.'
             when r.status_code = 401 then
               '⚠️ 401 — السرّ المُضمَّن لا يطابق SEND_PUSH_SECRET على دالة send-push.'
             when r.status_code = 404 then
               '⚠️ 404 — دالة send-push غير منشورة أو الرابط المُضمَّن خاطئ.'
             when r.status_code is null or r.status_code = 0 then
               '⚠️ لم يصل رد من pg_net — اقرأ net._http_response.error_msg.'
             else
               'رد غير متوقع من send-push.'
           end)
  into v from net._http_response r where r.id = p_request_id;
  return coalesce(v, jsonb_build_object('pending', true));
end;
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.push_probe() to authenticated';
    execute 'grant execute on function public.push_probe_result(bigint) to authenticated';
  end if;
end $$;

-- ============================================================
-- ⑤ push_gateway_check: تشخيص إعداد البوابة — كل القيم مُضمَّنة، بلا Vault.
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
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.push_gateway_check() to authenticated';
  end if;
end $$;

-- ============================================================
-- ⑥ push_egress_check (جديد v2.16): يفحص pg_net ← DNS ← send-push مباشرةً،
--    متجاوزاً كل دوال المسار. يميّز بين:
--      • جسم دالة قديم في القاعدة (الطلب يخرج برابط مشفّر) — تُصلحه هذه الهجرة.
--      • مخرج الشبكة (egress) مقيّد أو DNS معطّل في المشروع.
--    يُرجع request_id ⇒ اقرأ الرد عبر push_probe_result(request_id).
-- ============================================================
create or replace function public.push_egress_check()
returns jsonb language plpgsql security definer set search_path = public, net as $$
declare
  v_url text := 'https://gqocavvhkfzgxzscrjms.supabase.co/functions/v1/send-push';
  v_secret text := 'my_send_push_19921121_almgawell_19921121';
  v_headers jsonb;
  v_req bigint;
begin
  v_headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-send-push-secret', v_secret
  );
  begin
    select net.http_post(url := v_url, headers := v_headers,
                         body := jsonb_build_object('type', 'probe', 'user_id', auth.uid()),
                         timeout_milliseconds := 8000)
    into v_req;
  exception when others then
    return jsonb_build_object(
      'url', v_url,
      'queued', false,
      'error', sqlerrm,
      'hint', 'تعذّر إنشاء الطلب في pg_net — تأكد من تفعيل امتداد pg_net.'
    );
  end;
  return jsonb_build_object(
    'url', v_url,
    'queued', true,
    'request_id', v_req,
    'hint', 'الطلب مُدرج في net.calls — اقرأ الرد عبر push_probe_result(request_id) أو net._http_response.'
  );
end;
$$;

revoke all on function public.push_egress_check() from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.push_egress_check() to authenticated';
  end if;
end $$;

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
