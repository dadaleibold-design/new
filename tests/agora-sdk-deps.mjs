/*
 * اختبار تبعيات Agora RTC (بلا شبكة)
 * -------------------------------------------------------------
 * يضمن أن سلسلة التحميل كاملة ومتطابقة، حتى لا تحدث:
 *   • «Module not found» / تحميل مكتبة بنسخة غير المثبّتة
 *   • تعليق المكالمة بسبب مصدر SDK ميّت أو CORS خاطئ
 *
 *   (1) package.json يثبّت نسخة دقيقة (بلا ^) = package-lock.json = node_modules
 *   (2) js/config.js: AGORA_SDK_VERSION مطابق للحزمة، وكل مصادر CDN تستخدمه
 *       (لا نسخة قديمة مثل 4.20.2 مكتوبة يدوياً)
 *   (3) المصدر المحلي أولاً، ثم مرايا CDN، ولا يُضبط crossOrigin على وسم script
 *   (4) scripts/copy-agora-sdk.mjs موجود، وvercel.json يشغّله قبل البناء
 *   (5) نسخة vendor/ مُستثناة من Git (تُولَّد ولا تُرفع)
 *   (6) الملف المنسوخ (إن وُجد) هو الإصدار المثبّت نفسه وفيه الاسم العام AgoraRTC
 *
 * التشغيل: node tests/agora-sdk-deps.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
const PKG = "agora-rtc-sdk-ng";

let fails = 0;
const check = (name, ok, extra = "") => {
  console.log(ok ? "✅" : "❌", name, extra);
  if (!ok) fails += 1;
};

/* ---------- (1) تثبيت الحزمة ---------- */
const pkg = JSON.parse(read("package.json"));
const pinned = pkg.dependencies?.[PKG];
check("package.json يثبّت agora-rtc-sdk-ng", typeof pinned === "string" && pinned.length > 0, pinned);
check("الإصدار مثبّت بدقة (بلا ^ أو ~)", /^\d+\.\d+\.\d+$/.test(String(pinned)), String(pinned));

const lock = JSON.parse(read("package-lock.json"));
check(
  "package-lock يطابق مواصفة الجذر",
  lock.packages?.[""]?.dependencies?.[PKG] === pinned,
  String(lock.packages?.[""]?.dependencies?.[PKG])
);
check(
  "package-lock يحتوي الإصدار المثبّت نفسه",
  lock.packages?.[`node_modules/${PKG}`]?.version === pinned,
  String(lock.packages?.[`node_modules/${PKG}`]?.version)
);

const installedPkg = path.join(ROOT, "node_modules", PKG, "package.json");
if (fs.existsSync(installedPkg)) {
  const installed = JSON.parse(fs.readFileSync(installedPkg, "utf8")).version;
  check("الحزمة المثبّتة فعلياً تطابق package.json", installed === pinned, `installed=${installed}`);
} else {
  console.log("ℹ️  node_modules غير مثبّت — تخطّي مطابقة الإصدار المثبّت فعلياً (شغّل npm ci)");
}

/* ---------- (2) config.js ---------- */
const config = read("js/config.js");
const verMatch = config.match(/export const AGORA_SDK_VERSION = "([^"]+)"/);
check("config.js يصدّر AGORA_SDK_VERSION", Boolean(verMatch));
check("AGORA_SDK_VERSION = نسخة package.json", verMatch?.[1] === pinned, verMatch?.[1]);
check("لا نسخة قديمة مكتوبة يدوياً (4.20.2)", !/4\.20\.2/.test(config));
check(
  "مرايا CDN تستخدم المتغير لا رقماً ثابتاً",
  /cdn\.jsdelivr\.net\/npm\/agora-rtc-sdk-ng@\$\{AGORA_SDK_VERSION\}/.test(config) &&
    /unpkg\.com\/agora-rtc-sdk-ng@\$\{AGORA_SDK_VERSION\}/.test(config)
);

/* ---------- (3) ترتيب المصادر وسياسة CORS ---------- */
const sdkUrlsBlock = config.slice(config.indexOf("sdkUrls: ["), config.indexOf("],", config.indexOf("sdkUrls: [")));
check(
  "المصدر المحلي أولاً",
  sdkUrlsBlock.indexOf("./vendor/agora/AgoraRTC_N-production.js") !== -1 &&
    sdkUrlsBlock.indexOf("./vendor/agora/AgoraRTC_N-production.js") <
      sdkUrlsBlock.indexOf("cdn.jsdelivr.net")
);

const calls = read("js/calls.js");
const loaderStart = calls.indexOf("function loadSdkFrom(");
const loaderBody = calls.slice(loaderStart, calls.indexOf("function loadAgoraSdk(", loaderStart));
check("وسم script لا يضبط crossOrigin (يُفشل التحميل من CDN بلا CORS)", !/crossOrigin/.test(loaderBody));
check("تحميل SDK يمر عبر AGORA.sdkUrls", /const urls = AGORA\.sdkUrls;/.test(calls));
check("الواجهة لا تستورد الحزمة كوحدة (تُحمَّل كنص عام)", !/from\s+["']agora-rtc-sdk-ng["']/.test(calls));

/* ---------- (4) البناء ---------- */
check("scripts/copy-agora-sdk.mjs موجود", exists("scripts/copy-agora-sdk.mjs"));
const vercel = read("vercel.json");
check(
  "vercel.json يشغّل نسخ SDK قبل توليد env",
  /"buildCommand":\s*"node scripts\/copy-agora-sdk\.mjs && node scripts\/generate-env\.mjs"/.test(vercel)
);
check(
  "postinstall ينسخ SDK بعد npm install",
  typeof pkg.scripts?.postinstall === "string" && pkg.scripts.postinstall.includes("copy-agora-sdk.mjs")
);

/* ---------- (5) Git ---------- */
const gitignore = read(".gitignore");
check("vendor/agora مُستثنى من Git", /^\/vendor\/agora\/\s*$/m.test(gitignore));

/* ---------- (6) الملف المنسوخ (إن وُجد) ---------- */
const vendorFile = path.join(ROOT, "vendor", "agora", "AgoraRTC_N-production.js");
if (fs.existsSync(vendorFile)) {
  const head = fs.readFileSync(vendorFile, "utf8").slice(0, 400);
  check("النسخة المحلية هي الإصدار المثبّت", head.includes(`v${pinned}`) || head.includes(pinned), pinned);
  check("النسخة المحلية تعرّف الاسم العام AgoraRTC", /AgoraRTC/.test(fs.readFileSync(vendorFile, "utf8").slice(0, 2000)));
} else {
  console.log("ℹ️  vendor/agora غير مُنشأ بعد — يُنشأ عند npm install أو npm run vendor:agora");
}

console.log(fails ? `\nFAILED ${fails}` : "\nPASSED agora-sdk-deps");
process.exit(fails ? 1 : 0);
