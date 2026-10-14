-- ============================================================
-- Migration v2.10 — 2026-10-14
-- حداثة الرنين من ساعة قاعدة البيانات وحدها (لا ساعة الجهاز)
-- ============================================================
--
-- المشكلة:
--   • expire_stale_ringing_calls() (تُعيد الغرف القديمة إلى missed) معطّلة في cron
--     حتى الآن. فقد تبقى غرفة قديمة بحالة ringing إلى ما لا نهاية.
--   • عند النقر على إشعار مكالمة قديم، كان التطبيق يتحقق من status = ringing فقط،
--     فيعرض رنيناً لمكالمة انتهت منذ زمن.
--   • مقارنة started_at بساعة الجهاز غير موثوقة (الساعة قد تنحرف).
--
-- الحل:
--   call_room_is_ringing(p_room) تُعيد true فقط إذا:
--     ① الغرفة موجّهة لـ auth.uid() بصفته callee_id (RLS تُطبَّق كما هي — security invoker)
--     ② الحالة ringing
--     ③ started_at ضمن دقيقتين، وهي نفس نافذة expire_stale_ringing_calls.
--   كل المقارنات تتم بـ now() لقاعدة البيانات.
--
-- آمنة لإعادة التنفيذ (idempotent). لا تغيّر أي جدول أو trigger.
-- إن لم تُطبَّق هذه الهجرة، يتجاهل التطبيق الفحص ويعتمد على status وحدها.
-- ============================================================

create or replace function public.call_room_is_ringing(p_room uuid)
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select exists (
    select 1
    from public.call_rooms r
    where r.id = p_room
      and r.callee_id = auth.uid()
      and r.status = 'ringing'
      and r.started_at > now() - interval '2 minutes'
  );
$$;

revoke all on function public.call_room_is_ringing(uuid) from public;
grant execute on function public.call_room_is_ringing(uuid) to authenticated;
