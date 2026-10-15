/*
 * اختبار آلية حالة الكتابة (Typing Debounce — v2.13) — فحوص ثابتة
 * -------------------------------------------------------------
 * يحمي إصلاح إغراق الشبكة من الانحدار:
 *   • لا طلب مع كل حرف: «يكتب الآن» مرة واحدة عند بدء التدفق + تجديد مقيّد.
 *   • Debounce 3 ثوانٍ: مؤقت توقيف واحد يُلغى بـ clearTimeout ويُعاد مع كل
 *     حرف — لا يُرسل «توقفت عن الكتابة» إلا بعد سكون > 3 ثوانٍ متواصلة.
 *   • cancelTypingTimers تُلغى عند الإرسال/تبديل المحادثة/الإغلاق.
 *   • حارس الالتصاق لدى المستقبِل (إخفاء تلقائي عند انقطاع تحديثات المرسل).
 *   • المؤقت القديم typingTimeout (2 ثانية) أُزيل كلياً.
 *
 * التشغيل: node tests/typing-debounce.mjs
 */
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP = fs.readFileSync(path.join(ROOT, "js/app.js"), "utf8");

let fails = 0;
const check = (name, ok, extra = "") => {
  console.log(ok ? "✅" : "❌", name, extra ? `— ${extra}` : "");
  if (!ok) fails += 1;
};

/* ---------- 1) الثوابت ---------- */
check(
  "مدة السكون (Debounce) = 3000ms كما هو مطلوب",
  /const TYPING_STOP_DEBOUNCE_MS = 3000;/.test(APP),
);
check(
  "تجديد مقيّد أثناء الكتابة المستمرة (TYPING_REFRESH_MS) + حارس الالتصاق (TYPING_STALE_HIDE_MS)",
  /const TYPING_REFRESH_MS = 8000;/.test(APP) && /const TYPING_STALE_HIDE_MS = 12000;/.test(APP),
);

/* ---------- 2) منطق handleTypingInput — لا طلب مع كل حرف ---------- */
const handler = /function handleTypingInput\(\)[\s\S]*?\n}/.exec(APP)?.[0] || "";
check(
  "«يكتب الآن» يُرسل مرة واحدة عند بدء التدفق (حارس state.typingActive — لا setTyping(true) مطلقاً كل حرف)",
  /if \(!state\.typingActive\) \{[\s\S]{0,200}setTyping\(true\);/.test(handler) &&
    !/^setTyping\(true\);/m.test(handler.trim()),
);
check(
  "مؤقت التوقيف يُلغى ويُعاد مع كل حرف (clearTimeout قبل setTimeout)",
  handler.indexOf("clearTimeout(state.typingStopTimeout)") < handler.indexOf("setTimeout(") &&
    /setTimeout\(\(\) => \{[\s\S]*?setTyping\(false\);[\s\S]*?\}, TYPING_STOP_DEBOUNCE_MS\)/.test(handler),
);
check(
  "مؤقت التوقيف يُصفّر الحالة المحلية قبل إرسال التوقيف",
  /state\.typingStopTimeout = null;[\s\S]{0,120}resetTypingLocalState\(\);[\s\S]{0,120}setTyping\(false\);/.test(handler),
);

/* ---------- 3) cancelTypingTimers — إلغاء شامل في كل مسارات الخروج ---------- */
check(
  "cancelTypingTimers تُلغي المؤقتين (توقيف المرسل + إخفاء المستقبِل) وتصفّر الحالة",
  /function cancelTypingTimers\(\) \{\s*\n\s*clearTimeout\(state\.typingStopTimeout\);\s*\n\s*state\.typingStopTimeout = null;\s*\n\s*clearTimeout\(state\.typingHideTimer\);/.test(APP),
);
const cancelCalls = (APP.match(/cancelTypingTimers\(\)/g) || []).length;
check(
  "cancelTypingTimers مستدعاة في 5 مواضع على الأقل (بعد الإرسال/إغلاق المحادثة/تفكيك القنوات/تبديل الاشتراك/التعريف)",
  cancelCalls >= 5,
  `calls=${cancelCalls}`,
);
check(
  "بعد إرسال الرسالة: إلغاء المؤقتات ثم إخفاء الحالة فوراً",
  /cancelTypingTimers\(\);\s*\n\s*await setTyping\(false\);/.test(APP),
);
check(
  "تبديل الاشتراك يلغي مؤقتات المحادثة القديمة قبل تفكيك قنواتها",
  /cancelTypingTimers\(\);\s*\n\s*teardownChannel\("msgChannel"\);\s*\n\s*teardownChannel\("typingChannel"\)/.test(APP),
);

/* ---------- 4) المؤقت القديم (2 ثانية / typingTimeout) أُزيل كلياً ---------- */
check(
  "لا أثر للمؤقت القديم typingTimeout (كان يُرسل true كل حرف)",
  !APP.includes("typingTimeout"),
);
check(
  "لا setTyping(true) مباشر خارج بدء التدفق/التجديد المقيّد",
  (APP.match(/setTyping\(true\)/g) || []).length === 2,
  `occurrences=${(APP.match(/setTyping\(true\)/g) || []).length}`,
);

/* ---------- 5) حارس الالتصاق لدى المستقبِل ---------- */
check(
  "قناة الكتابة تخفي المؤشر تلقائياً بعد انقطاع تحديثات المرسل (typingHideTimer)",
  /clearTimeout\(state\.typingHideTimer\);\s*\n\s*if \(row\.is_typing\) \{\s*\n\s*state\.typingHideTimer = setTimeout\(/.test(APP),
);

/* ---------- 6) حقول الحالة الجديدة ---------- */
check(
  "حقول الحالة: typingStopTimeout/typingActive/typingLastSentAt/typingHideTimer",
  /typingStopTimeout: null,\s*\n\s*typingActive: false,\s*\n\s*typingLastSentAt: 0,\s*\n\s*typingHideTimer: null,/.test(APP),
);

/* ---------- 7) سلامة الصياغة ---------- */
try {
  execFileSync(process.execPath, ["--check", path.join(ROOT, "js/app.js")], { stdio: "pipe" });
  check("js/app.js يمرّ فحص الصياغة (node --check)", true);
} catch {
  check("js/app.js يمرّ فحص الصياغة (node --check)", false);
}

console.log(fails ? `\n❌ TYPING DEBOUNCE TESTS FAILED: ${fails}` : "\nTYPING DEBOUNCE TESTS PASSED");
process.exit(fails ? 1 : 0);
