#!/usr/bin/env node
/* ============================================================
 * scripts/generate-env.mjs — توليد `env.js` من متغيرات البيئة
 * ------------------------------------------------------------
 * لماذا؟ الاستضافة الاستاتيكية (Vercel/Netlify/GitHub Pages) لا تستطيع
 * حقن متغيرات في المتصفح مباشرة، والتطبيق لا يعتمد build step. هذا السكربت
 * يقرأ `.env` (و/أو متغيرات بيئة النظام) ويكتب ملف `env.js` في جذر الموقع
 * الذي يضبط `self.__ENV__` بالأسماء المعتمدة، فيقرأه:
 *      • الصفحة  : وسم <script src="./env.js"> قبل modules
 *      • الـ SW   : عبر importScripts("./env.js")
 *
 * 🔐 لا يُدرِج السكربت أي مفتاح سيرفري (service role / private key /
 *    Agora certificate) — يقتصر على متغيرات الواجهة العامة VITE_*.
 *
 * الاستخدام:
 *      npm run env:generate                 # يقرأ .env ثم بيئة النظام
 *      npm run env:generate -- --check      # تحقّق فقط بلا كتابة
 * ============================================================ */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = path.join(ROOT, ".env");
const OUT_FILE = path.join(ROOT, "env.js");

/** المتغيرات المسموح بتصديرها للواجهة — أسماء Vite حصراً */
const FRONTEND_KEYS = [
  "VITE_SUPABASE_URL",
  "VITE_SUPABASE_ANON_KEY",
  "VITE_FIREBASE_API_KEY",
  "VITE_FIREBASE_PROJECT_ID",
  "VITE_FIREBASE_MESSAGING_SENDER_ID",
  "VITE_FIREBASE_APP_ID",
  "VITE_VAPID_PUBLIC_KEY",
  // إضافي: معرّف Agora العام (غير سرّي)
  "VITE_AGORA_APP_ID",
];

/** مفاتيح سيرفرية ممنوعة تماماً في ملف الواجهة */
const FORBIDDEN_KEYS = [
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_SERVICE_KEY",
  "FIREBASE_PRIVATE_KEY",
  "FIREBASE_SERVICE_ACCOUNT",
  "AGORA_APP_CERTIFICATE",
  "SEND_PUSH_SECRET",
];

/** قارئ `.env` مبسّط (KEY=VALUE، يدعم علامات التنصيص و # للتعليق) */
function parseDotEnv(text) {
  const out = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    let value = line.slice(eq + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    out[key] = value;
  }
  return out;
}

function readEnvFile() {
  if (!fs.existsSync(ENV_FILE)) return { values: {}, exists: false };
  return { values: parseDotEnv(fs.readFileSync(ENV_FILE, "utf8")), exists: true };
}

/**
 * يمنع أي تسريب: يفشل فوراً إذا كان لمفتاح سيرفري **قيمة** في ملف الواجهة.
 * (ذكر الاسم بقيمة فارغة مسموح — `.env` نفسه يُستخدم في
 *  `supabase secrets set --env-file .env` لضبط أسرار الدوال.)
 */
function assertNoServerSecrets(values) {
  const leaked = FORBIDDEN_KEYS.filter((key) => String(values[key] ?? "").trim() !== "");
  if (leaked.length) {
    console.error(
      `❌ رُفض التوليد: متغيرات سيرفرية لا يجوز وضع قيمها في ملف الواجهة: ${leaked.join(", ")}\n` +
        "   اضبطها كأسرار على Supabase فقط (supabase secrets set)."
    );
    process.exit(1);
  }
}

function buildSource(values) {
  const lines = [
    "/* ملف مُولَّد آلياً — لا تُحرّره يدوياً ولا تُضِف أي مفتاح سرّي هنا.",
    " * المصدر: متغيرات البيئة (VITE_*) عبر scripts/generate-env.mjs",
    ` * وقت التوليد: ${new Date().toISOString()}`,
    " * يُستخدَم في المتصفح وفي Service Worker معاً (self === window في الصفحة).",
    " */",
    "self.__ENV__ = Object.freeze({",
  ];

  for (const key of FRONTEND_KEYS) {
    const value = values[key];
    if (!value) continue;
    lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(value)},`);
  }

  lines.push("});");
  lines.push("if (typeof window !== \"undefined\") window.__ENV__ = self.__ENV__;");
  lines.push("");
  return lines.join("\n");
}

function main() {
  const checkOnly = process.argv.includes("--check");
  const { values: fileValues, exists } = readEnvFile();

  // بيئة النظام تسبق الملف (مفيد في CI)
  const values = {};
  for (const key of FRONTEND_KEYS) {
    const fromProcess = process.env[key];
    if (fromProcess) values[key] = fromProcess;
  }
  for (const key of FRONTEND_KEYS) {
    if (!values[key] && fileValues[key]) values[key] = fileValues[key];
  }

  assertNoServerSecrets(fileValues);

  const missing = FRONTEND_KEYS.filter((key) => key !== "VITE_AGORA_APP_ID" && !values[key]);

  if (!exists && !Object.keys(values).length) {
    console.error(
      "❌ لا يوجد ملف .env ولا متغيرات بيئة.\n" +
        "   انسخ .env.example إلى .env ثم املأ القيم، أو صدّرها في بيئة النشر."
    );
    process.exit(1);
  }

  if (checkOnly) {
    console.log(
      missing.length
        ? `⚠️  متغيرات ناقصة: ${missing.join(", ")}`
        : "✅ كل متغيرات الواجهة المطلوبة موجودة."
    );
    process.exit(missing.length ? 1 : 0);
  }

  fs.writeFileSync(OUT_FILE, buildSource(values), "utf8");
  console.log(`✅ تم توليد ${path.relative(ROOT, OUT_FILE)} (${Object.keys(values).length} متغيراً)`);

  if (missing.length) {
    console.warn(`⚠️  متغيرات ناقصة: ${missing.join(", ")}`);
  }
}

main();
