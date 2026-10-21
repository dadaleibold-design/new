-- ============================================================================
-- Migration v2.18 (2026-10-24): حكم حاسم على مسار التسليم + إصلاح ذاتي كامل
-- ============================================================================
-- 📌 why (ما الذي كشفه v2.17 في القاعدة الحيّة):
--
--   نتيجة مسبارات الشبكة (من القاعدة الحيّة نفسها):
--     • send-push  (gqocavvhkfzgxzscrjms.supabase.co)      ❌ Couldn't resolve host name
--     • example.com                                          ✅ تصل
--     • cloudflare.com                                       ✅ تصل
--     • gqocavvhkfzgxzscrjms.functions.supabase.co            ✅ تصل   ← نطاق بديل!
--
--   ⇒ القاعدة تصل إلى الإنترنت، لكنها **لا تصل إلى نطاق *.supabase.co**.
--     إذاً العطل في **نطاق** دالة EdgeFunctions لهذا المشروع (أو في DNS الخاص
--     به)، لا في كود التريگرات ولا في Secret ولا في Vault.
--
--   ⇒ الحلّ: **وجهة تسليم** تصل إليها القاعدة. المرشّح الأقوى بلا أي نشر:
--     النطاق القديم functions.supabase.co (وهو ما يفحصه المسبار أعلاه).
--     ومهمّة هذه الهجرة: **التحقّق الحاسم** هل يخدم هذا النطاق دالة send-push
--     فعلاً (لا يكفي أن يُحلَّل اسم المضيف) — ثم تحويل مسار التسليم إليه
--     **أمر واحد**، بلا هجرة جديدة وبلا نشر.
--
-- 📌 why "الإصلاح الذاتي" (drop + create بدل create or replace):
--     `create or replace` **يفشل** إذا اختلف نوع الإرجاع أو التوقيع عن
--     النسخة القائمة في القاعدة ⇒ عندها **يتوقّف تنفيذ الملف عند تلك
--     العبارة** وتبقى الدوال القديمة (القائمة على Vault) ⇒ خطأ
--     "push_gateway_check غير متاحة". الحل: نحذف كل النسخ (أي توقيع) ثم
--     نُنشئ من جديد ⇒ لا يتأثر شيء، مهما كانت حالة القاعدة.
--
-- 🔒 لا Vault: الرابط والسرّ مُضمَّنان (بلا قراءة من vault.* في أي جسم).
-- 🔒 التحويل إلى وجهة جديدة: `push_path_verdict(true)` يحوّل **خدمةً فقط**
--     (service_role / SQL Editor) — أي مستخدم مصادَق يستطيع القراءة فقط.
--
-- 📦 الاستعمال بعد تطبيق هذا الملف:
--     select public.push_path_verdict();          -- حكم + أفضل وجهة (قراءة)
--     select public.push_path_verdict(true);       -- يحوّل المسار تلقائياً
--     select public.push_probe_endpoint('https://…');  -- اختبار أي رابط
-- ============================================================================

-- ---------------------------------------------------------------------------
-- ① الإصلاح الذاتي: حذف كل نسخ دوال المسار (أي توقيع) ثم إعادة إنشائها.
--    (التبعية الوحيدة: التريغرات تستدعي notify_new_message لا هذه الدوال،
--     فلا تسقط التريغرات — والتحقق في الاختبارات على هذا الأساس.)
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure::text as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'trigger_send_push_notification', 'push_call_edge', 'push_diagnostics',
        'push_gateway_check', 'push_probe', 'push_probe_result',
        'push_egress_check', 'push_delivery_url', 'push_set_delivery_url',
        'push_net_diagnostics', 'push_probe_endpoint', 'push_path_verdict',
        'push_fire_probe', 'push_await_probe'
      )
  loop
    execute 'drop function if exists ' || r.sig || ' cascade';
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- ② نقطة التسليم القابلة للتهيئة (من v2.17) — تُعاد هنا لتكون مكتفية ذاتياً.
-- ---------------------------------------------------------------------------
create table if not exists public.push_settings (
  id boolean primary key default true check (id),
  delivery_url text,
  updated_at timestamptz not null default now()
);

insert into public.push_settings (id, delivery_url)
values (true, null)
on conflict (id) do nothing;

alter table public.push_settings enable row level security;
-- لا سياسات: لا أحد يقرأ/يكتب من exterior عدا service_role (يتجاوز RLS).

create function public.push_delivery_url()
returns text language sql stable security definer set search_path = public as $$
  select coalesce(
    (select s.delivery_url from public.push_settings s where s.id),
    'https://gqocavvhkfzgxzscrjms.supabase.co/functions/v1/send-push'
  );
$$;

grant execute on function public.push_delivery_url() to authenticated;

create function public.push_set_delivery_url(p_url text)
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
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.push_set_delivery_url(text) to service_role';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- ③ مسار التسليم: التريغر يقرأ نقطة التسليم ⇒ تبديل الوجهة يسري فوراً.
-- ---------------------------------------------------------------------------
create function public.trigger_send_push_notification(
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

  -- نقطة التسليم: من الإعدادات (قابلة للتهيئة) وإلا الرابط المُضمَّن
  v_url := public.push_delivery_url();

  v_headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-send-push-secret', v_secret
  );

  -- net.http_post غير متزامن: يُدرج الطلب في net.calls ويعالجه عامل الخلفية.
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

create function public.push_call_edge(p_kind text, p_ref uuid, p_recipient uuid, p_body jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.trigger_send_push_notification(p_kind, p_ref, p_recipient, p_body);
end;
$$;

-- ---------------------------------------------------------------------------
-- ④ المسبار الحاسم: POST حقيقي بصيغة send-push + السرّ ⇒ 200 = الوجهة تعمل.
--    (الحصول على 200 يعني: النطاق يخدم الدالة + السرّ مطابق + pg_net سليم.)
--    لا أثر جانبي: user_id وهمي ⇒ تردّ الدالة بـ {"sent":0,…} بلا إشعار.
-- ---------------------------------------------------------------------------
create function public.push_fire_probe(p_url text)
returns bigint language plpgsql security definer set search_path = public, net as $$
declare
  v_req bigint;
begin
  select net.http_post(
           url := p_url,
           headers := jsonb_build_object(
             'Content-Type', 'application/json',
             'x-send-push-secret', 'my_send_push_19921121_almgawell_19921121'
           ),
           body := jsonb_build_object(
             'type', 'probe',
             'user_id', '00000000-0000-4000-8000-000000000000'
           ),
           timeout_milliseconds := 8000
         )
  into v_req;
  return v_req;
exception when others then
  return null;
end;
$$;

create function public.push_await_probe(p_request_id bigint)
returns jsonb language plpgsql security definer set search_path = public, net as $$
declare
  v_status int;
  v_error text;
  v_content text;
  v_dns boolean := false;
  v_hint text;
  v_looks_fn boolean := false;
begin
  if p_request_id is null then
    return jsonb_build_object('status_code', 0, 'error', null, 'dns_error', true,
      'works', false, 'hint', 'تعذّر إطلاق الطلب عبر pg_net — تحقّق من امتداد pg_net.');
  end if;

  for i in 1..12 loop
    select r.status_code, r.error_msg, r.content::text
      into v_status, v_error, v_content
      from net._http_response r
     where r.id = p_request_id;
    exit when v_status is not null;
    perform pg_sleep(0.4);
  end loop;

  if v_status is null then
    return jsonb_build_object('status_code', null, 'error', null, 'dns_error', false,
      'works', false, 'hint', 'لم يردّ الخادم خلال ~5 ثوانٍ — قد يكون المسار بطيئاً أو محجوباً.');
  end if;

  v_dns := (v_status = 0) and (
    coalesce(v_error, '') ilike '%resolve host%'
    or coalesce(v_error, '') ilike '%couldn''t resolve%'
    or coalesce(v_error, '') ilike '%name or service not known%'
    or coalesce(v_content, '') ilike '%resolve host%'
  );

  -- «يعمل» = 200 + ردّ يبدو من دالة send-push (لا صفحة عامة/HTML)
  v_looks_fn := (v_status = 200) and (
    coalesce(v_content, '') = ''
    or coalesce(v_content, '') ilike '%sent%'
    or coalesce(v_content, '') ilike '%skipped%'
    or coalesce(v_content, '') ilike '%no fcm token%'
    or coalesce(v_content, '') ilike '%error%'
  );

  v_hint := case
    when v_status = 200 and v_looks_fn then '✅ الوجهة تخدم دالة send-push والسرّ مطابق — تصلح للتسليم فوراً.'
    when v_status = 200 then '⚠️ ردّ 200 لكن مضمونه لا يبدو من دالة send-push — تحقق أن الوجهة ليست صفحة عامة.'
    when v_status = 401 then '⚠️ الوجهة تصل لكن رفضت السرّ (x-send-push-secret) — طابِق السرّ على الدالة.'
    when v_status = 404 then '⚠️ الوجهة تصل لكن لا تخدم send-push عند هذا المسار (404).'
    when v_status = 405 then '⚠️ الوجهة تصل لكنMethod Not Allowed — يجب أن يكون الطلب POST.'
    when v_dns then '❌ فشل تحليل اسم المضيف من داخل القاعدة — هذا النطاق غير قابل للوصول من القاعدة.'
    else '⚠️ رد غير متوقع (' || v_status || '): ' || coalesce(v_error, v_content, '')
  end;

  return jsonb_build_object(
    'status_code', v_status,
    'error', v_error,
    'content', v_content,
    'dns_error', v_dns,
    'works', v_looks_fn,
    'hint', v_hint
  );
end;
$$;

create function public.push_probe_endpoint(p_url text)
returns jsonb language plpgsql security definer set search_path = public, net as $$
declare
  v_req bigint;
  v_res jsonb;
begin
  if coalesce(p_url, '') = '' then
    return jsonb_build_object('url', p_url, 'request_id', null, 'status_code', 0,
      'dns_error', true, 'works', false, 'hint', 'رابط فارغ.');
  end if;
  v_req := public.push_fire_probe(p_url);
  v_res := public.push_await_probe(v_req);
  return v_res || jsonb_build_object('url', p_url, 'request_id', v_req);
end;
$$;

revoke all on function public.push_fire_probe(text) from public, anon;
revoke all on function public.push_await_probe(bigint) from public, anon;
revoke all on function public.push_probe_endpoint(text) from public, anon;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.push_probe_endpoint(text) to authenticated';
    execute 'grant execute on function public.push_await_probe(bigint) to authenticated';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- ⑤ الحكم الشامل في نداء واحد: يفحص كل المرشّحين بالتوازي ثم يقرأ الردود
--    معاً (≤ ~5 ثوانٍ) ⇒ نتيجة كاملة في استدعاء واحد.
--
--    المرشّحون:
--      primary : رابط دالة EdgeFunctions الرسمي (*.supabase.co/functions/v1/…)
--      legacy  : النطاق القديم functions.supabase.co (نطاق مختلف — يحلّ DNSه)
--      current : نقطة التسليم الحالية إن كانت مختلفة (مثل بوابة Worker)
--
--    p_apply = true ⇒ يحوّل نقطة التسليم تلقائياً إلى أول مرشّح يعمل.
--    التحويل متاح للخدمة فقط (service_role / SQL Editor) — أي مستخدم
--    مصادَق يقرأ الحكم دون أن يغيّر الوجهة.
-- ---------------------------------------------------------------------------
create function public.push_path_verdict(p_apply boolean default false)
returns jsonb language plpgsql security definer set search_path = public, net as $$
declare
  v_primary text := 'https://gqocavvhkfzgxzscrjms.supabase.co/functions/v1/send-push';
  v_legacy  text := 'https://gqocavvhkfzgxzscrjms.functions.supabase.co/send-push';
  v_current text := public.push_delivery_url();

  v_labels text[] := array[]::text[];
  v_urls   text[] := array[]::text[];
  v_reqs   bigint[] := array[]::bigint[];
  v_inet_req bigint;
  v_inet_status int;
  v_inet_error text;
  v_inet_content text;
  v_inet_dns boolean := false;
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
  v_candidates jsonb := '[]'::jsonb;
  v_item jsonb;
  v_i int;
  v_works_count int := 0;
  v_any_dns boolean := false;
  v_looks_fn boolean := false;
  v_jwt_role text;
  v_can_apply boolean := false;
begin
  -- قائمة المرشّحين (بلا تكرار)
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

  -- إطلاق كل المسبارات بالتوازي (net.http_post غير متزامن)
  for v_i in 1..array_length(v_urls, 1) loop
    v_reqs := array_append(v_reqs, public.push_fire_probe(v_urls[v_i]));
  end loop;

  -- مسبار عام: هل يعمل DNS من القاعدة تجاه أي مضيف؟ (ليس مرشّح تسليم)
  v_inet_req := public.push_fire_probe('https://example.com/');

  -- انتظار الردود معاً (استطلاع واحد لكل الجميع)
  for i in 1..12 loop
    select count(*) into v_done
      from net._http_response r
     where r.id = any(v_reqs);
    exit when v_done >= coalesce(array_length(v_reqs, 1), 0);
    perform pg_sleep(0.4);
  end loop;

  -- قراءة ردّ المسبار العام
  select r.status_code, r.error_msg, r.content::text
    into v_inet_status, v_inet_error, v_inet_content
    from net._http_response r
   where r.id = v_inet_req;
  v_inet_dns := (v_inet_status = 0) and (
    coalesce(v_inet_error, '') ilike '%resolve host%'
    or coalesce(v_inet_error, '') ilike '%name or service not known%'
  );

  -- تجميع النتائج
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

  -- التحويل التلقائي (خدمة فقط):
  --   • service_role (مفتاح service_role)  أو  جلسة SQL Editor (session_user=postgres).
  --   ⚠️ لا نعتمد على current_user لأنه مالك الدالة (postgres) داخل security definer.
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
      'dns_error', v_inet_dns,
      'hint', case
        when v_inet_status is null then '⚠️ لم يردّ المسبار العام خلال ~5 ثوانٍ.'
        when v_inet_dns then '❌ DNS لا يعمل من القاعدة تجاه أي مضيف ⇒ المخرج مقيّد (Project Settings ← Network).'
        else '✅ DNS/Egress يعمل عموماً من القاعدة ⇒ المشكلة محصورة في نطاق supabase.co.'
      end
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
        '❌ القاعدة تصل إلى الإنترنت (example.com يعمل) لكنها لا تصل إلى أي نطاق supabase.co. انشر بوابة بديلة (worker/send-push-relay.js) على نطاق workers.dev ثم select public.push_set_delivery_url(''https://<worker>.workers.dev/'');'
      else
        '❌ لم تنجح أي وجهة (لا 200). راجع status_code لكل مرشّح في candidates.'
    end,
    'how_to_apply', 'select public.push_path_verdict(true);  -- يحوّل المسار إلى أفضل وجهة عاملة'
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
-- ⑥ push_net_diagnostics: صار يرمز الحالة أيضاً (نداء واحد ⇒ حكم كامل).
--    يبقي نفس الحقول القديمة (probes) +(results) + best_url.
-- ---------------------------------------------------------------------------
create function public.push_net_diagnostics()
returns jsonb language plpgsql security definer set search_path = public, net as $$
declare
  v_verdict jsonb;
  v_probes jsonb := '{}'::jsonb;
  v_item jsonb;
begin
  v_verdict := public.push_path_verdict(false);

  for v_item in select * from jsonb_array_elements(coalesce(v_verdict->'candidates', '[]'::jsonb))
  loop
    v_probes := v_probes || jsonb_build_object(
      v_item->>'label',
      jsonb_build_object('url', v_item->>'url', 'request_id', v_item->>'request_id',
                         'status_code', v_item->>'status_code', 'works', v_item->>'works',
                         'dns_error', v_item->>'dns_error', 'hint', v_item->>'hint')
    );
  end loop;

  return jsonb_build_object(
    'delivery_url', public.push_delivery_url(),
    'delivery_is_default', coalesce(v_verdict->>'delivery_is_default', 'false')::boolean,
    'pg_net_installed', exists (select 1 from pg_extension where extname = 'pg_net'),
    'pg_net_version', coalesce((select extversion from pg_extension where extname = 'pg_net'), null),
    'pg_cron_installed', exists (select 1 from pg_extension where extname = 'pg_cron'),
    'supabase_functions_schema', exists (select 1 from pg_namespace where nspname = 'supabase_functions'),
    'db_address', inet_server_addr()::text,
    'probes', v_probes,
    'results', coalesce(v_verdict->'candidates', '[]'::jsonb),
    'best_url', v_verdict->>'best_url',
    'best_label', v_verdict->>'best_label',
    'works_count', coalesce((v_verdict->>'works_count')::int, 0),
    'verdict', v_verdict->>'verdict',
    'how_to_read', 'results[] لكل مرشّح: status_code = 200 ⇒ الوجهة تعمل وجاهزة للتسليم؛ dns_error = true ⇒ لا يمكن الوصول إليها من القاعدة.'
  );
end;
$$;

revoke all on function public.push_net_diagnostics() from public, anon;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.push_net_diagnostics() to authenticated';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- ⑦ push_gateway_check: أُعيد إنشاؤه (كان جسماً قديماً/مفقوداً ⇒ "غير متاح")
--    ويعرض الآن نقطة التسليم الفعّالة إضافةً إلى الرابط المُضمَّن.
-- ---------------------------------------------------------------------------
create function public.push_gateway_check()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_url text := 'https://gqocavvhkfzgxzscrjms.supabase.co/functions/v1/send-push';
  v_delivery text := public.push_delivery_url();
begin
  return jsonb_build_object(
    'url', v_url,
    'url_hardcoded', true,
    'url_is_edge_function', v_url like '%/functions/v1/send-push%',
    'url_is_worker', coalesce(v_url, '') like '%workers.dev%',
    'url_ok', coalesce(v_url, '') like '%/functions/v1/send-push%',
    'secret_hardcoded', true,
    'vault_dependency', false,
    'delivery_url', v_delivery,
    'delivery_is_default', v_delivery = v_url,
    'chain', 'Database Trigger → pg_net (http_post غير متزامن) → ' || v_delivery
             || ' (verify_jwt = false، تحقّق عبر x-send-push-secret) → FCM HTTP v1 → Service Worker',
    'gateway_hint', case
      when coalesce(v_delivery, '') = '' then
        '⚠️ نقطة التسليم فارغة — لن تُرسل إشعارات الـ Triggers.'
      when v_delivery = v_url then
        '✅ المسار سليم: التريگرات تستدعي send-push برابط وسرّ مُضمَّنين بلا Vault.'
      else
        'ℹ️ نقطة التسليم مُوجَّهة إلى وجهة بديلة (' || v_delivery || ') — راجع push_path_verdict().'
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

-- ---------------------------------------------------------------------------
-- ⑧ push_probe: يرسل مسباراً عبر المسار الحقيقي (بلا Vault).
-- ---------------------------------------------------------------------------
create function public.push_probe()
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

revoke all on function public.push_probe() from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.push_probe() to authenticated';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- ⑨ push_probe_result: يفسّر الرد (DNS / 401 / 404) ويشير إلى الحكم الشامل.
-- ---------------------------------------------------------------------------
create function public.push_probe_result(p_request_id bigint)
returns jsonb language plpgsql security definer set search_path = public, net as $$
declare
  v_status int;
  v_error text;
  v_content text;
  v_dns boolean := false;
begin
  if p_request_id is null then
    return jsonb_build_object('pending', false, 'status_code', 0, 'error', null,
      'dns_error', true, 'hint', 'لا يوجد request_id — شغّل push_probe أولاً.');
  end if;

  select r.status_code, r.error_msg, r.content::text
    into v_status, v_error, v_content
    from net._http_response r
   where r.id = p_request_id;

  if v_status is null then
    return jsonb_build_object('pending', true, 'request_id', p_request_id,
      'hint', 'الطلب ما زال قيد التنفيذ — أعد القراءة بعد لحظات.');
  end if;

  v_dns := (v_status = 0) and (
    coalesce(v_error, '') ilike '%resolve host%'
    or coalesce(v_error, '') ilike '%couldn''t resolve%'
    or coalesce(v_error, '') ilike '%name or service not known%'
    or coalesce(v_content, '') ilike '%resolve host%'
  );

  return jsonb_build_object(
    'pending', false,
    'request_id', p_request_id,
    'status_code', v_status,
    'response', v_content,
    'error', v_error,
    'dns_error', v_dns,
    'hint', case
      when v_status = 200 then '✅ ردّ إيجابي — المسار يعمل.'
      when v_status = 401 then '⚠️ السرّ غير مطابق — supabase secrets set SEND_PUSH_SECRET=…'
      when v_status = 404 then '⚠️ المسار غير موجود على هذا النطاق.'
      when v_dns then '⚠️ فشل تحليل اسم المضيف داخل pg_net — القاعدة لا تصل إلى هذا المضيف. شغّل public.push_path_verdict() لتحديد الوجهة الصالحة وتحويل المسار.'
      else '⚠️ خطأ في pg_net: ' || coalesce(v_error, v_content, '')
    end
  );
end;
$$;

revoke all on function public.push_probe_result(bigint) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.push_probe_result(bigint) to authenticated';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- ⑩ push_egress_check: فحص مباشر (بلا دوال وسيطة) — يبقى للتوافق.
-- ---------------------------------------------------------------------------
create function public.push_egress_check()
returns jsonb language plpgsql security definer set search_path = public, net as $$
declare
  v_url text := public.push_delivery_url();
  v_req bigint;
begin
  select net.http_post(
           url := v_url,
           headers := jsonb_build_object(
             'Content-Type', 'application/json',
             'x-send-push-secret', 'my_send_push_19921121_almgawell_19921121'
           ),
           body := jsonb_build_object('type', 'probe',
                                      'user_id', '00000000-0000-4000-8000-000000000000'),
           timeout_milliseconds := 8000
         )
  into v_req;

  return jsonb_build_object(
    'url', v_url,
    'queued', true,
    'request_id', v_req,
    'hint', 'اقرأ الرد عبر public.push_probe_result(' || coalesce(v_req::text, 'null') || ') أو استدعِ public.push_path_verdict() للحصول على حكم كامل.'
  );
exception when others then
  return jsonb_build_object('url', v_url, 'queued', false, 'request_id', null,
    'error', sqlerrm, 'hint', 'تعذّر إطلاق الطلب من داخل القاعدة.');
end;
$$;

revoke all on function public.push_egress_check() from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.push_egress_check() to authenticated';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- ⑪ push_diagnostics: الحالة الحيّة + نقطة التسليم + كلمة الحكم.
-- ---------------------------------------------------------------------------
create function public.push_diagnostics()
returns jsonb language plpgsql security definer set search_path = public, extensions, net as $$
declare
  v_url_const text := 'https://gqocavvhkfzgxzscrjms.supabase.co/functions/v1/send-push';
  v_secret_const text := 'my_send_push_19921121_almgawell_19921121';
  v_live jsonb;
  v_live_url text;
  v_live_vault boolean := false;
  v_live_secret boolean := false;
  v_live_url_ok boolean := false;
  v_live_stale boolean := false;
  v_live_hint text;
  v_missing text[];
  v_delivery_url text := public.push_delivery_url();
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

  -- ② الدوال الناقصة: غيابها = قاعدة متأخرة أيضاً (لا نقول «سليم» ونكذب)
  select array_agg(x) into v_missing
    from unnest(array['push_call_edge','trigger_send_push_notification',
                      'push_gateway_check','push_delivery_url']) as x
   where not exists (
     select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = x);

  v_live_stale := v_live_vault or (v_missing is not null);
  v_live_hint := case
    when v_missing is not null then
      '⚠️ دوال المسار ناقصة في القاعدة: ' || array_to_string(v_missing, ', ')
      || ' — نفّذ migration v2.18 (2026-10-24) (تُنشئ كل النسخ بعد حذفها).'
    when v_live_vault then '⚠️ جسم دوال المسار في القاعدة ما زال يقرأ Vault — نفّذ migration v2.18 (2026-10-24).'
    when not v_live_secret then '⚠️ جسم دوال المسار لا يحمل السرّ المُضمَّن — نفّذ migration v2.18 (2026-10-24).'
    when not v_live_url_ok then '⚠️ جسم دوال المسار لا يحمل رابط send-push — نفّذ migration v2.18 (2026-10-24).'
    else '✅ جسم دوال المسار في القاعدة محدَّث ومُضمَّن (بلا Vault).'
  end;

  -- ③ عدّ التوكنات + آخر سجل تسليم
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

  -- ④ ملخّص آخر ردّ من pg_net
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
    'live_path_missing', coalesce(v_missing, '{}'::text[]),
    'live_path_stale', v_live_stale,
    'live_path_functions', v_fns,
    'live_path_hint', v_live_hint,
    'delivery_url', v_delivery_url,
    'delivery_is_default', v_delivery_url = v_url_const,
    'delivery_overridden', v_delivery_url <> v_url_const,
    'isolation', jsonb_build_object(
      'my_tokens', v_token_count,
      'last_log', v_last,
      'pg_net_rollup', v_rollup
    ),
    'my_tokens', v_token_count,
    'last_log', v_last,
    'hint', 'لتحديد الوجهة الصالحة تلقائياً: select public.push_path_verdict(true);'
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

comment on function public.push_path_verdict(boolean) is
'الحكم الشامل على مسار التسليم: يفحص كل المرشّحين (primary/legacy/current) بمسبار حقيقي (POST + السرّ ⇒ 200 = يعمل) ويحوّل نقطة التسليم تلقائياً إلى أول مرشّح ناجح. التحويل للخدمة فقط (service_role / SQL Editor).';
comment on function public.push_probe_endpoint(text) is
'اختبار حاسم لوجهة واحدة: POST حقيقي بصيغة send-push + x-send-push-secret ⇒ status_code=200 يعني أن الوجهة تخدم الدالة والسرّ مطابق.';
