-- ============================================================================
-- Migration v2.19 (2026-10-25): وضع العميل — إلغاء كل اتصال شبكي من القاعدة
-- ============================================================================
-- 📌 why (قرار جوهري):
--
--   القاعدة معزولة شبكياً بالكامل: `pg_net` لا يستطيع حتى تحليل أسماء
--   المضيفات ⇒ "Couldn't resolve host name" ⇒ **لا مسار شبكة من القاعدة إلى
--   دالة send-push ولا إلى أي جهة خارجية**. تشخيص v2.18 أثبت ذلك:
--     • *.supabase.co        ❌ فشل DNS
--     • example.com         ✅ تصل  (إذن DNS عام سليم — العطل في النطاق)
--     • *.functions.supabase.co ✅ تصل
--   وبما أن `supabase_functions.http_request` غلافٌ حول `net.http_post` (نفس
--   المسار)، فلا يوجد نقل بديل داخل القاعدة ⇒ **المسار الوحيد المتبقي هو
--   الواجهة (client)**: المتصفح يرصد الحدث عبر Supabase Realtime ثم يستدعي
--   دالة send-push مباشرةً بمصادقة رمز المستخدم (JWT) — بلا سرّ مشترك في
--   المتصفح وبلا أي اتصال من حاوية القاعدة.
--
-- ✅ ما يغيّره هذا الملف:
--   ① `push_settings.push_mode` = 'client' (الافتراضي) | 'db'
--      ⇒ 'client': التريغرات تُسجّل نيّتها في push_delivery_log فقط، ولا
--        تُجري أي طلب شبكة إطلاقاً (لا net.http_post ولا DNS ولا مهل).
--      ⇒ 'db': يعود السلوك القديم (للتراجع) — بلا هجرة جديدة:
--        select public.push_set_mode('db');
--   ② `trigger_send_push_notification` صارت تحترم الوضع (لا شبكة في 'client').
--   ③ `push_diagnostics` صار يعلن push_mode و db_push_enabled.
--   ④ `push_path_verdict` صار يُعلن الوضع ويتخطّى مسبارات الشبكة في وضع
--      العميل (توفّراً للوقت — لا فائدة من فحص DNS وهو معطّل أصلاً).
--
-- 🔒 لا تغيير في الجداول ولا في سياسات RLS — البيانات كما هي تماماً.
-- 🔒 لا Vault: الرابط والسرّ يبقيان مُضمَّنين (للرجوع إلى وضع 'db' لاحقاً).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- ① جدول الإعدادات: عمود الوضع
-- ---------------------------------------------------------------------------
alter table public.push_settings
  add column if not exists push_mode text not null default 'client';

do $$
begin
  if exists (
    select 1 from pg_constraint where conname = 'push_settings_push_mode_check'
  ) then
    alter table public.push_settings drop constraint push_settings_push_mode_check;
  end if;
end $$;

alter table public.push_settings
  add constraint push_settings_push_mode_check check (push_mode in ('client', 'db'));

update public.push_settings set push_mode = 'client' where id;

-- ---------------------------------------------------------------------------
-- ② قراءة/تبديل الوضع (التبديل: service_role أو SQL Editor فقط)
-- ---------------------------------------------------------------------------
create or replace function public.push_mode()
returns text language sql stable security definer set search_path = public as $$
  select coalesce(
    (select s.push_mode from public.push_settings s where s.id),
    'client'
  );
$$;

grant execute on function public.push_mode() to authenticated;

create or replace function public.push_set_mode(p_mode text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if coalesce(p_mode, '') not in ('client', 'db') then
    return jsonb_build_object('ok', false, 'error', 'الوضع يجب أن يكون client أو db');
  end if;
  update public.push_settings set push_mode = p_mode, updated_at = now() where id;
  if not found then
    insert into public.push_settings (id, push_mode, updated_at) values (true, p_mode, now())
    on conflict (id) do update set push_mode = excluded.push_mode, updated_at = now();
  end if;
  return jsonb_build_object(
    'ok', true,
    'push_mode', public.push_mode(),
    'db_push_enabled', public.push_mode() = 'db',
    'hint', case
      when p_mode = 'client' then
        'وضع العميل: لا تتصل القاعدة بأي شبكة — الإشعارات ترسلها الواجهة عبر Realtime + استدعاء مباشر لـ send-push.'
      else
        'وضع القاعدة: يعود التريغر إلى إرسال pg_net (يتطلّب وصول القاعدة إلى نطاق الدالة).'
    end
  );
end;
$$;

revoke all on function public.push_set_mode(text) from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.push_set_mode(text) to service_role';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- ③ مسار التسليم: لا شبكة في وضع العميل
-- ---------------------------------------------------------------------------
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
  v_mode text := 'client';
begin
  -- ⛔ البوابة: لا مستلم مطابق للحدث ⇒ لا طلب شبكة ولا إشعار
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

  -- ★ وضع العميل (v2.19): القاعدة لا تتصل بأي شبكة إطلاقاً.
  --   الإرسال يتكفّل به العميل: Realtime يرصد الحدث ← استدعاء مباشر لـ
  --   send-push برمز المستخدم. هنا نسجّل النيّة فقط (أثر تدقيق + تشخيص).
  v_mode := public.push_mode();
  if v_mode = 'client' then
    insert into public.push_delivery_log(kind, ref_id, recipient_id, note)
    values (p_kind, p_ref, p_recipient,
            'CLIENT-MODE: لا شبكة من القاعدة — الإرسال من الواجهة (Realtime ← send-push)');
    return;
  end if;

  -- وضع القاعدة (تراجع اختياري): الطلب غير المتزامن عبر pg_net
  v_url := public.push_delivery_url();

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

-- ---------------------------------------------------------------------------
-- ④ push_diagnostics: يعلن الوضع
-- ---------------------------------------------------------------------------
create or replace function public.push_diagnostics()
returns jsonb language plpgsql security definer set search_path = public, extensions, net as $$
declare
  v_url_const text := 'https://gqocavvhkfzgxzscrjms.supabase.co/functions/v1/send-push';
  v_secret_const text := 'my_send_push_19921121_almgawell_19921121';
  v_live jsonb;
  v_live_url text;
  v_live_vault boolean := false;
  v_live_secret boolean := false;
  v_live_url_ok boolean := false;
  v_live_hint text;
  v_missing text[];
  v_delivery_url text := public.push_delivery_url();
  v_mode text := public.push_mode();
  v_fns jsonb;
  v_token_count int;
  v_last jsonb;
  v_rollup jsonb;
begin
  -- ① فحص الجسم الحيّ لكل دالة في المسار (pg_proc.prosrc) — لا ثوابت.
  select coalesce(jsonb_object_agg(t.proname, jsonb_build_object(
           'has_url', coalesce(t.has_url, false),
           'has_secret', coalesce(t.has_secret, false),
           'reads_vault', coalesce(t.reads_vault, false)
         )), '{}'::jsonb),
         bool_or(coalesce(t.reads_vault, false)),
         bool_or(coalesce(t.has_secret, false)),
         bool_or(coalesce(t.has_url, false))
    into v_live, v_live_vault, v_live_secret, v_live_url_ok
  from (
    select p.proname,
           bool_or(p.prosrc ~* ('vau' || 'lt\.[a-z_]')) as reads_vault,
           bool_or(p.prosrc like '%' || v_secret_const || '%') as has_secret,
           bool_or(p.prosrc like '%' || v_url_const || '%')
             or bool_or(p.prosrc like '%/functions/v1/send-push%') as has_url
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname in ('push_call_edge','trigger_send_push_notification','push_gateway_check','push_delivery_url')
      group by p.proname
  ) t;

  v_fns := v_live;

  -- ② الرابط الحيّ داخل bodies
  select (regexp_match(p.prosrc, 'https://[a-z0-9.-]+\.(?:supabase\.co|functions\.supabase\.co)[^''" ]*'))[1]
    into v_live_url
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('push_delivery_url','trigger_send_push_notification')
   order by (p.proname = 'push_delivery_url') desc
   limit 1;

  -- ③ الدوال الناقصة: غيابها = قاعدة متأخرة
  select array_agg(x) into v_missing
    from unnest(array['push_call_edge','trigger_send_push_notification',
                      'push_gateway_check','push_delivery_url']) as x
   where not exists (
     select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = x);

  v_live_hint := case
    when v_missing is not null then
      '⚠️ دوال المسار ناقصة في القاعدة: ' || array_to_string(v_missing, ', ')
      || ' — نفّذ migration v2.19 (2026-10-25).'
    when v_live_vault then '⚠️ جسم دوال المسار في القاعدة ما زال يقرأ Vault — نفّذ migration v2.19 (2026-10-25).'
    when not v_live_secret then '⚠️ جسم دوال المسار لا يحمل السرّ المُضمَّن — نفّذ migration v2.19 (2026-10-25).'
    when not v_live_url_ok then '⚠️ جسم دوال المسار لا يحمل رابط send-push — نفّذ migration v2.19 (2026-10-25).'
    else '✅ جسم دوال المسار في القاعدة محدَّث ومُضمَّن (بلا Vault).'
  end;

  -- ④ عدّ التوكنات + آخر سجل تسليم
  begin
    select count(*) into v_token_count from public.fcm_tokens;
  exception when others then
    v_token_count := null;
  end;

  begin
    select to_jsonb(l) into v_last
      from (select id, kind, ref_id, recipient_id, request_id, note, created_at
              from public.push_delivery_log order by id desc limit 1) l;
  exception when others then
    v_last := null;
  end;

  begin
    select to_jsonb(r) into v_rollup
      from (select id, status_code, error_msg
              from net._http_response order by id desc limit 1) r;
  exception when others then
    v_rollup := null;
  end;

  return jsonb_build_object(
    'edge_function_url', coalesce(v_live_url, v_url_const),
    'edge_url_hardcoded', true,
    'edge_url_ok', v_live_url_ok and coalesce(v_live_url, v_url_const) like '%/functions/v1/send-push%',
    'secret_hardcoded', v_live_secret,
    'vault_dependency', v_live_vault,
    'live_path_vault_free', not v_live_vault and v_missing is null,
    'live_path_secret_ok', v_live_secret and v_missing is null,
    'live_path_url_ok', v_live_url_ok and v_missing is null,
    'live_path_stale', v_live_vault or (v_missing is not null),
    'live_path_missing', coalesce(v_missing, '{}'::text[]),
    'live_path_functions', v_fns,
    'live_path_hint', v_live_hint,
    'push_mode', v_mode,
    'db_push_enabled', v_mode = 'db',
    'client_push_expected', v_mode = 'client',
    'delivery_url', v_delivery_url,
    'delivery_is_default', v_delivery_url = v_url_const,
    'delivery_overridden', v_delivery_url <> v_url_const,
    'isolation_version', 'v2.9',
    'isolation', jsonb_build_object(
      'my_tokens', v_token_count,
      'last_log', v_last,
      'pg_net_rollup', v_rollup
    ),
    'my_tokens', v_token_count,
    'last_log', v_last,
    'hint', case
      when v_mode = 'client' then
        'وضع العميل: القاعدة لا تتصل بأي شبكة — الإشعارات ترسلها الواجهة عبر Realtime ← استدعاء مباشر لـ send-push برمز المستخدم.'
      else
        'وضع القاعدة: التريغر يرسل عبر pg_net — يتطلّب وصول القاعدة إلى نطاق الدالة (فحصه: select public.push_path_verdict();).'
    end
  );
end;
$$;

revoke all on function public.push_diagnostics() from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.push_diagnostics() to authenticated';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- ⑤ push_path_verdict: يعلن الوضع ويتخطّى مسبارات الشبكة في وضع العميل
-- ---------------------------------------------------------------------------
create or replace function public.push_path_verdict(p_apply boolean default false)
returns jsonb language plpgsql security definer set search_path = public, net as $$
declare
  v_primary text := 'https://gqocavvhkfzgxzscrjms.supabase.co/functions/v1/send-push';
  v_mode text := public.push_mode();
  v_verdict jsonb;
  v_probes jsonb := '{}'::jsonb;
  v_item jsonb;
begin
  if v_mode = 'client' then
    -- لا فائدة من فحص شبكة القاعدة في وضع العميل (بلا اتصال إطلاقاً)
    return jsonb_build_object(
      'mode', 'client',
      'push_mode', v_mode,
      'delivery_url', public.push_delivery_url(),
      'delivery_is_default', public.push_delivery_url() = v_primary,
      'candidates', '[]'::jsonb,
      'probes', '{}'::jsonb,
      'results', '[]'::jsonb,
      'works_count', 0,
      'best_url', null,
      'best_label', null,
      'switched', false,
      'apply_requested', p_apply,
      'apply_allowed', false,
      'internet_reachable', null,
      'verdict', 'ℹ️ وضع العميل: القاعدة لا تتصل بأي شبكة (هذا مقصود). مسار التسليم من الواجهة: Realtime ← استدعاء مباشر لـ send-push برمز المستخدم. لفحص مسار القاعدة شغّل: select public.push_set_mode(''db''); ثم select public.push_path_verdict();',
      'how_to_apply', 'وضع العميل — لا حاجة لتحويل وجهة التسليم.'
    );
  end if;

  v_verdict := public.push_path_verdict_db(p_apply);

  for v_item in select * from jsonb_array_elements(coalesce(v_verdict->'candidates', '[]'::jsonb))
  loop
    v_probes := v_probes || jsonb_build_object(
      v_item->>'label',
      jsonb_build_object('url', v_item->>'url', 'request_id', v_item->>'request_id',
                         'status_code', v_item->>'status_code', 'works', v_item->>'works',
                         'dns_error', v_item->>'dns_error', 'hint', v_item->>'hint')
    );
  end loop;

  return v_verdict || jsonb_build_object(
    'mode', 'db',
    'push_mode', v_mode,
    'probes', v_probes
  );
end;
$$;

revoke all on function public.push_path_verdict(boolean) from public, anon;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.push_path_verdict(boolean) to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.push_path_verdict(boolean) to service_role';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- ⑥ نسخة داخلية من حكم المسار (وضع القاعدة) — تُستدعى من push_path_verdict
--    عند الحاجة فقط (وضع 'db').
-- ---------------------------------------------------------------------------
create or replace function public.push_path_verdict_db(p_apply boolean default false)
returns jsonb language plpgsql security definer set search_path = public, net as $$
declare
  v_primary text := 'https://gqocavvhkfzgxzscrjms.supabase.co/functions/v1/send-push';
  v_legacy  text := 'https://gqocavvhkfzgxzscrjms.functions.supabase.co/send-push';
  v_current text := public.push_delivery_url();

  v_labels text[] := array[]::text[];
  v_urls   text[] := array[]::text[];
  v_reqs   bigint[] := array[]::bigint[];
  v_done   int := 0;
  v_status int;
  v_error  text;
  v_content text;
  v_dns boolean;
  v_best text := null;
  v_best_label text := null;
  v_switched boolean := false;
  v_applied boolean := false;
  v_role text;
  v_jwt_role text;
  v_can_apply boolean := false;
  v_candidates jsonb := '[]'::jsonb;
  v_item jsonb;
  v_i int;
  v_works_count int := 0;
  v_any_dns boolean := false;
  v_looks_fn boolean := false;
  v_inet_req bigint;
  v_inet_status int;
  v_inet_error text;
  v_inet_content text;
  v_inet_dns boolean := false;
begin
  v_labels := array_append(v_labels, 'primary');
  v_urls   := array_append(v_urls, v_primary);
  if v_legacy <> v_primary then
    v_labels := array_append(v_labels, 'legacy');
    v_urls   := array_append(v_urls, v_legacy);
  end if;
  if v_current <> v_primary and not (v_current = any(v_urls)) then
    v_labels := array_append(v_labels, 'current');
    v_urls   := array_append(v_urls, v_current);
  end if;

  for v_i in 1..array_length(v_urls, 1) loop
    v_reqs := array_append(v_reqs, public.push_fire_probe(v_urls[v_i]));
  end loop;

  v_inet_req := public.push_fire_probe('https://example.com/');

  for i in 1..12 loop
    select count(*) into v_done
      from net._http_response r
     where r.id = any(v_reqs);
    exit when v_done >= coalesce(array_length(v_reqs, 1), 0);
    perform pg_sleep(0.4);
  end loop;

  select r.status_code, r.error_msg, r.content::text
    into v_inet_status, v_inet_error, v_inet_content
    from net._http_response r
   where r.id = v_inet_req;
  v_inet_dns := (v_inet_status = 0) and (
    coalesce(v_inet_error, '') ilike '%resolve host%'
    or coalesce(v_inet_error, '') ilike '%name or service not known%'
  );

  for v_i in 1..array_length(v_urls, 1) loop
    select r.status_code, r.error_msg, r.content::text
      into v_status, v_error, v_content
      from net._http_response r
     where r.id = v_reqs[v_i];

    v_dns := (v_status = 0) and (
      coalesce(v_error, '') ilike '%resolve host%'
      or coalesce(v_error, '') ilike '%couldn''t resolve%'
      or coalesce(v_error, '') ilike '%name or service not known%'
      or coalesce(v_content, '') ilike '%resolve host%'
    );

    v_looks_fn := (v_status = 200) and (
      coalesce(v_content, '') = ''
      or coalesce(v_content, '') ilike '%sent%'
      or coalesce(v_content, '') ilike '%skipped%'
      or coalesce(v_content, '') ilike '%no fcm token%'
      or coalesce(v_content, '') ilike '%error%'
    );

    v_item := jsonb_build_object(
      'label', v_labels[v_i],
      'url', v_urls[v_i],
      'request_id', v_reqs[v_i],
      'status_code', v_status,
      'error', v_error,
      'dns_error', v_dns,
      'works', v_looks_fn,
      'hint', case
        when v_status = 200 and v_looks_fn then '✅ الوجهة تخدم دالة send-push والسرّ مطابق — تصلح للتسليم فوراً.'
        when v_status = 200 then '⚠️ ردّ 200 لكن مضمونه لا يبدو من دالة send-push.'
        when v_status = 401 then '⚠️ الوجهة تصل لكن رفضت السرّ (x-send-push-secret).'
        when v_status = 404 then '⚠️ الوجهة تصل لكن لا تخدم send-push عند هذا المسار (404).'
        when v_dns then '❌ فشل تحليل اسم المضيف من داخل القاعدة — النطاق غير قابل للوصول منها.'
        when v_status is null then '⚠️ لم يردّ الخادم خلال ~5 ثوانٍ.'
        else '⚠️ رد غير متوقع (' || coalesce(v_status::text, '?') || '): ' || coalesce(v_error, v_content, '')
      end
    );
    v_candidates := v_candidates || jsonb_build_array(v_item);
    if v_dns then
      v_any_dns := true;
    end if;

    if v_looks_fn then
      v_works_count := v_works_count + 1;
      if v_best is null then
        v_best := v_urls[v_i];
        v_best_label := v_labels[v_i];
      end if;
    end if;
  end loop;

  v_jwt_role := null;
  begin
    v_jwt_role := auth.jwt() ->> 'role';
  exception when others then
    v_jwt_role := null;
  end;
  v_role := coalesce(nullif(v_jwt_role, ''), session_user::text);
  v_can_apply := (v_jwt_role = 'service_role')
    or (v_jwt_role is null and session_user in ('postgres', 'supabase_admin'));
  v_applied := p_apply and v_best is not null and v_best <> v_current and v_can_apply;
  if v_applied then
    perform public.push_set_delivery_url(v_best);
    v_switched := public.push_delivery_url() = v_best;
  end if;

  return jsonb_build_object(
    'delivery_url', public.push_delivery_url(),
    'delivery_is_default', public.push_delivery_url() = v_primary,
    'candidates', v_candidates,
    'internet_reachable', coalesce(v_inet_status, 0) > 0 and not v_inet_dns,
    'internet_probe', jsonb_build_object(
      'url', 'https://example.com/',
      'request_id', v_inet_req,
      'status_code', v_inet_status,
      'dns_error', v_inet_dns
    ),
    'works_count', v_works_count,
    'best_url', v_best,
    'best_label', v_best_label,
    'switched', v_switched,
    'apply_requested', p_apply,
    'apply_allowed', v_can_apply,
    'role', v_role,
    'verdict', case
      when v_best is not null and v_switched then
        '✅ تم التحويل إلى «' || v_best_label || '» — مسار التسليم الحيّ أصبح: ' || v_best
      when v_best is not null and v_best = v_current then
        '✅ المسار الحالي يعمل (200) — لا حاجة لأي تغيير.'
      when v_best is not null then
        '✅ وجهة صالحة متاحة: ' || v_best || ' — شغّل select public.push_path_verdict(true); لتحويل المسار.'
      when v_works_count = 0 and coalesce(v_inet_status, 0) = 0 then
        '❌ لا يوجد أي مضيف تصل إليه القاعدة (حتى example.com) ⇒ المخرج مقيّد. راجع Project Settings ← Network (Restrict egress) في لوحة Supabase.'
      when v_works_count = 0 and v_any_dns then
        '❌ القاعدة تصل إلى الإنترنت (example.com يعمل) لكنها لا تصل إلى أي نطاق supabase.co.'
      else
        '❌ لم تنجح أي وجهة (لا 200). راجع status_code لكل مرشّح في candidates.'
    end,
    'how_to_apply', 'select public.push_path_verdict(true);  -- يحوّل المسار إلى أفضل وجهة عاملة'
  );
end;
$$;

revoke all on function public.push_path_verdict_db(boolean) from public, anon;

comment on function public.push_mode() is
'وضع إرسال الإشعارات: client (الافتراضي — لا شبكة من القاعدة، الإرسال من الواجهة) أو db (تراجع: pg_net).';
comment on function public.push_set_mode(text) is
'تبديل وضع الإرسال بين client و db — service_role / SQL Editor فقط.';
