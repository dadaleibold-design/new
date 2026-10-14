/* ============================================================
 * js/composer.js — قرار مفاتيح حقل كتابة الرسالة (منطق نقي، بلا DOM)
 * ------------------------------------------------------------
 * القاعدة:
 *   • Enter            ⇒ "newline" (سطر جديد — السلوك الطبيعي للـ textarea)
 *   • Shift+Enter      ⇒ "send" إن كان النص غير فارغ، وإلا "none"
 *   • أثناء تركيب الحروف (IME: العربية/اليابانية/الصينية) ⇒ "none"
 *   • مفاتيح التعديل الأخرى (Ctrl/Alt/Meta) ⇒ "none" حتى لا تتعارض مع اختصارات المتصفح
 *   • أثناء رفع مرفق ⇒ "none" (منع إرسال مزدوج)
 * ============================================================ */

/**
 * @param {{ key?: string, shiftKey?: boolean, ctrlKey?: boolean, altKey?: boolean,
 *           metaKey?: boolean, isComposing?: boolean, keyCode?: number }} event
 * @param {{ value?: string, uploading?: boolean }} state
 * @returns {"newline" | "send" | "none"}
 */
export function composerKeyAction(event, state = {}) {
  if (!event || event.key !== "Enter") return "none";
  if (event.isComposing || event.keyCode === 229) return "none";
  if (event.ctrlKey || event.altKey || event.metaKey) return "none";
  if (!event.shiftKey) return "newline";
  if (state.uploading) return "none";
  return String(state.value ?? "").trim() ? "send" : "none";
}
