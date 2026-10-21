-- ============================================================================
-- Migration v3.0 — 2026-10-26
-- إعادة هيكلة الإشعارات: Database Webhooks فقط، بلا pg_net وبلا Vault
-- ----------------------------------------------------------------------------
-- هذه الهجرة تُكمل سلسلة v2.x وتُلغي كل طبقات الإرسال من داخل القاعدة:
--
--   ❌ pg_net / net.http_post          (فشل DNS من حاوية القاعدة)
--   ❌ Supabase Vault (SEND_PUSH_URL/SECRET)
--   ❌ تريگرات على messages / call_rooms / profiles تُرسل HTTP
--   ❌ push_settings + push_mode + push_path_verdict + مشغّل مسارات الإرسال
--   ❌ Cloudflare Worker الوسيط (worker/send-push-relay.js)
--
--   ✅ Supabase Database Webhooks → Edge Function send-push → FCM HTTP v1
--
-- ⚠️ خطوة لوحة التحكم (مرة واحدة، بعد تنفيذ هذا الملف):
--    Database → Webhooks → Create a new hook  (×3):
--      push_message | public.messages   | INSERT          | Edge Function: send-push
--      push_call    | public.call_rooms | INSERT + UPDATE | Edge Function: send-push
--      push_signup  | public.profiles   | INSERT          | Edge Function: send-push
--    أضف الترويسة:  x-send-push-secret: <قيمة SEND_PUSH_SECRET في أسرار الدالة>
--
-- آمنة لإعادة التنفيذ (idempotent) — لا تحذف أي بيانات محادثات أو مستخدمين.
-- ⚠️ الاستثناء الوحيد: جدول push_delivery_log يُعاد إنشاؤه بشكل جديد (سجل تشخيصي)
--    فتُمحى سجلاته القديمة. لا يحمل أي بيانات عمل.
-- ============================================================================

-- ============================================================================
-- 26. محتوى v3.0 (مطابق لـ sql/schema.sql §26) (2026-10-26): الإشعارات عبر Supabase Database Webhooks فقط
-- ----------------------------------------------------------------------------
-- 📌 القرار المعماري (نهائي):
--    قاعدة البيانات **لا تُجري أي طلب HTTP**. لا pg_net، لا Vault، لا تريگرات
--    إشعارات، لا Cloudflare Worker وسيط، لا أسرار أو روابط مخزَّنة في القاعدة.
--    السبب: حاوية القاعدة في هذا المشروع معزولة شبكياً (فشل تحليل DNS لكل
--    نطاق supabase.co) — وأي محاولة إرسال من داخل القاعدة تفشل بصمت.
--
-- ✅ المسار الوحيد المعتمد:
--
--    INSERT/UPDATE على الجداول أدناه
--          │
--          ▼  (Supabase Database Webhook — مُدار سحابياً في لوحة التحكم)
--    POST https://<project-ref>.supabase.co/functions/v1/send-push
--          │  الترويسة: x-send-push-secret: <SEND_PUSH_SECRET>
--          ▼
--    Edge Function send-push  (supabase/functions/send-push)
--          │  Firebase Admin من متغيرات البيئة فقط
--          ▼
--    FCM HTTP v1  ──►  firebase-messaging-sw.js  ──►  إشعار النظام
--
--    • لا يوجد أي إعداد إشعارات مطلوب داخل SQL — الـ Webhook يُنشأ من لوحة
--      Supabase:  Database → Webhooks → Create a new hook
--      الاسم        | الجدول        | الأحداث          | النوع
--      -------------|---------------|------------------|----------------
--      push_message | messages      | INSERT           | Supabase Edge Function → send-push
--      push_call    | call_rooms    | INSERT + UPDATE  | Supabase Edge Function → send-push
--      push_signup  | profiles      | INSERT           | Supabase Edge Function → send-push
--      (أو HTTP Request إلى نفس الرابط مع ترويسة السرّ أعلاه.)
--
--    • الحمولة التي ترسلها Supabase تلقائياً:
--        { "type": "INSERT"|"UPDATE"|"DELETE",
--          "table": "messages"|"call_rooms"|"profiles",
--          "schema": "public",
--          "record": { ...الصف الجديد... },
--          "old_record": { ...الصف القديم أو null... } }
--      ودالة send-push تتعرّف على الحدث من (table, type) وتستخرج المستلم من
--      سجلّ المحادثة/الغرفة نفسه — لا تثق بأي معرّف مستلم قادم من الحمولة.
--
-- 🔎 التشخيص: سجل التسليم push_delivery_log يكتبه الـ Edge Function وحده
--    (service_role). للفحص من SQL Editor:
--      select kind, source, sent, total, skipped, created_at
--        from public.push_delivery_log order by created_at desc limit 20;
--    وللفحص الكامل من التطبيق: زر «اختبار الإشعارات» يستدعي
--      POST /functions/v1/send-push  { "type": "diagnostics" }
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 26.1 تنظيف نهائي لأي بقايا من الجيل القديم (idempotent)
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
begin
  -- تريگرات الإشعارات القديمة (كانت تستدعي net.http_post)
  for r in
    select t.tgname, c.relname
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and not t.tgisinternal
      and t.tgname in ('on_message_inserted', 'on_call_room_notify',
                       'on_profile_created_notify_admins')
  loop
    execute format('drop trigger if exists %I on public.%I', r.tgname, r.relname);
  end loop;
end $$;

-- الدوال القديمة (بأي توقيع) — لا تُترك نسخة واحدة في القاعدة
do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'notify_new_message', 'notify_call_room', 'notify_admins_new_profile',
        'push_call_edge', 'trigger_send_push_notification',
        'push_probe', 'push_probe_result', 'push_probe_endpoint',
        'push_fire_probe', 'push_await_probe',
        'push_gateway_check', 'push_egress_check', 'push_net_diagnostics',
        'push_path_verdict', 'push_path_verdict_db',
        'push_delivery_url', 'push_set_delivery_url',
        'push_mode', 'push_set_mode',
        'push_recipient_allowed', 'push_skip_note',
        'conversation_direct_recipient', 'admin_recipient_ids',
        'push_diagnostics'
      )
  loop
    execute format('drop function if exists %s cascade', r.sig);
  end loop;
end $$;

-- جدول إعدادات الوجهة/الوضع (v2.17–v2.19) لم يبق له معنى: الوجهة في الـ Webhook
drop table if exists public.push_settings cascade;

-- امتداد pg_net: يُزال إن كان مثبّتاً (لا اعتماد عليه إطلاقاً من الآن)
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_net') then
    execute 'drop extension pg_net';
    raise notice 'v3.0: أُزيل امتداد pg_net — الإشعارات تمرّ عبر Database Webhooks فقط.';
  end if;
exception when others then
  raise notice 'v3.0: تعذّر إزالة امتداد pg_net (قد يملكه دور آخر) — أزله يدوياً: drop extension pg_net;';
end $$;

-- ---------------------------------------------------------------------------
-- 26.2 سجل التسليم (يكتبه Edge Function بـ service_role فقط)
-- ---------------------------------------------------------------------------
drop table if exists public.push_delivery_log cascade;

create table public.push_delivery_log (
  id bigint generated by default as identity primary key,
  kind text not null,                                -- new_message | incoming_call | call_ended | new_user | test | probe
  ref_id uuid,                                       -- message_id / room_id / profile_id
  recipient_id uuid,                                 -- المستلم الفعلي (فردي) — null للإشعار الجماعي
  source text not null default 'webhook',            -- webhook | manual | client
  sent integer not null default 0,                   -- أجهزة نجح إرسالها
  total integer not null default 0,                  -- أجهزة حاولنا الإرسال إليها
  skipped text,                                      -- سبب التخطي (إن وُجد)
  detail jsonb not null default '{}'::jsonb,         -- تفاصيل غير حسّاسة (بلا توكنات)
  created_at timestamptz not null default now()
);

comment on table public.push_delivery_log is
'سجل تسليم إشعارات FCM — يكتبه Edge Function send-push بـ service_role بعد كل حدث Webhook. لا تكتب فيه أي دالة أو تريگر داخل القاعدة (v3.0).';

create index if not exists idx_push_log_created_at on public.push_delivery_log (created_at desc);
create index if not exists idx_push_log_recipient on public.push_delivery_log (recipient_id, created_at desc);

alter table public.push_delivery_log enable row level security;

-- قراءة للمشرفين فقط؛ لا سياسات كتابة ⇒ لا يستطيع أي عميل التلاعب بالسجل.
drop policy if exists "push log superadmin read" on public.push_delivery_log;
drop policy if exists "push log admin read" on public.push_delivery_log;
create policy "push log admin read" on public.push_delivery_log
  for select using (public.is_admin_user() or public.is_super_admin_user());

-- تنظيف دوري (service_role / SQL Editor / pg_cron إن توفّر)
create or replace function public.prune_push_delivery_log(p_keep_days integer default 7)
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_days integer := greatest(coalesce(p_keep_days, 7), 1);
  v_count integer := 0;
begin
  delete from public.push_delivery_log
   where created_at < now() - make_interval(days => v_days);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.prune_push_delivery_log(integer) from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.prune_push_delivery_log(integer) to service_role';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 26.3 ملاحظات تشغيلية
-- ---------------------------------------------------------------------------
-- • أسرار Firebase (FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL /
--   FIREBASE_PRIVATE_KEY أو FIREBASE_SERVICE_ACCOUNT) تُضبط كأسرار الدالة:
--       supabase secrets set --env-file .env
--   ولا تُخزَّن في القاعدة بأي شكل.
-- • SEND_PUSH_SECRET يُضبط مرة واحدة في أسرار الدالة، ويُدخل نفسه في ترويسة
--   الـ Webhook من لوحة Supabase. تغييره = تحديث مكانين فقط.
-- • الدالة منشورة بـ verify_jwt = false (supabase/config.toml) لأن الـ Webhook
--   لا يحمل JWT مستخدم؛ المصادقة عبر x-send-push-secret.
-- • بعد تطبيق هذا الملف:  Database → Webhooks → تأكد أن الروابط الثلاثة
--   (push_message / push_call / push_signup) تشير إلى
--   https://<project-ref>.supabase.co/functions/v1/send-push
