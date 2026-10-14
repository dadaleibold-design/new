/*
 * اختبار تنظيف المفاتيح ومتغيرات البيئة (Frontend + Edge Functions)
 * ----------------------------------------------------------------
 * يمنع رجوع أي مفتاح/سرّ ثابت إلى الكود، ويفرض الأسماء المعتمدة حصراً:
 *   الواجهة  : import.meta.env.VITE_*  (عبر js/env.js)
 *   الدوال   : Deno.env.get("...")     (SEND_PUSH_SECRET / FIREBASE_* / AGORA_*)
 *
 * التشغيل: node tests/env-config.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let fails = 0;
const check = (name, ok, extra = "") => {
  console.log(ok ? "✅" : "❌", name, extra ? `— ${extra}` : "");
  if (!ok) fails += 1;
};
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

/* ------------------------------------------------------------------
 * 1) لا قيم مسرّبة معروفة في أي ملف مصدري (كانت ثابتة قبل التنظيف)
 * ---------------------------------------------------------------- */
const LEAKED_LITERALS = [
  ["Supabase project ref", "gqocavvhhfwgkzscrjms"],
  ["Firebase API key", "AIzaSyDeg6RBNC9bWw1QYxBkYtCuMMFPBzxpw4o"],
  ["Firebase project id", "studio-6422025604-b97aa"],
  ["Firebase sender id", "599267399266"],
  ["Firebase app id", "1:599267399266:web:4cd19dbf69068019f5e33b"],
  ["Agora app id", "c72cf98bdff64feebd17688f95764943"],
  ["VAPID public key", "BGKcsJH4YH7vV384UCmx_FKD0xGiWTNuMA7skLLUWzIodKXTSFLRleq1K0ttPMnXZfzQO42bQig8nSKTSIw1jts"],
  ["Supabase anon key head", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdxb2NhdnZoaGZ3Z2t6c2Nyam1zIl0"],
  ["Admin email list", "almgawell17@gmail.com"],
];

/** الملفات المصدريّة الواجب خلوّها + الاستثناءات الموثّقة */
const SOURCE_FILES = [
  "index.html",
  "sw.js",
  "manifest.json",
  "firebase-messaging-sw.js",
  "js/app.js",
  "js/auth.js",
  "js/call-media.js",
  "js/calls.js",
  "js/config.js",
  "js/db.js",
  "js/env.js",
  "js/i18n.js",
  "js/lightbox.js",
  "js/media.js",
  "js/notifications.js",
  "js/notification-router.js",
  "js/notification-scope.js",
  "js/push-policy.js",
  "js/push.js",
  "js/realtime.js",
  "js/ringtone.js",
  "js/safety.js",
  "js/supabaseClient.js",
  "supabase/functions/send-push/index.ts",
  "supabase/functions/agora-token/index.ts",
  "scripts/generate-env.mjs",
  "scripts/copy-agora-sdk.mjs",
];

for (const [label, literal] of LEAKED_LITERALS) {
  const hits = SOURCE_FILES.filter((rel) => exists(rel) && read(rel).includes(literal));
  // قائمة المشرفين مسموحة في SQL فقط (قرار قاعدة البيانات)، لا في الكود
  check(`لا يوجد «${label}» في ملفات المصدر`, hits.length === 0, hits.join(", "));
}

/* ------------------------------------------------------------------
 * 2) الواجهة: القراءة من import.meta.env بالأسماء المعتمدة حصراً
 * ---------------------------------------------------------------- */
const REQUIRED_VITE = [
  "VITE_SUPABASE_URL",
  "VITE_SUPABASE_ANON_KEY",
  "VITE_FIREBASE_API_KEY",
  "VITE_FIREBASE_PROJECT_ID",
  "VITE_FIREBASE_MESSAGING_SENDER_ID",
  "VITE_FIREBASE_APP_ID",
  "VITE_VAPID_PUBLIC_KEY",
];

const envModule = read("js/env.js");

check("js/env.js يقرأ import.meta.env", /import\.meta\.env/.test(envModule));
check("js/env.js يعمل أيضاً وقت التشغيل (self.__ENV__)", /__ENV__/.test(envModule));

for (const key of REQUIRED_VITE) {
  check(`الواجهة تقرأ ${key}`, envModule.includes(`"${key}"`));
}

// لا مفتاح يُقرأ من localStorage/كائن ثابت باسم مغاير
const hardcodedInEnvModule = /["'](?:https:\/\/[a-z0-9-]+\.supabase\.co|AIza[0-9A-Za-z_-]{8,})["']/.test(envModule);
check("js/env.js بلا أي رابط/مفتاح ثابت", !hardcodedInEnvModule);

/* ------------------------------------------------------------------
 * 3) ممنوعات الواجهة: مفاتيح السيرفر لا تظهر في أي ملف يُقدَّم للمتصفح
 * ---------------------------------------------------------------- */
// الملفات التي تُقدَّم للمتصفح فعلياً (بدون الدوال والسكربتات المساعدة).
// يُستثنى المولّد لأنه يحمل قائمة الحماية نفسها (FORBIDDEN_KEYS) عن قصد.
const FRONTEND_FILES = SOURCE_FILES.filter(
  (rel) => !rel.startsWith("supabase/") && !rel.startsWith("scripts/")
);

const FORBIDDEN_IN_FRONTEND = [
  "SUPABASE_SERVICE_ROLE_KEY",
  "SERVICE_ROLE_KEY",
  "FIREBASE_PRIVATE_KEY",
  "FIREBASE_SERVICE_ACCOUNT",
  "FIREBASE_CLIENT_EMAIL",
  "AGORA_APP_CERTIFICATE",
  "SEND_PUSH_SECRET",
  "SEND_PUSH_URL",
];

/** يزيل تعليقات JS/TS/HTML حتى لا يُحتسب ذكر الاسم في التوثيق */
function stripComments(code) {
  return String(code)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1 ");
}

const QUOTE_CHARS = "[\"'`]";

/**
 * يبحث عن «استخدام فعلي» لمفتاح سيرفري في الواجهة — لا ذكرٌ في نصّ توجيهي.
 * الأنماط المحظورة: إسناد قيمة، أو تسريب عبر متغير Vite، أو قراءة Deno.env.
 */
function findSecretUsage(code, secret) {
  const name = secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(name + "\\s*[:=]\\s*" + QUOTE_CHARS + "[^\"'`]+" + QUOTE_CHARS),
    new RegExp("VITE_" + name),
    new RegExp("Deno\\.env\\.get\\(\\s*" + QUOTE_CHARS + name + QUOTE_CHARS),
    new RegExp("localStorage\\.(?:get|set)Item\\(\\s*" + QUOTE_CHARS + name + QUOTE_CHARS),
  ];
  return patterns.some((re) => re.test(code));
}

for (const secret of FORBIDDEN_IN_FRONTEND) {
  const hits = FRONTEND_FILES.filter(
    (rel) => exists(rel) && findSecretUsage(stripComments(read(rel)), secret)
  );
  check(`مفتاح سيرفري «${secret}» لا يُستخدم في كود الواجهة`, hits.length === 0, hits.join(", "));
}

check(
  "لا قراءة لأسرار Deno.env في أي ملف واجهة",
  FRONTEND_FILES.every((rel) => !exists(rel) || !/Deno\.env\.get\(/.test(stripComments(read(rel))))
);

/* ------------------------------------------------------------------
 * 4) Service Worker: الإعداد من env.js لا من قيم ثابتة
 * ---------------------------------------------------------------- */
const sw = read("firebase-messaging-sw.js");
check("SW يقرأ env.js عبر importScripts", /importScripts\(\s*["'][^"']*env\.js["']\s*\)/.test(sw));
check("SW يبني الإعداد من ENV.VITE_FIREBASE_*", /ENV\.VITE_FIREBASE_API_KEY/.test(sw));
check("SW لا يهيّئ Firebase بلا إعدادات", /firebaseReady\s*&&\s*isFirebaseConfigured/.test(sw));

/* ------------------------------------------------------------------
 * 5) index.html: env.js يُحمَّل قبل وحدات التطبيق + شاشة الإعداد
 * ---------------------------------------------------------------- */
const html = read("index.html");
const envTagIndex = html.indexOf('src="./env.js"');
const appTagIndex = html.indexOf('src="./js/app.js');
check("index.html يحمّل env.js", envTagIndex !== -1);
check("env.js قبل app.js في الصفحة", envTagIndex !== -1 && envTagIndex < appTagIndex);
check("index.html فيه شاشة إعداد البيئة", /id="config-error"/.test(html));
check("لا مفاتيح مضمنة في index.html", !/AIza|eyJ[A-Za-z0-9_-]{10,}/.test(html));

/* ------------------------------------------------------------------
 * 6) Edge Functions: Deno.env.get بالأسماء المعتمدة + معالجة \n
 * ---------------------------------------------------------------- */
const sendPush = read("supabase/functions/send-push/index.ts");
const agora = read("supabase/functions/agora-token/index.ts");

for (const key of [
  "FIREBASE_SERVICE_ACCOUNT",
  "FIREBASE_PROJECT_ID",
  "FIREBASE_CLIENT_EMAIL",
  "FIREBASE_PRIVATE_KEY",
  "SEND_PUSH_SECRET",
]) {
  check(`send-push يقرأ ${key} من Deno.env`, sendPush.includes(`Deno.env.get("${key}")`));
}

for (const key of ["AGORA_APP_ID", "AGORA_APP_CERTIFICATE"]) {
  check(`agora-token يقرأ ${key} من Deno.env`, agora.includes(`Deno.env.get("${key}")`));
}

// معالجة السطر الجديد في المفتاح الخاص: تحويل \\n المُهرَّبة إلى أسطر حقيقية
const normalizeMatch = sendPush.match(/function normalizePrivateKey[\s\S]*?\n}/);
check("send-push يعالج \\n في FIREBASE_PRIVATE_KEY", Boolean(normalizeMatch));

if (normalizeMatch) {
  // فحص سلوكي فعلي: نبني الدالة من تعبير replace الموجود في الملف نفسه
  // (نتجاهل صياغة TypeScript التي لا يفهمها Node).
  const body = normalizeMatch[0];
  const replaceCall = body.match(/key\.replace\((\/.*?\/[a-z]*)\s*,\s*("(?:[^"\\]|\\.)*")\)/);

  check("وجدنا تعبير replace لمفتاح Firebase", Boolean(replaceCall), body.slice(-60));

  if (replaceCall) {
    const applyReplace = new Function("key", `return key.replace(${replaceCall[1]}, ${replaceCall[2]});`);
    const escaped = "-----BEGIN PRIVATE KEY-----\\nMIIabc\\n-----END PRIVATE KEY-----\\n";
    const real = applyReplace(escaped);

    check(
      "المفتاح الخاص يُحوَّل إلى أسطر حقيقية",
      !real.includes("\\n") && real.split("\n").length >= 4,
      JSON.stringify(real)
    );
    check("المفتاح السليم يبقى كما هو", applyReplace("line1\nline2") === "line1\nline2");
  }

  check("الدالة تُرجع undefined للمفتاح الفارغ", /if \(!key\) return undefined/.test(body));
}

check("send-push يدعم FIREBASE_SERVICE_ACCOUNT (JSON كامل)", /loadServiceAccount\(\)/.test(sendPush));
check("لا يوجد مفتاح خاص مكتوب في أي دالة", !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(sendPush + agora));

/* ------------------------------------------------------------------
 * 7) .env.example: الأسماء المطلوبة فقط وبلا أي قيمة حقيقية
 * ---------------------------------------------------------------- */
const example = read(".env.example");
const requiredNames = [
  ...REQUIRED_VITE,
  "VITE_AGORA_APP_ID", // إضافي/اختياري: معرّف Agora العام في الواجهة
  "FIREBASE_SERVICE_ACCOUNT",
  "FIREBASE_PROJECT_ID",
  "FIREBASE_CLIENT_EMAIL",
  "FIREBASE_PRIVATE_KEY",
  "SEND_PUSH_SECRET",
  "SEND_PUSH_URL",
  "AGORA_APP_ID",
  "AGORA_APP_CERTIFICATE",
];

for (const name of requiredNames) {
  check(`.env.example يوثّق ${name}`, example.includes(name));
}

const assignments = example
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#") && line.includes("="));

check(
  ".env.example بلا أي قيمة حقيقية",
  assignments.every((line) => line.split("=")[1].trim() === ""),
  assignments.filter((line) => line.split("=")[1].trim() !== "").join(" | ")
);
check(
  "أسماء .env.example ضمن القائمة المعتمدة",
  assignments.every((line) => requiredNames.includes(line.split("=")[0].trim())),
  assignments
    .map((line) => line.split("=")[0].trim())
    .filter((name) => !requiredNames.includes(name))
    .join(", ")
);

/* ------------------------------------------------------------------
 * 8) مولّد env.js: يرفض الأسرار السيرفرية ولا يكتب إلا VITE_*
 * ---------------------------------------------------------------- */
const generator = read("scripts/generate-env.mjs");
check("المولّد يرفض المفاتيح السيرفرية", /FORBIDDEN_KEYS/.test(generator));
check("المولّد يكتب self.__ENV__ فقط", /self\.__ENV__\s*=\s*Object\.freeze/.test(generator));
check("env.js غير مُتتبَّع في Git", read(".gitignore").includes("env.js"));
check("الملفات القديمة أُزيلت من المستودع", !exists("main.zip") && !exists("--main"));

/* ------------------------------------------------------------------
 * 9) سلوك طبقة البيئة: Vite ← وقت التشغيل ← شاشة الإعداد
 * ---------------------------------------------------------------- */
{
  const FULL_ENV = {
    VITE_SUPABASE_URL: "https://example.supabase.co",
    VITE_SUPABASE_ANON_KEY: "anon-key",
    VITE_FIREBASE_API_KEY: "api-key",
    VITE_FIREBASE_PROJECT_ID: "demo-project",
    VITE_FIREBASE_MESSAGING_SENDER_ID: "1234567890",
    VITE_FIREBASE_APP_ID: "1:1234567890:web:abcdef",
    VITE_VAPID_PUBLIC_KEY: "vapid-key",
  };

  // (أ) إعداد ناقص: يجب أن يفشل التهيئة برسالة تسمّي المتغير الناقص
  // (نُحاكي وجود مكتبة CDN؛ سبب الفشل الحقيقي هو نقص المتغيرات لا غياب المكتبة)
  globalThis.__ENV__ = { VITE_SUPABASE_URL: FULL_ENV.VITE_SUPABASE_URL };
  globalThis.supabase = { createClient: () => ({ auth: {} }) };

  const clientModule = await import("../js/supabaseClient.js");
  check("عميل Supabase يبلغ عن الإعداد الناقص", clientModule.supabase === null);
  check(
    "رسالة الإعداد تسمّي المتغير الناقص",
    /VITE_SUPABASE_ANON_KEY/.test(clientModule.supabaseInitError || ""),
    clientModule.supabaseInitError || ""
  );
  check("isSupabaseReady تنفي الجاهزية عند نقص الإعداد", clientModule.isSupabaseReady() === false);

  delete globalThis.supabase;

  const missingEnv = await import("../js/env.js?limited=1");
  const missing = missingEnv.missingEnvKeys();
  check("رصد المتغيرات الناقصة", missing.includes("VITE_SUPABASE_ANON_KEY") && missing.length === 6, missing.join(", "));
  check("isSupabaseConfigured تفشل مع نقص المفتاح", missingEnv.isSupabaseConfigured() === false);

  // (ب) إعداد كامل: القيم تُقرأ من وقت التشغيل وتُشتق الروابط المشتقة
  globalThis.__ENV__ = { ...FULL_ENV };
  const env = await import("../js/env.js?full=1");
  const snapshot = env.readEnvSnapshot();

  check("طبقة البيئة تقرأ قيم وقت التشغيل", snapshot.VITE_SUPABASE_URL === FULL_ENV.VITE_SUPABASE_URL);
  check("لا متغيرات ناقصة عند اكتمال الإعداد", env.missingEnvKeys().length === 0, env.missingEnvKeys().join(", "));
  check("isSupabaseConfigured صحيحة", env.isSupabaseConfigured() === true);
  check("isFirebaseConfigured صحيحة", env.isFirebaseConfigured() === true);
  check(
    "authDomain مشتق من معرّف المشروع",
    env.FIREBASE_CONFIG.authDomain === "demo-project.firebaseapp.com",
    env.FIREBASE_CONFIG.authDomain
  );
  check(
    "نقطة نهاية Agora مشتقة من SUPABASE_URL",
    env.AGORA_TOKEN_ENDPOINT === "https://example.supabase.co/functions/v1/agora-token",
    env.AGORA_TOKEN_ENDPOINT
  );
  check("لا مفتاح VAPID ثابت في طبقة البيئة", env.VAPID_PUBLIC_KEY === FULL_ENV.VITE_VAPID_PUBLIC_KEY);

  delete globalThis.__ENV__;
}

console.log(fails ? `\n❌ ENV CONFIG TESTS FAILED: ${fails}` : "\nENV CONFIG TESTS PASSED");
process.exit(fails ? 1 : 0);
