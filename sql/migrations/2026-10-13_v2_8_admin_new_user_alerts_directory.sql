-- ============================================================
-- Migration v2.8 — 2026-10-13
-- دليل المستخدمين الشامل للمشرف: بحث حي في كل المسجّلين (profiles)
--     مع معرّف المحادثة القائمة إن وُجدت — لبدء محادثة فورية مع أي مستخدم.
--
-- 🔁 v3.0 (2026-10-26): أُزيل من هذه الهجرة كل مسار إشعار «مستخدم جديد» القديم
--    (Trigger على profiles → pg_net → send-push). الإشعار الآن Database Webhook
--    على profiles INSERT → دالة send-push مباشرةً (انظر
--    sql/migrations/2026-10-26_v3_0_database_webhooks_only.sql).
--
-- آمنة لإعادة التنفيذ (idempotent). نفّذها بعد v2.7 (أو نفّذ schema.sql كاملاً).
-- ============================================================

-- ============================================================
-- دليل المستخدمين الشامل + بحث حي للمشرف
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

