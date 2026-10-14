-- ============================================================
-- Migration v2.9 — 2026-10-13
-- عزل مستلمي إشعارات الرسائل والمكالمات + الوضع الصامت للمشرف العام (Super Admin)
-- ============================================================
--
-- المشكلة التي تعالجها هذه الهجرة:
--   • إشعارات الرسائل ومكالمات الرنين كانت تُوزَّع بمنطق "الطرف الآخر" دون حراسة
--     صارمة على هوية المستلم، فيمكن أن يصل إشعار/رنين لحساب ليس طرفاً مباشراً
--     في المحادثة أو الغرفة — وأبرز ضحايا ذلك: المشرف العام (Super Admin) الذي
--     يرى كل المحادثات عبر RLS فيتحوّل هاتفه إلى جهاز تنبيهات لكل النظام.
--
-- ما تفعله الهجرة (بدون أي تعديل على الجداول أو أنواع البيانات القائمة):
--   ① حراسة مركزية واحدة: push_recipient_allowed() تمنع أي إشعار لا يطابق الحدث.
--   ② notify_new_message(): المستلم = الطرف الآخر في نفس صف المحادثة حصراً
--      (user_id ⇒ admin_id والعكس)، والمرسل خارج الأطراف ⇒ لا إشعار إطلاقاً.
--   ③ notify_call_room(): المستلم = callee_id المذكور في غرفة المكالمة حصراً،
--      ولا رنين لأي حساب آخر (لا سوبر أدمن ولا مشرفين ولا غرباء).
--   ④ notify_admins_new_profile(): يبقى **الإشعار الجماعي الوحيد** (تسجيل مستخدم
--      جديد)، مع فصل تام عن مساري الرسائل والمكالمات (لا يتقاطعان أبداً).
--   ⑤ RLS: المشرف العام يقرأ/يراقب كل المحادثات والرسائل وسجلات المكالمات
--      (Read-only / Admin mode) بلا قيود — دون أن يستلم أي تنبيه عنها.
--   ⑥ وضع المراقبة للقراءة فقط: اطلاع المشرف العام على محادثة ليس طرفاً فيها
--      لا يغيّر حالة التسليم/القراءة الخاصة بأصحابها (mark_conversation_read /
--      mark_messages_delivered تعملان لطرفي المحادثة فقط).
--   ⑦ push_diagnostics(): مؤشرات العزل الجديدة للتشخيص من لوحة Supabase.
--
-- آمنة لإعادة التنفيذ (idempotent). نفّذها بعد v2.8 (أو نفّذ schema.sql كاملاً —
-- الهجرة مطابقة للقسم 17 منه). لا حاجة لإعادة نشر send-push لهذه الهجرة وحدها،
-- لكن النسخة المشدّدة من الدالة (v2.9) تحقّق من نفس القواعد من جهتها أيضاً.
--
-- المتطلبات المسبقة (نفس مسار الإشعارات القائم):
--   • امتداد pg_net + أسرار Vault: SEND_PUSH_URL و SEND_PUSH_SECRET
--   • نشر دالة send-push
-- ============================================================

-- ============================================================
-- ① دوال الحراسة المركزية (مصدر واحد للحقيقة لِمن يحق له الاستلام)
-- ============================================================

-- هل الحساب مشرف عام (is_super_admin)؟
create or replace function public.is_super_admin_user(p_user_id uuid default auth.uid())
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = p_user_id and is_super_admin = true
  );
$$;

-- المستلم المباشر لمحادثة: الطرف الآخر في نفس الصف حصراً.
--   • المرسل هو user_id  ⇒ يعيد admin_id
--   • المرسل هو admin_id ⇒ يعيد user_id
--   • المرسل ليس طرفاً في المحادثة (مشاهدة/مراقبة) ⇒ يعيد null (لا إشعار)
create or replace function public.conversation_direct_recipient(
  p_conversation_id uuid,
  p_sender_id uuid
)
returns uuid language sql stable security definer set search_path = public as $$
  select case
    when c.user_id = p_sender_id and c.admin_id is distinct from p_sender_id then c.admin_id
    when c.admin_id = p_sender_id and c.user_id is distinct from p_sender_id then c.user_id
    else null
  end
  from public.conversations c
  where c.id = p_conversation_id;
$$;

-- ⛔ الحراسة المركزية: هل يُسمح بإرسال إشعار من هذا النوع إلى هذا المستلم؟
--    تُستدعى من push_call_edge() قبل أي طلب شبكة — فلا يمكن لأي Trigger أو دالة
--    أن "تتجاوزها" ولو أخطأت في حساب المستلم.
--
--    القواعد:
--      new_user  ⇒ إشعار جماعي وحيد (المشرفون) ⇒ لا مستلم فردي إطلاقاً.
--      new_message ⇒ المستلم = الطرف الآخر في المحادثة نفسها، والمرسل طرف فيها.
--      incoming_call / call_ended ⇒ المستلم = callee_id في الغرفة نفسها حصراً.
--      probe / test ⇒ للمستخدم نفسه فقط (auth.uid()).
--      أي نوع آخر ⇒ يجب تحديد مستلم فردي (لا بث جماعي ضمني).
create or replace function public.push_recipient_allowed(
  p_kind text,
  p_ref uuid,
  p_recipient uuid,
  p_body jsonb
)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare
  v_sender uuid;
  v_conversation uuid;
begin
  if p_kind is null then
    return false;
  end if;

  -- ① الإشعار الجماعي الوحيد المسموح: مستخدم جديد ⇒ بلا مستلم فردي
  if p_kind = 'new_user' then
    return p_recipient is null;
  end if;

  -- كل ما تبقّى يجب أن يحدّد مستلماً فردياً صراحةً
  if p_recipient is null then
    return false;
  end if;

  -- ② رسالة جديدة: الطرف الآخر في نفس المحادثة فقط (user_id ↔ admin_id)
  if p_kind = 'new_message' then
    begin
      v_sender := nullif(p_body ->> 'sender_id', '')::uuid;
      v_conversation := nullif(p_body ->> 'conversation_id', '')::uuid;
    exception when others then
      return false;
    end;

    if v_sender is null or v_conversation is null then
      return false;
    end if;

    return exists (
      select 1
      from public.conversations c
      where c.id = v_conversation
        and (
          (c.user_id = v_sender and c.admin_id = p_recipient)
          or (c.admin_id = v_sender and c.user_id = p_recipient)
        )
    );
  end if;

  -- ③ مكالمة واردة/انتهت: callee_id المُعلن في الغرفة نفسها فقط
  --    (لا سوبر أدمن، لا مشرفين آخرين، لا أي حساب غير المعني)
  if p_kind in ('incoming_call', 'call_ended') then
    return exists (
      select 1
      from public.call_rooms r
      where r.id = p_ref
        and r.callee_id = p_recipient
        and r.caller_id is distinct from p_recipient
    );
  end if;

  -- ④ مسبار/اختبار: لا يُرسل إلا لصاحب الجلسة نفسه
  if p_kind in ('probe', 'test') then
    return p_recipient = coalesce(auth.uid(), p_recipient);
  end if;

  -- ⑤ أي نوع مستقبلي: يُسمح بشرط وجود مستلم فردي محدَّد (السلوك الافتراضي القديم)
  return true;
end;
$$;

-- سبب تخطّي الإشعار — يُسجَّل في push_delivery_log ليكون التشخيص واضحاً
create or replace function public.push_skip_note(p_kind text, p_recipient uuid)
returns text language plpgsql stable security definer set search_path = public as $$
declare
  v_super boolean := false;
  v_reason text := 'لا مستلم مباشر صالح لهذا الحدث';
begin
  if p_kind = 'new_user' and p_recipient is not null then
    v_reason := 'الإشعار الجماعي (new_user) لا يقبل مستلماً فردياً';
  elsif p_kind = 'new_message' then
    v_reason := 'المستلم ليس الطرف الآخر في المحادثة';
  elsif p_kind in ('incoming_call', 'call_ended') then
    v_reason := 'callee_id ليس مستقبل هذه الغرفة — لا رنين لأي حساب آخر';
  end if;

  begin
    select coalesce(p.is_super_admin, false) into v_super
    from public.profiles p where p.id = p_recipient;
  exception when others then
    v_super := false;
  end;

  -- الوضع الصامت للمشرف العام يسبق أي سبب آخر في السجل (يُقرأ من لوحة Supabase)
  if v_super then
    return 'SKIPPED: مشرف عام ليس طرفاً مباشراً — الوضع الصامت (v2.9) · ' || v_reason;
  end if;

  return 'SKIPPED: ' || v_reason || ' (v2.9)';
end;
$$;

-- هذه الدوال داخلية (تستدعيها Triggers ودوال SECURITY DEFINER فقط) — لا تُمنح للعميل.
-- الأدوار anon/authenticated موجودة دائماً في Supabase، لكن نتحقق منها حتى تعمل
-- الهجرة أيضاً على قاعدة محلية/اختبارية ناقصة بلا أخطاء.
do $$
begin
  revoke all on function public.push_recipient_allowed(text, uuid, uuid, jsonb) from public;
  revoke all on function public.push_skip_note(text, uuid) from public;
  revoke all on function public.conversation_direct_recipient(uuid, uuid) from public;

  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.push_recipient_allowed(text, uuid, uuid, jsonb) from anon';
    execute 'revoke all on function public.push_skip_note(text, uuid) from anon';
    execute 'revoke all on function public.conversation_direct_recipient(uuid, uuid) from anon';
  end if;

  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.push_recipient_allowed(text, uuid, uuid, jsonb) from authenticated';
    execute 'revoke all on function public.push_skip_note(text, uuid) from authenticated';
    execute 'revoke all on function public.conversation_direct_recipient(uuid, uuid) from authenticated';
    -- سياسات RLS للمشرف العام تُستدعى من العميل ⇒ تحتاج صلاحية تنفيذها
    execute 'grant execute on function public.is_super_admin_user(uuid) to authenticated';
  end if;
end $$;

-- ============================================================
-- ② مسار الرسائل: المستلم = الطرف الآخر في المحادثة نفسها حصراً
-- ============================================================
create or replace function public.notify_new_message()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_recipient uuid;
  v_user uuid;
  v_admin uuid;
begin
  -- بطاقة مكالمة داخل المحادثة: لها إشعارها الخاص من call_rooms حصراً
  if new.message_type = 'call' then
    return new;
  end if;

  select c.user_id, c.admin_id into v_user, v_admin
  from public.conversations c
  where c.id = new.conversation_id;

  -- محادثة غير موجودة/يتيمة (نظرياً مستحيل مع FK، لكن نمنع أي إشعار عشوائي)
  if v_user is null and v_admin is null then
    insert into public.push_delivery_log(kind, ref_id, note)
    values ('new_message', new.id, 'SKIPPED: محادثة غير موجودة (v2.9)');
    return new;
  end if;

  -- ✅ تحديد المستلم حصرياً من أطراف المحادثة المباشرة
  if v_user = new.sender_id then
    v_recipient := v_admin;
  elsif v_admin = new.sender_id then
    v_recipient := v_user;
  else
    -- المرسل ليس طرفاً في المحادثة (مثال: المشرف العام يراقب محادثة غيره)
    -- ⇒ لا إشعار لأي جهة إطلاقاً (هذا هو مصدر الإزعاج الذي أُغلق)
    insert into public.push_delivery_log(kind, ref_id, note)
    values ('new_message', new.id, 'SKIPPED: المرسل ليس طرفاً في المحادثة — بلا إشعار (v2.9)');
    return new;
  end if;

  if v_recipient is null or v_recipient = new.sender_id then
    insert into public.push_delivery_log(kind, ref_id, note)
    values ('new_message', new.id, 'SKIPPED: لا يوجد طرف مقابل مباشر في المحادثة (v2.9)');
    return new;
  end if;

  perform public.push_call_edge(
    'new_message',
    new.id,
    v_recipient,
    jsonb_build_object(
      'message_id', new.id,
      'conversation_id', new.conversation_id,
      'sender_id', new.sender_id,
      'recipient_id', v_recipient,   -- تصريح صريح بالمستلم: تتحقق منه الدالة أيضاً
      'content', coalesce(new.content, case new.attachment_type when 'image' then '📷 صورة' when 'audio' then '🎤 رسالة صوتية' else '📎 مرفق' end)
    )
  );
  return new;
end;
$$;

drop trigger if exists on_message_inserted on public.messages;
create trigger on_message_inserted
  after insert on public.messages
  for each row execute procedure public.notify_new_message();

-- ============================================================
-- ③ مسار المكالمات: الرنين = callee_id فقط (لا سوبر أدمن ولا أي حساب آخر)
-- ============================================================
create or replace function public.notify_call_room()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_type text;
  v_recipient uuid;
begin
  if tg_op = 'INSERT' and new.status = 'ringing' then
    v_type := 'incoming_call';
  elsif tg_op = 'UPDATE' and old.status is distinct from new.status
        and new.status in ('missed', 'ended', 'declined', 'failed', 'network_lost') then
    v_type := 'call_ended';
  else
    return new;
  end if;

  -- ✅ المستلم الوحيد إطلاقاً: callee_id المُعلن في غرفة المكالمة نفسها.
  --    لا استثناء للمشرف العام، ولا بث لأي مشرف آخر، ولا لأي جهة مراقبة.
  v_recipient := new.callee_id;

  if v_recipient is null or v_recipient = new.caller_id then
    insert into public.push_delivery_log(kind, ref_id, note)
    values (v_type, new.id, 'SKIPPED: callee_id غير صالح — لا رنين لأي حساب (v2.9)');
    return new;
  end if;

  -- تحقّق مزدوج: طرفا المكالمة هما طرفا المحادثة فعلاً (لا مكالمات بين أطراف غريبة)
  if not exists (
    select 1
    from public.conversations c
    where c.id = new.conversation_id
      and (c.user_id = new.caller_id or c.admin_id = new.caller_id)
      and (c.user_id = new.callee_id or c.admin_id = new.callee_id)
  ) then
    insert into public.push_delivery_log(kind, ref_id, note)
    values (v_type, new.id, 'SKIPPED: طرفا المكالمة ليسا طرفي المحادثة (v2.9)');
    return new;
  end if;

  perform public.push_call_edge(
    v_type,
    new.id,
    v_recipient,
    jsonb_build_object(
      'type', v_type,
      'room_id', new.id,
      'conversation_id', new.conversation_id,
      'caller_id', new.caller_id,
      'callee_id', new.callee_id,
      'recipient_id', v_recipient,   -- تصريح صريح بالمستلم: تتحقق منه الدالة أيضاً
      'call_type', new.call_type,
      'status', new.status
    )
  );
  return new;
end;
$$;

drop trigger if exists on_call_room_notify on public.call_rooms;
create trigger on_call_room_notify
  after insert or update on public.call_rooms
  for each row execute procedure public.notify_call_room();

-- ============================================================
-- ④ الحراسة المركزية داخل push_call_edge (آخر بوابة قبل الشبكة)
--    نفس التوقيع السابق (بلا تغيير) ⇒ لا يتأثّر أي مستدعٍ قائم.
-- ============================================================
create or replace function public.push_call_edge(p_kind text, p_ref uuid, p_recipient uuid, p_body jsonb)
returns void language plpgsql security definer set search_path = public, vault, net as $$
declare
  v_url text;
  v_secret text;
  v_auth text;
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

  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'SEND_PUSH_URL' limit 1;
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'SEND_PUSH_SECRET' limit 1;
  -- ترويسة Authorization: مفتاح anon من Vault إن وُجد، وإلا السر المشترك نفسه
  select decrypted_secret into v_auth from vault.decrypted_secrets where name = 'SUPABASE_ANON_KEY' limit 1;
  if coalesce(v_auth, '') = '' then
    select decrypted_secret into v_auth from vault.decrypted_secrets where name = 'SUPABASE_SERVICE_ROLE_KEY' limit 1;
  end if;
  -- لا مفتاح مكتوب في الكود: بلا JWT صالح في Vault لا يُرسَل أي طلب (fail-closed)
  if coalesce(v_auth, '') = '' or v_auth !~ '^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' then
    insert into public.push_delivery_log(kind, ref_id, recipient_id, note)
    values (p_kind, p_ref, p_recipient, 'SKIPPED: SUPABASE_ANON_KEY غير مضبوط في Vault');
    return;
  end if;

  if coalesce(v_url, '') = '' or coalesce(v_secret, '') = '' then
    insert into public.push_delivery_log(kind, ref_id, recipient_id, note)
    values (p_kind, p_ref, p_recipient, 'SKIPPED: SEND_PUSH_URL/SEND_PUSH_SECRET غير مضبوطين في Vault');
    return;
  end if;

  v_headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-send-push-secret', v_secret,
    'Authorization', 'Bearer ' || v_auth,
    'apikey', v_auth
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

-- ============================================================
-- ⑤ إشعار المستخدم الجديد = الإشعار الجماعي الوحيد (مراجعة v2.9)
--    - لا يتقاطع مع مساري الرسائل والمكالمات: نوع مستقل ('new_user') بمستلم null.
--    - يبقى مقصوراً على INSERT في profiles، وبعد التحقق من وجود مشرف نشط.
--    - يُضاف له وسم صريح (category = admin_broadcast) حتى لا يُفسَّر كإشعار
--      رسالة/مكالمة في الواجهة أو الـ Service Worker.
--    - الحساب المحظور عند التسجيل لا يُرسل عنه إشعار.
-- ============================================================
create or replace function public.notify_admins_new_profile()
returns trigger
language plpgsql
security definer
set search_path = public, vault, net
as $$
declare
  v_admins integer;
  v_staff boolean;
  v_email text;
begin
  begin
    -- حساب محظور مسبقاً ⇒ لا إشعار جماعي عنه
    if coalesce(new.is_blocked, false) then
      insert into public.push_delivery_log(kind, ref_id, note)
      values ('new_user', new.id, 'SKIPPED: الحساب محظور (v2.9)');
      return new;
    end if;

    v_staff := coalesce(new.is_admin, false) or coalesce(new.is_super_admin, false);

    -- عدد المشرفين النشطين: من دالة v2.8 إن وُجدت، وإلا مباشرةً من profiles
    -- (نفس القاعدة) حتى تعمل الهجرة وحدها على قاعدة لم تُطبَّق عليها v2.8.
    begin
      select count(*) into v_admins from public.admin_recipient_ids();
    exception when others then
      begin
        select count(*) into v_admins
        from public.profiles p
        where (p.is_admin = true or p.is_super_admin = true) and p.is_blocked = false;
      exception when others then
        v_admins := 0;
      end;
    end;

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

    -- مستلم فردي = null (التوزيع داخل send-push على المشرفين النشطين فقط).
    -- البوابة المركزية ترفض أي محاولة لتحويل هذا النوع إلى إشعار فردي.
    perform public.push_call_edge(
      'new_user',
      new.id,
      null,
      jsonb_build_object(
        'type', 'new_user',
        'category', 'admin_broadcast',   -- وسم صريح: ليس رسالة ولا مكالمة
        'recipients', 'admins',
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
-- ⑥ RLS — المشرف العام: مراقبة كاملة (Read-only / Admin mode)، تنبيهات صفر
--    ملاحظة: هذه السياسات موجودة أصلاً في schema.sql §9.4/§10.6؛ نُعيد إنشاءها
--    هنا idempotent لضمان وجودها على أي قاعدة طُبِّقت عليها الهجرات تدريجياً.
--    لا تُعدّل أي جدول ولا نوع بيانات — سياسات فقط.
-- ============================================================
do $$
begin
  -- كل سياسة داخل كتلة محمية: غياب جدول (قاعدة لم تُطبَّق عليها الأقسام السابقة
  -- كاملة) لا يُفشل الهجرة — يُسجَّل تنبيه فقط.
  begin
    -- المحادثات: قراءة فقط للمشرف العام (مراقبة بلا كتابة)
    drop policy if exists "conversations full access superadmin" on public.conversations;
    drop policy if exists "conversations read superadmin" on public.conversations;
    create policy "conversations read superadmin" on public.conversations
      for select using (public.is_super_admin_user());
  exception when others then
    raise notice 'تخطّي سياسة conversations read superadmin: %', sqlerrm;
  end;

  begin
    -- الرسائل: قراءة فقط للمشرف العام (مراقبة بلا كتابة)
    drop policy if exists "messages full access superadmin" on public.messages;
    drop policy if exists "messages read superadmin" on public.messages;
    create policy "messages read superadmin" on public.messages
      for select using (public.is_super_admin_user());
  exception when others then
    raise notice 'تخطّي سياسة messages read superadmin: %', sqlerrm;
  end;

  begin
    -- غرف المكالمات: قراءة فقط للتدقيق
    drop policy if exists "call rooms superadmin" on public.call_rooms;
    drop policy if exists "call rooms read superadmin" on public.call_rooms;
    create policy "call rooms read superadmin" on public.call_rooms
      for select using (public.is_super_admin_user());
  exception when others then
    raise notice 'تخطّي سياسة call rooms read superadmin: %', sqlerrm;
  end;

  begin
    -- سجلات أحداث المكالمات: قراءة كاملة
    drop policy if exists "call logs superadmin" on public.call_logs;
    create policy "call logs superadmin" on public.call_logs
      for select using (public.is_super_admin_user());
  exception when others then
    raise notice 'تخطّي سياسة call logs superadmin: %', sqlerrm;
  end;

  begin
    -- سجل محاولات الإشعارات: قراءة كاملة (تشخيص + تدقيق العزل)
    drop policy if exists "push log superadmin read" on public.push_delivery_log;
    create policy "push log superadmin read" on public.push_delivery_log
      for select using (public.is_super_admin_user());
  exception when others then
    raise notice 'تخطّي سياسة push log superadmin read: %', sqlerrm;
  end;

  begin
    -- سجل المكالمات المخفي لكل مستخدم: يُضاف للمشرف العام كي لا يفوته سجل كامل
    drop policy if exists "call history hidden superadmin read" on public.call_history_hidden;
    create policy "call history hidden superadmin read" on public.call_history_hidden
      for select using (public.is_super_admin_user());
  exception when others then
    raise notice 'تخطّي سياسة call history hidden superadmin read: %', sqlerrm;
  end;
end $$;

-- ============================================================
-- ⑦ وضع المراقبة للقراءة فقط (Read-only Observer)
--    المشرف العام يرى كل المحادثات والرسائل، لكن اطلاعه على محادثة
--    **ليس طرفاً فيها** يجب ألا يغيّر حالة التسليم/القراءة الخاصة
--    بأصحابها — وإلا كتم إشعاراتهم وشاراتهم بصمت: تظهر الرسالة "مقروءة"
--    للمرسل بينما المستلم الحقيقي لم يرها بعد.
--    نفس توقيع الدالتين السابقتين (v2.3 / v2.4) ⇒ لا يتأثر أي مستدعٍ،
--    ومع ذلك تُطبَّق الحراسة داخل الخادم لا في العميل فقط.
-- ============================================================

-- قراءة المحادثة: أطرافها فقط (المشرف العام المراقب ⇒ 0 بلا أي تعديل)
create or replace function public.mark_conversation_read(p_conversation_id uuid)
returns integer
language plpgsql security invoker set search_path = public as $$
declare
  v_count integer := 0;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  -- حراسة v2.9: ليس طرفاً في المحادثة ⇒ لا كتابة على رسائل الآخرين
  if not exists (
    select 1 from public.conversations c
    where c.id = p_conversation_id
      and (c.user_id = auth.uid() or c.admin_id = auth.uid())
  ) then
    return 0;
  end if;

  update public.messages m
     set status = 'read'
   where m.conversation_id = p_conversation_id
     and m.sender_id <> auth.uid()
     and (m.status is null or m.status <> 'read');

  get diagnostics v_count = row_count;
  return coalesce(v_count, 0);
end;
$$;

-- تثبيت التسليم (✓✓): نفس الحراسة — لا يغيّر حالة رسائل الآخرين إلا أطرافها
create or replace function public.mark_messages_delivered(p_conversation_id uuid)
returns integer
language plpgsql security invoker set search_path = public as $$
declare
  v_count integer := 0;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if not exists (
    select 1 from public.conversations c
    where c.id = p_conversation_id
      and (c.user_id = auth.uid() or c.admin_id = auth.uid())
  ) then
    return 0;
  end if;

  update public.messages m
     set status = 'delivered'
   where m.conversation_id = p_conversation_id
     and m.sender_id <> auth.uid()
     and m.status = 'sent';

  get diagnostics v_count = row_count;
  return coalesce(v_count, 0);
end;
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.mark_conversation_read(uuid) to authenticated';
    execute 'grant execute on function public.mark_messages_delivered(uuid) to authenticated';
  end if;
end $$;

-- ============================================================
-- ⑧ التشخيص: مؤشرات العزل في push_diagnostics()
-- ============================================================
create or replace function public.push_diagnostics()
returns jsonb language plpgsql security definer set search_path = public, vault, extensions, net as $$
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
    'vault_url', (select decrypted_secret from vault.decrypted_secrets where name = 'SEND_PUSH_URL' limit 1),
    'vault_url_set', exists (select 1 from vault.decrypted_secrets where name = 'SEND_PUSH_URL' and coalesce(decrypted_secret,'') <> ''),
    'vault_secret_set', exists (select 1 from vault.decrypted_secrets where name = 'SEND_PUSH_SECRET' and coalesce(decrypted_secret,'') <> ''),
    'vault_secret_len', (select length(decrypted_secret) from vault.decrypted_secrets where name = 'SEND_PUSH_SECRET' limit 1),
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
-- ⑨ تحقّق سريع (اختياري — نفّذه يدوياً بعد الهجرة)
-- ============================================================
-- • عدد الإشعارات المُرسلة فعلاً (للمقارنة قبل/بعد):
--     select kind, count(*) from public.push_delivery_log
--     where note is null and created_at > now() - interval '1 day'
--     group by kind order by kind;
-- • كل حالات التخطي (المصدر الحقيقي لكل "لماذا لم يصل إشعار؟"):
--     select kind, note, count(*) from public.push_delivery_log
--     where note like 'SKIPPED%' group by kind, note order by count(*) desc;
-- • لا مستلم غير طرف في أي إشعار رسالة/مكالمة:
--     select l.kind, l.recipient_id, l.created_at
--     from public.push_delivery_log l
--     where l.kind in ('new_message','incoming_call','call_ended')
--       and l.note is null
--       and not public.push_recipient_allowed(
--             l.kind, l.ref_id, l.recipient_id,
--             coalesce((select jsonb_build_object('sender_id', m.sender_id, 'conversation_id', m.conversation_id)
--                       from public.messages m where m.id = l.ref_id), '{}'::jsonb))
--     limit 20;
-- • فحص القراءة فقط: يجب أن يعيد صفراً لغير أطراف المحادثة:
--     -- (نفّذها بجلسة حساب ليس طرفاً في المحادثة — مثلاً المشرف العام)
--     select public.mark_conversation_read('<conversation-id>'::uuid);   -- المتوقع 0
--     select public.mark_messages_delivered('<conversation-id>'::uuid);  -- المتوقع 0
-- • فحص الوضع الصامت: يجب أن يكون سوبر أدمن واحد فقط (almgawell17@gmail.com):
--     select id, email, is_super_admin from public.profiles where is_super_admin;

-- ============================================================
-- ⑧ (v2.11) تقليص صلاحيات تنفيذ الدوال: لا RPC مفتوحاً للزوار
--    PostgreSQL يمنح EXECUTE للجميع افتراضياً، وSupabase يعرض كل دالة
--    عامة كنقطة RPC عبر /rest/v1/rpc. هنا: سحب من public و anon، ثم منح
--    المُصادَق فقط ما تستدعيه الواجهة أو سياسات RLS، وسحب الدوال الداخلية
--    (الإشعارات/الحراسة/تنظيف المكالمات) حتى من المُصادَق.
--    الحراسة: كل خطوة تتحقق من وجود الدالة/الدور (قواعد أقدم لا تُفشل الهجرة).
-- ============================================================
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f' and p.proname <> 'uuid_generate_v4'
  loop
    execute format('revoke execute on function %s from public', r.sig);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke execute on function %s from anon', r.sig);
    end if;
  end loop;
end $$;

do $$
declare r record;
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    return;
  end if;
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
      and p.proname in (
        'push_call_edge', 'expire_stale_calls', 'expire_stale_ringing_calls', 'admin_recipient_ids',
        'is_admin_email', 'is_super_admin_email', 'is_internal_phone_email', 'force_admin_presence_online',
        'reset_call_presence', 'push_recipient_allowed', 'push_skip_note', 'conversation_direct_recipient',
        'notify_admins_new_profile', 'notify_call_room', 'notify_new_message',
        'protect_message_immutable_fields', 'protect_profile_privileges', 'handle_new_user',
        'touch_conversation_on_call_message', 'touch_conversation_on_message')
  loop
    execute format('revoke execute on function %s from authenticated', r.sig);
  end loop;
end $$;

-- ما تستدعيه الواجهة (RPC) أو سياسات RLS فقط — للمستخدم المُصادَق
do $$
declare sig text;
begin
  foreach sig in array array[
    'public.push_diagnostics()',
    'public.push_probe()',
    'public.push_probe_result(bigint)',
    'public.call_room_is_ringing(uuid)',
    'public.admin_directory_search(text, integer, integer)',
    'public.unread_counts(uuid[])',
    'public.admin_set_user_blocked(uuid, boolean)',
    'public.admin_delete_user(uuid)',
    'public.register_fcm_token(text, text, text, jsonb)',
    'public.mark_conversation_read(uuid)',
    'public.mark_messages_delivered(uuid)',
    'public.mark_all_messages_delivered()',
    'public.is_admin_user(uuid)',
    'public.is_super_admin_user(uuid)',
    'public.is_not_blocked(uuid)',
    'public.is_conversation_participant(uuid)',
    'public.is_call_participant(uuid)'
  ] loop
    if to_regprocedure(sig) is not null and exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('grant execute on function %s to authenticated', sig);
    end if;
  end loop;
  -- دوال مساعدة RLS: تُرجع false للزائر (بلا auth.uid) ⇒ متاحة لتجنّب أخطاء تقييم السياسات
  foreach sig in array array[
    'public.is_admin_user(uuid)',
    'public.is_super_admin_user(uuid)',
    'public.is_not_blocked(uuid)',
    'public.is_conversation_participant(uuid)',
    'public.is_call_participant(uuid)'
  ] loop
    if to_regprocedure(sig) is not null and exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('grant execute on function %s to anon', sig);
    end if;
  end loop;
end $$;

-- ============================================================
-- ⑩ (v2.11) سياسات الحذف للمشرفين: المشرف العام مراقب فقط ⇒ مستثنى منها.
--    قبل v2.11 كانت is_admin_user() تشمل المشرف العام، وبما أنه يقرأ كل
--    الصفوف عبر سياسة الاطلاع، صار قادراً على حذف أي رسالة/محادثة بصمت.
-- ============================================================
do $$
begin
  -- كل جدول داخل حارس: قاعدة أقدم بلا جدول التفاعلات لا تُفشل الهجرة
  if to_regclass('public.messages') is not null then
    drop policy if exists "messages delete admins only" on public.messages;
    drop policy if exists "messages delete by admins" on public.messages;
    create policy "messages delete by admins" on public.messages for delete
      using (public.is_admin_user() and not public.is_super_admin_user());
  end if;
  if to_regclass('public.conversations') is not null then
    drop policy if exists "conversations delete by admins" on public.conversations;
    create policy "conversations delete by admins" on public.conversations for delete
      using (public.is_admin_user() and not public.is_super_admin_user());
  end if;
  if to_regclass('public.message_reactions') is not null then
    drop policy if exists "reactions delete by admins" on public.message_reactions;
    create policy "reactions delete by admins" on public.message_reactions for delete
      using ((user_id = auth.uid()) or (public.is_admin_user() and not public.is_super_admin_user()));
  end if;
end $$;
