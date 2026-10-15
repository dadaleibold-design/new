/*
 * loop-guard-check — يُشغَّل كعملية فرعية من الاختبار التشغيلي.
 * يستورد دالة send-push الحقيقية مع PUSH_GATEWAY_URL يشير إلى دالة Supabase
 * نفسها — يجب أن يفشل الإقلاع فوراً برسالة الحلقة اللانهائية (fail-fast).
 */

Deno.env.set("SUPABASE_URL", "http://stub.supabase.co");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "stub-service-key");
Deno.env.set("SEND_PUSH_SECRET", "stub-trigger-secret");
Deno.env.set(
  "PUSH_GATEWAY_URL",
  "https://stub-ref.supabase.co/functions/v1/send-push", // ⛔ يؤدي إلى حلقة
);

try {
  await import(new URL("../../supabase/functions/send-push/index.ts", import.meta.url).href);
  console.error("FAIL: importing send-push should have thrown (loop guard)");
  Deno.exit(1);
} catch (error) {
  const message = String((error as Error)?.message || error);
  if (message.includes("infinite loop")) {
    console.log("loop guard fired as expected");
    Deno.exit(0);
  }
  console.error("FAIL: unexpected error:", message);
  Deno.exit(1);
}
