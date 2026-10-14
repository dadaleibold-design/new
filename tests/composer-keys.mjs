/* اختبار قواعد مفاتيح حقل الرسالة (Enter سطر جديد / Shift+Enter إرسال) */
import fs from "node:fs";
import assert from "node:assert/strict";
import { composerKeyAction } from "../js/composer.js";

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { failures++; console.log(`FAIL ${name}\n   ${e.message}`); }
}
const ev = (over = {}) => ({ key: "Enter", shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, isComposing: false, keyCode: 13, ...over });
const filled = { value: "مرحبا", uploading: false };
const empty = { value: "   ", uploading: false };

check("Enter وحدها ⇒ سطر جديد (لا إرسال) حتى مع نص", () =>
  assert.equal(composerKeyAction(ev(), filled), "newline"));
check("Enter وحدها على حقل فارغ ⇒ سطر جديد أيضاً (لا إرسال)", () =>
  assert.equal(composerKeyAction(ev(), empty), "newline"));
check("Shift+Enter مع نص ⇒ إرسال", () =>
  assert.equal(composerKeyAction(ev({ shiftKey: true }), filled), "send"));
check("Shift+Enter على حقل فارغ ⇒ لا شيء", () =>
  assert.equal(composerKeyAction(ev({ shiftKey: true }), empty), "none"));
check("Shift+Enter على مسافات فقط ⇒ لا شيء", () =>
  assert.equal(composerKeyAction(ev({ shiftKey: true }), { value: "\n \t" }), "none"));
check("Shift+Enter أثناء رفع مرفق ⇒ لا إرسال", () =>
  assert.equal(composerKeyAction(ev({ shiftKey: true }), { value: "x", uploading: true }), "none"));
check("Shift+Enter أثناء تركيب IME ⇒ لا إرسال", () =>
  assert.equal(composerKeyAction(ev({ shiftKey: true, isComposing: true }), filled), "none"));
check("keyCode 229 (IME) ⇒ لا إرسال", () =>
  assert.equal(composerKeyAction(ev({ shiftKey: true, keyCode: 229 }), filled), "none"));
check("Ctrl+Shift+Enter ⇒ لا إرسال (تجنّب تعارض الاختصارات)", () =>
  assert.equal(composerKeyAction(ev({ shiftKey: true, ctrlKey: true }), filled), "none"));
check("مفاتيح غير Enter ⇒ none", () =>
  assert.equal(composerKeyAction({ key: "a", shiftKey: true }, filled), "none"));
check("لا حدث ⇒ none", () => assert.equal(composerKeyAction(null, filled), "none"));

// تحقق من الربط في الواجهة: textarea + مستمع keydown يستخدم composerKeyAction
const html = fs.readFileSync(new URL("../partials/chat-panel.html", import.meta.url), "utf8");
const app = fs.readFileSync(new URL("../js/app.js", import.meta.url), "utf8");
const sw = fs.readFileSync(new URL("../sw.js", import.meta.url), "utf8");
check("chat-panel: #composer-input صار textarea", () =>
  assert.match(html, /<textarea id="composer-input"/));
check("app.js: مستمع keydown على composer-input يستخدم composerKeyAction", () =>
  assert.match(app, /"keydown",\s*guard\("composer:keys"[\s\S]{0,400}composerKeyAction\(e/));
check("app.js: لا يوجد إرسال على Enter بدون Shift (لا يُستدعى requestSubmit إلا عند action==='send')", () =>
  assert.match(app, /if \(action === "newline" \|\| action === "none"\)[\s\S]{0,300}return;/));
check("sw.js: composer.js ضمن قائمة العمل دون اتصال", () =>
  assert.match(sw, /"\.\/js\/composer\.js"/));

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log("\ncomposer-keys: all checks passed");
