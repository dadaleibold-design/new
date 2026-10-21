/*
 * tests/hooks-send-push.mjs — محمّل وحدات لاختبار send-push في Node
 * ------------------------------------------------------------
 * يعترض استيراد supabase-js البعيد (esm.sh) ويوجّهه إلى البديل المحلي
 * tests/deno/supabase-js-stub.ts — تماماً كما تفعل خريطة الاستيراد في Deno.
 * يُستخدم من tests/send-push-runtime.mjs عبر:
 *     register("./hooks-send-push.mjs", import.meta.url)
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "https://esm.sh/@supabase/supabase-js@2") {
    return {
      url: new URL("./deno/supabase-js-stub.ts", import.meta.url).href,
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
