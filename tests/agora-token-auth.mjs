/*
 * تفويض توكن Agora (v2.11): لا توكن إلا لطرف في المحادثة التي تُنتج القناة وغير محظور.
 * الدالة تعمل على Deno (لا تُشغَّل هنا)؛ نتحقق من: ترتيب الفحوص، وتطابق بادئة القناة
 * بين الواجهة والدالة، وصحة تحويل اسم القناة إلى معرّف المحادثة (ذهاب وإياب).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`✅ ${name}`); }
  catch (e) { failures += 1; console.log(`❌ ${name}\n   ${e.message.split("\n")[0]}`); }
};

const fn = read("supabase/functions/agora-token/index.ts");
const cfg = read("js/config.js");

check("الدالة تتحقق من المشاركة في المحادثة قبل إصدار التوكن", () => {
  const partIdx = fn.indexOf('.from("conversations")');
  const buildIdx = fn.indexOf("RtcTokenBuilder.buildTokenWithUid(");
  assert.ok(partIdx > 0 && buildIdx > 0, "missing checks");
  assert.ok(partIdx < buildIdx, "participant check must precede token build");
  assert.match(fn, /if \(!participant\) return json\(\{ error: "Forbidden" \}, 403\)/);
});

check("الدالة ترفض المحظورين (is_blocked) وغير الموجودين", () => {
  assert.match(fn, /if \(!me \|\| me\.is_blocked\) return json\(\{ error: "Forbidden" \}, 403\)/);
});

check("الدالة لا تستخدم مفتاح الخدمة (التحقق عبر RLS بعميل المستخدم)", () => {
  assert.doesNotMatch(fn, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(fn, /global: \{ headers: \{ Authorization: authHeader \} \}/);
});

check("بادئة القناة واحدة في الواجهة والدالة (wa)", () => {
  assert.match(cfg, /channelPrefix: "wa"/);
  assert.match(fn, /\^wa_\(\[0-9a-fA-F\]\{32\}\)\$/);
});

check("ذهاب وإياب: اسم القناة ⇒ معرّف المحادثة الأصلي", () => {
  // نفس منطق buildAgoraChannelName في js/config.js
  const build = (id) => `wa_${String(id || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 48)}`;
  // نفس منطق الدالة
  const parse = (channelName) => {
    const m = /^wa_([0-9a-fA-F]{32})$/.exec(String(channelName));
    if (!m) return null;
    const h = m[1].toLowerCase();
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  };
  for (let i = 0; i < 50; i++) {
    const id = crypto.randomUUID();
    assert.equal(parse(build(id)), id);
  }
  assert.equal(parse("wa_short"), null, "قناة قصيرة مرفوضة");
  assert.equal(parse("xx_" + "a".repeat(32)), null, "بادئة غريبة مرفوضة");
});

check("الواجهة تمرّر توكن الجلسة لطلب التوكن", () => {
  const calls = read("js/calls.js");
  assert.match(calls, /Authorization = `Bearer \$\{accessToken\}`/);
});

if (failures) { console.log(`\nFAILED ${failures}`); process.exit(1); }
console.log("\nPASSED agora-token-auth");
