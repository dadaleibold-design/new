-- ============================================================
-- Migration v2.12 — 2026-10-18
-- تنظيف غرف الرنين المنتهية قبل بدء مكالمة جديدة في المحادثة نفسها.
-- ============================================================
--
-- تُعدّ غرفة ringing منتهية بعد دقيقتين (المهلة المعتمدة للرنين في التطبيق).
-- تُنهى أيضاً حالة active التي مضى على answered_at فيها 24 ساعة كحاجز أمان
-- نهائي للجلسات التي ماتت دون إرسال حدث الإنهاء. هذا الحد يحمي المكالمات الحية
-- الطبيعية من انتهاء المهلة القصيرة المخصصة للرنين.
-- تستخدم الدالة ساعة قاعدة البيانات وتعمل بصلاحيات المستدعي (RLS مفعّل)،
-- ولا تمسّ الغرف الحديثة أو غرف محادثات أخرى.

create or replace function public.expire_stale_ringing_calls_for_conversation(
  p_conversation uuid
)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_count integer;
begin
  update public.call_rooms
  set status = case when status = 'ringing' then 'missed' else 'network_lost' end,
      ended_at = now()
  where conversation_id = p_conversation
    and (
      (status = 'ringing' and started_at < now() - interval '2 minutes')
      or (status = 'active' and answered_at < now() - interval '24 hours')
    )
    and (caller_id = auth.uid() or callee_id = auth.uid());

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.expire_stale_ringing_calls_for_conversation(uuid) from public;
grant execute on function public.expire_stale_ringing_calls_for_conversation(uuid) to authenticated;
