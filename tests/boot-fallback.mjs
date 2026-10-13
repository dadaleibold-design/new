/*
 * اختبار انحدار: تجمّد التطبيق على شاشة التحميل (Infinite Loading)
 * ----------------------------------------------------------------
 * العطل الأصلي: ملف المصدر js/env.js كان مفقوداً من المستودع (أخفاه
 * نمط `env.js` غير المُرسّى في .gitignore)، ففشل استيراد رسم وحدات
 * js/app.js كاملاً قبل تنفيذ أي سطر — بما فيها معالجات الأخطاء —
 * وبقي #boot-loading ظاهراً إلى الأبد بلا أي رسالة.
 *
 * يفرض هذا الاختبار طبقات الحماية التي تمنع تكراره:
 *   1) js/env.js موجود ومقروء بأمان، و .gitignore لا يخفيه مجدداً.
 *   2) index.html فيه حارس إقلاع مستقل (بلا وحدات) وشاشة فشل صريحة.
 *   3) js/app.js يفرض مهلة على فحص الجلسة ويُعلم الحارس عند الإقلاع.
 *   4) مولّد env.js لا يفشل البناء عند غياب المتغيرات ويكتب ملفاً صالحاً دائماً.
 *
 * التشغيل: node tests/boot-fallback.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let fails = 0;
const check = (name, ok, extra = "") => {
  console.log(ok ? "✅" : "❌", name, extra ? `— ${extra}` : "");
  if (!ok) fails += 1;
};
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

/* 1) طبقة البيئة موجودة ولا يمكن أن يخفيها Git مجدداً */
check("js/env.js موجود (غيابه كان سبب التجمّد)", exists("js/env.js"));

const gitignoreLines = read(".gitignore")
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"));
check(
  ".gitignore يُهمل /env.js المولَّد في الجذر فقط",
  gitignoreLines.includes("/env.js") && !gitignoreLines.includes("env.js"),
  gitignoreLines.filter((line) => line.includes("env.js")).join(" | ")
);

if (exists("js/env.js")) {
  const envModule = read("js/env.js");
  check("js/env.js يحمي قراءة import.meta.env (بلا رمي)", /import\.meta\.env/.test(envModule) && /catch/.test(envModule));
  check("js/env.js يقرأ self.__ENV__ وقت التشغيل", /__ENV__/.test(envModule));

  delete globalThis.__ENV__;
  const emptyEnv = await import("../js/env.js?boot-fallback=empty");
  check(
    "غياب كل المتغيرات يُرصد ولا يرمي",
    emptyEnv.missingEnvKeys().length === 7 && emptyEnv.isSupabaseConfigured() === false,
    emptyEnv.missingEnvKeys().join(", ")
  );
  check("FIREBASE_CONFIG بلا مشروع لا يشتق نطاقات وهمية", emptyEnv.FIREBASE_CONFIG.authDomain === "");
  check("AGORA_TOKEN_ENDPOINT فارغ بلا عنوان Supabase", emptyEnv.AGORA_TOKEN_ENDPOINT === "");
}

/* 2) حارس الإقلاع المستقل في index.html */
const html = read("index.html");
const watchdogIndex = html.indexOf("__WA_MARK_BOOT_OK__");
const appTagIndex = html.indexOf('src="./js/app.js');
check("index.html فيه حارس إقلاع (__WA_MARK_BOOT_OK__)", watchdogIndex !== -1);
check("الحارس يُزرع قبل وحدة التطبيق", watchdogIndex !== -1 && watchdogIndex < appTagIndex);
check("الحارس سكربت كلاسيكي لا وحدة (يعمل حتى عند فشل الوحدات)", /<script>\s*\(function \(\) \{\s*var BOOT_TIMEOUT_MS/.test(html));
check("شاشة فشل إقلاع صريحة مع زر إعادة محاولة", /id="boot-error"/.test(html) && /id="boot-retry"/.test(html));
check("الحارس يُخفي شاشة التحميل عند التدخل", /boot-loading/.test(html.split("__WA_SHOW_BOOT_ERROR__")[1] || ""));

/* 3) تحصين js/app.js */
const app = read("js/app.js");
check("فحص الجلسة الأولية محمي بمهلة", /withTimeout\(\s*supabase\.auth\.getSession\(\)/.test(app));
check("التطبيق يُعلم الحارس عند تولّي الشاشة", /__WA_MARK_BOOT_OK__/.test(app) && /markBootOk\(\)/.test(app));
check("showAuthScreen تُخفي شاشة التحميل دائماً", /function showAuthScreen\(\) \{[^}]*#boot-loading/s.test(app));
check(
  "التهيئات الجانبية عند الاستيراد محميّة بـ try/catch",
  /try \{\s*initNotificationRouter\(\)/.test(app) && /try \{\s*initImageLightbox\(\)/.test(app)
);
check(
  "حالة الوحدة لا تقرأ localStorage مباشرة (قد يرمي عند حظر التخزين)",
  !/lang: localStorage\.getItem/.test(app) && /function readStoredValue/.test(app)
);

/* 4) المولّد: لا فشل بناء ولا ملف تالف عند غياب المتغيرات */
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wa-envgen-"));
  try {
    fs.mkdirSync(path.join(tmp, "scripts"), { recursive: true });
    fs.copyFileSync(path.join(ROOT, "scripts/generate-env.mjs"), path.join(tmp, "scripts/generate-env.mjs"));

    const cleanEnv = { PATH: process.env.PATH || "" };
    const generated = spawnSync(process.execPath, [path.join(tmp, "scripts/generate-env.mjs")], {
      env: cleanEnv,
      encoding: "utf8",
    });
    check("المولّد بلا أي متغيرات ينجح (لا يُسقط نشر Vercel)", generated.status === 0, (generated.stderr || "").trim().split("\n")[0]);

    const outFile = path.join(tmp, "env.js");
    check("المولّد كتب env.js رغم غياب المتغيرات", fs.existsSync(outFile));
    if (fs.existsSync(outFile)) {
      const source = fs.readFileSync(outFile, "utf8");
      const syntax = spawnSync(process.execPath, ["--check", outFile], { encoding: "utf8" });
      check("env.js المولَّد صالح نحوياً", syntax.status === 0);
      check("env.js المولَّد غير فارغ ويضبط self.__ENV__", /self\.__ENV__ = Object\.freeze\(\{/.test(source) && source.includes('"VITE_SUPABASE_URL": ""'));
    }

    const gate = spawnSync(process.execPath, [path.join(tmp, "scripts/generate-env.mjs"), "--check"], {
      env: cleanEnv,
      encoding: "utf8",
    });
    check("وضع --check يبقى بوّابة صارمة عند النقص", gate.status === 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log(fails ? `\n❌ BOOT FALLBACK TESTS FAILED: ${fails}` : "\nBOOT FALLBACK TESTS PASSED");
process.exit(fails ? 1 : 0);
