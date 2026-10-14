#!/usr/bin/env node
/* ============================================================
 * scripts/copy-agora-sdk.mjs — نسخ Agora Web SDK من الحزمة المثبّتة
 * ------------------------------------------------------------
 * لماذا؟ التطبيق لا يملك خطوة بناء (Bundler)، وكان يحمّل Agora من CDN خارجي
 * بنسخة (4.20.2) تختلف عن الحزمة المثبّتة في package.json (4.24.8). هذا السكربت
 * يأخذ الملف من node_modules (الحزمة المثبّتة نفسها) ويضعه في
 * vendor/agora/ داخل الموقع، فتحمّله الواجهة من الأصل نفسه أولاً.
 *
 * الأمان في البناء (غير قاتل):
 *   • إن لم تُثبَّت الحزمة، أو اختلف إصدارها عن المُثبَّت في package.json،
 *     نكتب تحذيراً ونخرج بنجاح — والواجهة تعود تلقائياً إلى مرايا CDN.
 *   • لا يُرفع الملف إلى Git (انظر .gitignore: /vendor/agora/).
 *
 * الاستخدام:
 *   npm install            # يُشغّله تلقائياً عبر postinstall
 *   npm run vendor:agora   # يدوياً
 * ============================================================ */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PKG_NAME = "agora-rtc-sdk-ng";
const SDK_FILE = "AgoraRTC_N-production.js";
const SOURCE = path.join(ROOT, "node_modules", PKG_NAME, SDK_FILE);
const SOURCE_PKG = path.join(ROOT, "node_modules", PKG_NAME, "package.json");
const TARGET_DIR = path.join(ROOT, "vendor", "agora");
const TARGET = path.join(TARGET_DIR, SDK_FILE);
const MIN_BYTES = 100 * 1024; // حارس: ملف SDK حقيقي أكبر بكثير من هذا

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function skip(reason) {
  console.warn(`[agora] تخطّي النسخ المحلي: ${reason}`);
  console.warn("[agora] ستعتمد الواجهة على مرايا CDN (من js/config.js).");
  process.exit(0);
}

const pinned = readJson(path.join(ROOT, "package.json")).dependencies?.[PKG_NAME];
if (!pinned) skip(`${PKG_NAME} غير موجود في dependencies`);

if (!fs.existsSync(SOURCE) || !fs.existsSync(SOURCE_PKG)) {
  skip(`الحزمة غير مثبّتة (${path.relative(ROOT, SOURCE)} غير موجود)`);
}

const installed = readJson(SOURCE_PKG).version;
if (installed !== pinned) {
  skip(`الإصدار المثبّت ${installed} لا يطابق package.json (${pinned})`);
}

const size = fs.statSync(SOURCE).size;
if (size < MIN_BYTES) skip(`ملف SDK أصغر من المتوقع (${size} bytes)`);

fs.mkdirSync(TARGET_DIR, { recursive: true });
fs.copyFileSync(SOURCE, TARGET);

const kb = Math.round(size / 1024);
console.log(`[agora] نُسخ ${PKG_NAME}@${installed} إلى vendor/agora/${SDK_FILE} (${kb} KB)`);
