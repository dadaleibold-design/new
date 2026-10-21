-- ============================================================
-- Migration v2.17 (2026-10-23) — مسار تسليم قابل للتهيئة + تشخيص شبكة القاعدة
-- ------------------------------------------------------------
-- التشخيص (v2.16 كشفه): أجسام الدوال سليمة ومُضمَّنة، لكن `pg_net` داخل
-- القاعدة يفشل في تحليل اسم المضيف حتى مع الرابط الحرفي الصحيح:
--   error_msg = "Couldn't resolve host name" (status_code = 0، body فارغ).
-- ⇒ المشكلة على مستوى شبكة حاوية القاعدة (DNS/مخرج) لا في الكود.
--
-- ⚠️ لا يوجد نقل بديل داخل القاعدة: supabase_functions.http_request (المُستخدَم
--    في Database Webhooks) هو trigger wrapper حول net.http_post نفسه ⇒ نفس
--    مسار DNS. لذلك الحلّ الجذري هو:
--   ① جعل نقطة التسليم (delivery endpoint) قابلة للتهيئة وقت التشغيل ⇒
--      يمكن توجيه القاعدة إلى بوابة بديلة (مثل Cloudflare Worker) بلا هجرة جديدة.
--   ② تشخيص صريح لشبكة القاعدة: أي مضيفات تصل إليها وأيها لا تصل ⇒ قرار واضح.
--   ③ توثيق مسار بديل جاهز: Worker وسيط يمرّر الطلب إلى دالة send-push.
--
-- 🔒 أمان: تعديل نقطة التسليم يقتصر على service_role / SQL Editor
--    (لا يُعرَض كـ RPC للمستخدمين) — منعاً لتحويل مسار الإرسال إلى مهاجم.
-- ============================================================

-- ============================================================
-- ① جدول إعدادات المسار (صفّ واحد)
--    delivery_url = NULL ⇒ استخدم الرابط المُضمَّن الافتراضي.
-- ============================================================
create table if not exists public.push_settings (
  id boolean primary key default true check (id),
  delivery_url text,
  updated_at timestamptz not null default now()
);
comment on table public.push_settings is
'إعدادات مسار تسليم إشعارات الخلفية (صفّ واحد). delivery_url فارغ = الرابط المُضمَّن الافتراضي. التعديل من service_role أو SQL Editor فقط.';

insert into public.push_settings (id, delivery_url)
values (true, null)
on conflict (id) do nothing;

alter table public.push_settings enable row level security;
-- لا سياسات: لا أحد يقرأ/يكتب من exterior عدا service_role (يتجاوز RLS).

-- ============================================================
-- ② نقطة التسليم الفعّالة: من الإعدادات، وإلا الرابط المُضمَّن.
-- ============================================================
create or replace function public.push_delivery_url()
returns text language sql stable security definer set search_path = public as $$
  select coalesce(
    (select s.delivery_url from public.push_settings s where s.id),
    'https://gqocavvhkfzgxzscrjms.supabase.co/functions/v1/send-push'
  );
$$;

grant execute on function public.push_delivery_url() to authenticated;

-- مُعدِّل نقطة التسليم — service_role فقط (أو SQL Editor).
create or replace function public.push_set_delivery_url(p_url text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if coalesce(p_url, '') <> '' and p_url !~ '^https://' then
    return jsonb_build_object('ok', false, 'error', 'يجب أن يبدأ الرابط بـ https://');
  end if;
  insert into public.push_settings (id, delivery_url, updated_at)
  values (true, nullif(p_url, ''), now())
  on conflict (id) do update set delivery_url = excluded.delivery_url, updated_at = now();
  return jsonb_build_object(
    'ok', true,
    'delivery_url', public.push_delivery_url(),
    'is_default', public.push_delivery_url() = 'https://gqocavvhkfzgxzscrjms.supabase.co/functions/v1/send-push'
  );
end;
$$;

revoke all on function public.push_set_delivery_url(text) from public, anon, authenticated;
-- المنح شرطي: بعض قواعد PostgreSQL العادية لا تملك دور service_role،
-- وتطبيق الهجرة يجب ألا يفشل بسبب ذلك.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.push_set_delivery_url(text) to service_role';
  end if;
end $$;

-- ============================================================
-- ③ بوابة الإشعارات: تأخذ الرابط من الإعدادات (قابل للتهيئة).
--    ⚠️ SECRET — مُضمَّن مباشرةً (بلا Vault). يجب أن يطابق تماماً
--    SEND_PUSH_SECRET المضبوط على دالة send-push، وإلا رُدّت الطلبات بـ 401.
-- ============================================================
create or replace function public.trigger_send_push_notification(
  p_kind text,
  p_ref uuid,
  p_recipient uuid,
  p_body jsonb
)
returns void language plpgsql security definer set search_path = public, net as $$
declare
  v_secret text := 'my_send_push_19921121_almgawell_19921121';
  v_url text;
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

  -- نقطة التسليم: من الإعدادات (قابلة للتهيئة) وإلا الرابط المُضمَّن
  v_url := public.push_delivery_url();

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
-- ④ تشخيص شبكة القاعدة: أي مضيفات تصل إليها وأيها لا تصل.
--    كل مسبار يُدرج في net.calls ⇒ يُقرأ ردّه عبر push_probe_result(request_id).
-- ============================================================
create or replace function public.push_net_diagnostics()
returns jsonb language plpgsql security definer set search_path = public, net as $$
declare
  v_url text := public.push_delivery_url();
  v_fn text := 'https://gqocavvhkfzgxzscrjms.supabase.co/functions/v1/send-push';
  v_legacy text := 'https://gqocavvhkfzgxzscrjms.functions.supabase.co/send-push';
  v_r_fn bigint;
  v_r_legacy bigint;
  v_r_public bigint;
  v_r_cf bigint;
begin
  -- مسبار ①: دالة send-push نفسها (الرابط الفعّال)
  begin
    select net.http_post(url := v_url,
                         headers := jsonb_build_object('Content-Type','application/json'),
                         body := jsonb_build_object('type','probe','user_id', auth.uid()),
                         timeout_milliseconds := 8000)
    into v_r_fn;
  exception when others then
    v_r_fn := null;
  end;

  -- مسبار ②: النطاق القديم للدوال (نطاق DNS مختلف — مفيد للتشخيص)
  begin
    select net.http_get(url := v_legacy, timeout_milliseconds := 6000) into v_r_legacy;
  exception when others then
    v_r_legacy := null;
  end;

  -- مسبار ③: مضيف عام (هل DNS يعمل أصلاً من القاعدة؟)
  begin
    select net.http_get(url := 'https://example.com/', timeout_milliseconds := 6000) into v_r_public;
  exception when others then
    v_r_public := null;
  end;

  -- مسبار ④: Cloudflare (هل يستطيع الوصول إلى workers.dev — مسار بديل؟)
  begin
    select net.http_get(url := 'https://www.cloudflare.com/', timeout_milliseconds := 6000) into v_r_cf;
  exception when others then
    v_r_cf := null;
  end;

  return jsonb_build_object(
    'delivery_url', v_url,
    'delivery_is_default', v_url = v_fn,
    'pg_net_installed', exists (select 1 from pg_extension where extname = 'pg_net'),
    'pg_net_version', coalesce((select extversion from pg_extension where extname = 'pg_net'), null),
    'pg_cron_installed', exists (select 1 from pg_extension where extname = 'pg_cron'),
    'supabase_functions_schema', exists (select 1 from pg_namespace where nspname = 'supabase_functions'),
    'db_address', inet_server_addr()::text,
    'probes', jsonb_build_object(
      'function',  jsonb_build_object('url', v_url,     'request_id', v_r_fn),
      'legacy',    jsonb_build_object('url', v_legacy, 'request_id', v_r_legacy),
      'public',    jsonb_build_object('url', 'https://example.com/',        'request_id', v_r_public),
      'cloudflare',jsonb_build_object('url', 'https://www.cloudflare.com/', 'request_id', v_r_cf)
    ),
    'how_to_read', 'اقرأ رد كل مسبار عبر push_probe_result(request_id): status_code = 200 ⇒ وصل، dns_error = true ⇒ فشل تحليل المضيف، وإلا الخطأ في error_msg.'
  );
end;
$$;

revoke all on function public.push_net_diagnostics() from public, anon;
grant execute on function public.push_net_diagnostics() to authenticated;

-- ============================================================
-- ⑤ push_egress_check يستخدم نقطة التسليم الفعّالة.
-- ============================================================
create or replace function public.push_egress_check()
returns jsonb language plpgsql security definer set search_path = public, net as $$
declare
  v_url text := public.push_delivery_url();
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
    'hint', 'الطلب مُدرج في net.calls — اقرأ الرد عبر push_probe_result(request_id).'
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
-- ⑥ push_diagnostics: أضف حالة نقطة التسليم وإعدادات الشبكة.
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
  v_url_const text := 'https://gqocavvhkfzgxzscrjms.supabase.co/functions/v1/send-push';
  v_secret_const text := 'my_send_push_19921121_almgawell_19921121';
  v_vault_pat text := 'vau' || 'lt\.[a-z_]';
  v_live jsonb;
  v_live_url text;
  v_live_vault_free boolean := false;
  v_live_secret_ok boolean := false;
  v_live_url_ok boolean := false;
  v_delivery_url text;
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
             -- الرابط قد يكون في push_delivery_url (نقطة التسليم) أو داخل
             -- الدالة نفسها ⇒ نحسبهما معاً
             bool_or(p.prosrc like '%' || v_url_const || '%')
               or bool_or(p.prosrc like '%/functions/v1/send-push%') as has_url
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname in ('push_call_edge','trigger_send_push_notification','push_gateway_check','push_delivery_url')
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
  v_live_url_ok := coalesce((v_live->'push_delivery_url'->>'has_url')::boolean, false)
    or coalesce((v_live->'trigger_send_push_notification'->>'has_url')::boolean, false);

  begin
    select (regexp_match(p.prosrc, 'https://[a-z0-9.-]+\.supabase\.co/functions/v1/send-push'))[1]
    into v_live_url
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('push_delivery_url','trigger_send_push_notification')
    order by (p.proname = 'push_delivery_url') desc
    limit 1;
  exception when others then
    v_live_url := null;
  end;

  v_delivery_url := public.push_delivery_url();

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
    -- v2.17: نقطة التسليم الفعّالة (قابلة للتهيئة)
    'delivery_url', v_delivery_url,
    'delivery_is_default', v_delivery_url = v_url_const,
    'delivery_overridden', v_delivery_url <> v_url_const,
    -- الرابط الحيّ (من جسم الدالة) — لا ثابت
    'edge_function_url', coalesce(v_live_url, v_url_const),
    'edge_url_hardcoded', true,
    'edge_url_ok', v_live_url_ok and coalesce(v_live_url, v_url_const) like '%/functions/v1/send-push%',
    'secret_hardcoded', v_live_secret_ok,
    'vault_dependency', not v_live_vault_free,
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
-- ⑦ push_probe_result: تلميح أدق (v2.17) — يشير إلى v2.17 ونقطة التسليم.
-- ============================================================
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
               '⚠️ فشل تحليل اسم المضيف داخل pg_net — القاعدة لا تصل إلى هذا المضيف. شغّل push_net_diagnostics لمعرفة المضيفات التي تصل إليها القاعدة.'
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
    execute 'grant execute on function public.push_probe_result(bigint) to authenticated';
  end if;
end $$;

-- ============================================================
-- ⑧ الصلاحيات: الدوال الداخلية غير مفتوحة RPC.
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
