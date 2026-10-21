-- ============================================================
-- Migration v2.8 — 2026-10-13
-- (أ) إشعار فوري لجميع المشرفين عند تسجيل مستخدم جديد
--     (Trigger على public.profiles → pg_net → send-push → FCM لكل أجهزة كل مشرف)
-- (ب) دليل المستخدمين الشامل للمشرف: بحث حي في كل المسجّلين (profiles)
--     مع معرّف المحادثة القائمة إن وُجدت — لبدء محادثة فورية مع أي مستخدم.
--
-- آمنة لإعادة التنفيذ (idempotent). نفّذها بعد v2.7 (أو نفّذ schema.sql كاملاً).
--
-- المتطلبات المسبقة للإشعارات (نفس مسار رسائل الخلفية):
--   • امتداد pg_net (الرابط والسرّ مُضمَّنان مباشرةً منذ v2.15 — بلا Vault)
--   • نشر دالة send-push (النسخة التي تدعم type = 'new_user')
-- ============================================================

-- ============================================================
-- (أ) إشعار المشرفين عند إنشاء ملف شخصي جديد
-- ============================================================

-- قائمة مستلمي إشعار "مستخدم جديد" (المشرفون النشطون فقط).
create or replace function public.admin_recipient_ids()
returns table(id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select p.id
  from public.profiles p
  where (p.is_admin = true or p.is_super_admin = true)
    and p.is_blocked = false;
$$;
grant execute on function public.admin_recipient_ids() to authenticated;

-- يرسل طلباً واحداً إلى send-push بحمولة المستخدم الجديد، والدالة تتولّى
-- التوزيع على كل المشرفين وكل أجهزتهم (طلب pg_net واحد لكل تسجيل، لا لكل مشرف).
--
-- ملاحظات تصميمية:
--   • لا يُشعر أحد إن لم يكن هناك مشرف واحد مسجَّل بعد (يُسجَّل السبب في push_delivery_log).
--   • أي خطأ داخل هذه الدالة لا يُفشل التسجيل إطلاقاً (exception → warning فقط).
--   • البريد الداخلي المُشتق (phone.<digits>@users.local) لا يُرسل في الحمولة.
create or replace function public.notify_admins_new_profile()
returns trigger
language plpgsql
security definer
set search_path = public, net
as $$
declare
  v_admins integer;
  v_staff boolean;
  v_email text;
begin
  begin
    v_staff := coalesce(new.is_admin, false) or coalesce(new.is_super_admin, false);

    select count(*) into v_admins from public.admin_recipient_ids();

    if v_admins = 0 then
      insert into public.push_delivery_log(kind, ref_id, note)
      values ('new_user', new.id, 'SKIPPED: لا يوجد مشرف مسجَّل/نشط بعد');
      return new;
    end if;

    -- لا نكشف البريد التقني المُشتق من رقم الهاتف
    v_email := case
      when coalesce(new.email, '') like 'phone.%@users.local' then null
      else new.email
    end;

    perform public.push_call_edge(
      'new_user',
      new.id,
      null,                        -- ليس مستلماً واحداً: الإشعار موزَّع على كل المشرفين
      jsonb_build_object(
        'type', 'new_user',
        'user_id', new.id,
        'display_name', coalesce(nullif(btrim(coalesce(new.display_name, '')), ''), 'مستخدم جديد'),
        'email', v_email,
        'phone', new.phone,
        'is_admin', v_staff,
        'admins_count', v_admins,
        'created_at', to_char(coalesce(new.created_at, now()) at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
      )
    );
  exception when others then
    -- الإشعار مكمّل لا أساسي: التسجيل يجب أن ينجح دائماً
    raise warning 'notify_admins_new_profile: %', sqlerrm;
  end;

  return new;
end;
$$;

drop trigger if exists on_profile_created_notify_admins on public.profiles;
create trigger on_profile_created_notify_admins
  after insert on public.profiles
  for each row execute procedure public.notify_admins_new_profile();

-- ============================================================
-- (ب) دليل المستخدمين الشامل + بحث حي للمشرف
-- ============================================================

-- فهارس البحث (اختيارية: تُتخطّى بأمان إن لم يتوفّر pg_trgm).
do $$
begin
  begin
    create extension if not exists pg_trgm;
  exception when others then
    raise notice 'pg_trgm غير متاح: %', sqlerrm;
  end;

  begin
    create index if not exists idx_profiles_display_name_trgm
      on public.profiles using gin (display_name gin_trgm_ops);
  exception when others then
    raise notice 'فهرس الثلاثيات على display_name غير متاح: %', sqlerrm;
  end;

  begin
    create index if not exists idx_profiles_email_trgm
      on public.profiles using gin (email gin_trgm_ops);
  exception when others then
    raise notice 'فهرس الثلاثيات على email غير متاح: %', sqlerrm;
  end;

  begin
    create index if not exists idx_profiles_created_at
      on public.profiles (created_at desc);
  exception when others then
    raise notice 'فهرس created_at غير متاح: %', sqlerrm;
  end;
end $$;

-- دليل المستخدمين: قائمة كل المسجّلين أو بحث حي في (الاسم / البريد / الهاتف).
--   p_query = ''  ⇒ أحدث المسجّلين (مرتّبون بتاريخ التسجيل تنازلياً)
--   p_query <> '' ⇒ مطابقة جزئية في الاسم أو البريد أو أرقام الهاتف
-- الإرجاع: { total, limit, offset, users: [...] } — كل مستخدم يحمل conversation_id
-- إن كانت لديه محادثة قائمة مع المشرف المستدعي (لتفادي إنشاء محادثة مكرّرة).
create or replace function public.admin_directory_search(
  p_query text default '',
  p_limit integer default 60,
  p_offset integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_query text := btrim(coalesce(p_query, ''));
  -- الأرقام فقط (مع تحويل الأرقام العربية/الفارسية) لمطابقة الهاتف بأي صيغة
  v_digits text := regexp_replace(
    translate(coalesce(p_query, ''), '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789'),
    '\D', '', 'g'
  );
  v_pattern text;
  v_limit integer := least(greatest(coalesce(p_limit, 60), 1), 200);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_total bigint := 0;
  v_rows jsonb := '[]'::jsonb;
begin
  if v_uid is null or not public.is_admin_user(v_uid) then
    raise exception 'غير مصرّح: دليل المستخدمين للمشرفين فقط' using errcode = '42501';
  end if;

  -- تهريب محارف LIKE الخاصة حتى لا يتحوّل البحث إلى نمط مفتوح
  v_pattern := '%' || replace(replace(replace(v_query, '\', '\\'), '%', '\%'), '_', '\_') || '%';

  with people as (
    select p.id,
           p.display_name,
           case when coalesce(p.email, '') like 'phone.%@users.local' then null else p.email end as email,
           p.phone,
           p.avatar_url,
           p.is_admin,
           p.is_super_admin,
           p.is_blocked,
           p.is_online,
           p.last_seen,
           p.created_at,
           -- أرقام الهاتف فقط (مع تحويل الأرقام العربية/الفارسية) للمقارنة بأي صيغة
           regexp_replace(
             translate(coalesce(p.phone, ''), '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789'),
             '\D', '', 'g'
           ) as phone_digits
    from public.profiles p
    where p.id <> v_uid
  ),
  matches as (
    select pe.id,
           pe.display_name,
           pe.email,
           pe.phone,
           pe.avatar_url,
           pe.is_admin,
           pe.is_super_admin,
           pe.is_blocked,
           pe.is_online,
           pe.last_seen,
           pe.created_at,
           conv.id as conversation_id,
           conv.last_message,
           conv.last_message_at
    from people pe
    left join lateral (
      select c.id, c.last_message, c.last_message_at
      from public.conversations c
      where (c.user_id = pe.id and c.admin_id = v_uid)
         or (c.admin_id = pe.id and c.user_id = v_uid)
      order by c.last_message_at desc nulls last
      limit 1
    ) conv on true
    where
      v_query = ''
      or pe.display_name ilike v_pattern
      or coalesce(pe.email, '') ilike v_pattern
      or (
        v_digits <> ''
        and pe.phone_digits <> ''
        and (
          -- مطابقة جزئية مباشرة في أرقام الهاتف المخزّنة
          pe.phone_digits like '%' || v_digits || '%'
          -- أو بحث يحمل رمز الدولة/بادئة زائدة: قارن آخر 7 أرقام (على الطرفين)
          or (
            length(v_digits) >= 7
            and length(pe.phone_digits) >= 7
            and v_digits like '%' || right(pe.phone_digits, 7) || '%'
          )
        )
      )
  )
  select (select count(*) from matches),
         coalesce(
           (select jsonb_agg(to_jsonb(s))
            from (
              select * from matches
              order by
                -- عند البحث: الأقرب أبجدياً أولاً. عند القائمة الكاملة: الأحدث تسجيلاً أولاً.
                case when v_query = '' then null else lower(coalesce(display_name, '')) end asc nulls last,
                case when v_query = '' then null else created_at end desc nulls last,
                created_at desc nulls last
              limit v_limit offset v_offset
            ) s),
           '[]'::jsonb
         )
    into v_total, v_rows;

  return jsonb_build_object(
    'total', coalesce(v_total, 0),
    'limit', v_limit,
    'offset', v_offset,
    'query', v_query,
    'users', coalesce(v_rows, '[]'::jsonb)
  );
end;
$$;

revoke all on function public.admin_directory_search(text, integer, integer) from public, anon;
grant execute on function public.admin_directory_search(text, integer, integer) to authenticated;

-- عدّاد سريع لأحدث المسجّلين (يُعرض في ترويسة الدليل وتشخيص الإشعارات)
create or replace function public.registered_users_count()
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select count(*) from public.profiles where public.is_admin_user(auth.uid());
$$;
grant execute on function public.registered_users_count() to authenticated;

-- ============================================================
-- (ج) تشخيص: أضف مؤشرات الميزتين إلى push_diagnostics()
-- ============================================================
create or replace function public.push_diagnostics()
returns jsonb language plpgsql security definer set search_path = public, extensions, net as $$
declare
  v jsonb;
  v_last jsonb;
  v_admin_triggers integer := 0;
  v_registered bigint := 0;
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
  exception when others then
    v_admin_triggers := 0;
    v_registered := 0;
  end;

  select jsonb_build_object(
    'pg_net_installed', exists (select 1 from pg_extension where extname = 'pg_net'),
    'edge_function_url', 'https://gqocavvhkfzgxzscrjms.supabase.co/functions/v1/send-push',
    'edge_url_hardcoded', true,
    'edge_url_ok', true,
    'secret_hardcoded', true,
    'vault_dependency', false,
    'trigger_messages', exists (select 1 from pg_trigger where tgname = 'on_message_inserted' and not tgisinternal),
    'trigger_calls', exists (select 1 from pg_trigger where tgname = 'on_call_room_notify' and not tgisinternal),
    'trigger_new_user', v_admin_triggers > 0,
    'admins_count', (select count(*) from public.admin_recipient_ids()),
    'registered_users', v_registered,
    'directory_rpc', exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'admin_directory_search'
    ),
    'my_tokens', (select count(*) from public.fcm_tokens where user_id = auth.uid()),
    'last_log', v_last
  ) into v;
  return v;
end;
$$;
grant execute on function public.push_diagnostics() to authenticated;
