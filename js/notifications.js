/* ============================================================
 * js/notifications.js
 * واجهة طلب إذن الإشعارات + دليل تعطيل تحسين البطارية والعمل في الخلفية.
 *
 *  - showPermissionCardIfNeeded(): تعرض بطاقة لطيفة بعد الدخول إن لم يُمنح
 *    الإذن بعد (ولم يرفضه المستخدم نهائياً)، مع تذكير كل 3 أيام كحدّ أقصى.
 *  - openBackgroundHelp(): يفتح دليلاً مفصّلاً حسب نظام التشغيل/المتصفح
 *    (Android/iOS/سطح المكتب) لتعطيل Battery Optimization والسماح بالخلفية.
 *  - ensureNotificationsReady(): تُستدعى عند كل دخول لإعادة تسجيل توكن FCM
 *    بصمت إن كان الإذن ممنوحاً (يعالج انتهاء صلاحية التوكن الذي يُوقف
 *    إشعارات الخلفية بعد فترة).
 * ============================================================ */

import { enablePushNotifications } from "./push.js";

const SNOOZE_KEY = "wa_notif_prompt_snoozed_until";
const SNOOZE_MS = 3 * 24 * 60 * 60 * 1000;
const TOKEN_REFRESH_KEY = "wa_fcm_last_refresh";
const TOKEN_REFRESH_MS = 24 * 60 * 60 * 1000;

const $ = (sel) => document.querySelector(sel);

export function notificationsSupported() {
  return typeof window !== "undefined" && "Notification" in window && "serviceWorker" in navigator;
}

export function detectPlatform() {
  const ua = navigator.userAgent || "";
  const isIOS = /iPhone|iPad|iPod/i.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/i.test(ua);
  const standalone = window.matchMedia?.("(display-mode: standalone)")?.matches || navigator.standalone === true;
  let browser = "other";
  if (/EdgA?\//i.test(ua)) browser = "edge";
  else if (/SamsungBrowser/i.test(ua)) browser = "samsung";
  else if (/OPR|Opera/i.test(ua)) browser = "opera";
  else if (/Firefox/i.test(ua)) browser = "firefox";
  else if (/Chrome|CriOS/i.test(ua)) browser = "chrome";
  else if (/Safari/i.test(ua)) browser = "safari";
  return { isIOS, isAndroid, isDesktop: !isIOS && !isAndroid, standalone, browser };
}

function snoozed() {
  try {
    const until = Number(localStorage.getItem(SNOOZE_KEY) || 0);
    return until > Date.now();
  } catch {
    return false;
  }
}

function snooze() {
  try {
    localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_MS));
  } catch {
    /* تجاهل */
  }
}

function hideCard() {
  $("#notif-permission-card")?.classList.add("hidden");
}

/**
 * تعرض بطاقة طلب الإذن إن لزم.
 * @param {{ userId: string, notify: (msg:string)=>void, onGranted?: ()=>void }} opts
 */
export function showPermissionCardIfNeeded({ userId, notify, onGranted } = {}) {
  if (!notificationsSupported()) return false;
  if (Notification.permission === "granted") return false;
  if (Notification.permission === "denied") {
    // الإذن مرفوض على مستوى المتصفح — لا يمكن طلبه برمجياً؛ نكتفي بالدليل عند الطلب
    return false;
  }
  if (snoozed()) return false;

  const card = $("#notif-permission-card");
  if (!card) return false;

  card.classList.remove("hidden");

  const allowBtn = $("#notif-permission-allow");
  const laterBtn = $("#notif-permission-later");

  if (allowBtn && !allowBtn.dataset.wired) {
    allowBtn.dataset.wired = "1";
    allowBtn.addEventListener("click", async () => {
      allowBtn.disabled = true;
      allowBtn.textContent = "...";
      const ok = await enablePushNotifications(userId);
      allowBtn.disabled = false;
      allowBtn.textContent = "تفعيل";
      hideCard();
      if (ok) {
        try {
          localStorage.setItem(TOKEN_REFRESH_KEY, String(Date.now()));
        } catch {
          /* تجاهل */
        }
        notify?.("تم تفعيل الإشعارات ✅");
        onGranted?.();
        // على أندرويد نعرض دليل البطارية مباشرة بعد التفعيل — أهم خطوة لضمان الوصول
        const p = detectPlatform();
        if (p.isAndroid) setTimeout(() => openBackgroundHelp(), 600);
      } else if (Notification.permission === "denied") {
        notify?.("تم رفض الإذن — يمكنك تفعيله من إعدادات الموقع في المتصفح.");
      } else {
        notify?.("تعذّر تفعيل الإشعارات — تحقق من الاتصال ثم أعد المحاولة من الإعدادات.");
      }
    });
  }

  if (laterBtn && !laterBtn.dataset.wired) {
    laterBtn.dataset.wired = "1";
    laterBtn.addEventListener("click", () => {
      snooze();
      hideCard();
    });
  }

  return true;
}

/**
 * عند الدخول والإذن ممنوح: جدّد توكن FCM بصمت مرة يومياً على الأكثر.
 * انتهاء التوكن (أو مسح بيانات الـ SW) هو أشهر سبب لتوقف إشعارات الخلفية.
 */
export async function ensureNotificationsReady(userId) {
  if (!notificationsSupported() || !userId) return false;
  if (Notification.permission !== "granted") return false;

  let last = 0;
  try {
    last = Number(localStorage.getItem(TOKEN_REFRESH_KEY) || 0);
  } catch {
    /* تجاهل */
  }
  const hasToken = Boolean(localStorage.getItem("fcm_token"));
  if (hasToken && Date.now() - last < TOKEN_REFRESH_MS) return true;

  const ok = await enablePushNotifications(userId);
  if (ok) {
    try {
      localStorage.setItem(TOKEN_REFRESH_KEY, String(Date.now()));
    } catch {
      /* تجاهل */
    }
  }
  return ok;
}

/* ------------------------------------------------------------
 * دليل الخلفية / تحسين البطارية
 * ---------------------------------------------------------- */
function step(title, items) {
  return `<section class="bg-help-section"><h3>${title}</h3><ol>${items
    .map((i) => `<li>${i}</li>`)
    .join("")}</ol></section>`;
}

function buildHelpHtml() {
  const p = detectPlatform();
  const permission = notificationsSupported() ? Notification.permission : "unsupported";

  const statusLabel =
    permission === "granted"
      ? '<span class="bg-help-status ok">✅ إذن الإشعارات ممنوح</span>'
      : permission === "denied"
        ? '<span class="bg-help-status bad">⛔ إذن الإشعارات مرفوض — فعّله من إعدادات الموقع</span>'
        : permission === "unsupported"
          ? '<span class="bg-help-status bad">هذا المتصفح لا يدعم الإشعارات</span>'
          : '<span class="bg-help-status warn">⚠️ لم يُطلب إذن الإشعارات بعد</span>';

  const sections = [];

  if (p.isAndroid) {
    sections.push(
      step("1) تثبيت التطبيق على الشاشة الرئيسية (مهم)", [
        "من قائمة المتصفح ⋮ اختر <b>إضافة إلى الشاشة الرئيسية</b> أو <b>تثبيت التطبيق</b>.",
        "افتح التطبيق من أيقونته بدل المتصفح — التطبيقات المثبّتة تحصل على أولوية أعلى في الخلفية.",
      ])
    );
    sections.push(
      step("2) تعطيل تحسين البطارية للمتصفح", [
        "الإعدادات ← <b>التطبيقات</b> ← اختر متصفحك (Chrome / Samsung Internet).",
        "<b>البطارية</b> ← اختر <b>غير مقيّد</b> (Unrestricted) بدل «محسّن».",
        "الإعدادات ← <b>البطارية</b> ← <b>تحسين البطارية</b> ← كل التطبيقات ← متصفحك ← <b>عدم التحسين</b>.",
        "على أجهزة Xiaomi/Huawei/Oppo/Vivo: فعّل أيضاً <b>التشغيل التلقائي (Autostart)</b> و<b>قفل التطبيق في التطبيقات الأخيرة</b>.",
      ])
    );
    sections.push(
      step("3) السماح بالعمل في الخلفية", [
        "الإعدادات ← التطبيقات ← متصفحك ← <b>بيانات الجوال</b> ← فعّل <b>السماح باستخدام البيانات في الخلفية</b>.",
        "الإعدادات ← التطبيقات ← متصفحك ← <b>الإشعارات</b> ← تأكد أن الإشعارات مفعّلة وأن قناة الموقع غير صامتة.",
        "عطّل <b>وضع توفير الطاقة</b> أو استثنِ المتصفح منه.",
      ])
    );
    if (p.browser === "samsung") {
      sections.push(
        step("Samsung Internet", [
          "إعدادات الجهاز ← العناية بالجهاز ← البطارية ← <b>حدود استخدام الخلفية</b> ← تأكد أن المتصفح ليس في «التطبيقات النائمة» أو «النائمة بعمق».",
        ])
      );
    }
  } else if (p.isIOS) {
    sections.push(
      step("iPhone / iPad (iOS 16.4 أو أحدث)", [
        p.standalone
          ? "✅ التطبيق مثبّت على الشاشة الرئيسية."
          : "افتح الموقع في <b>Safari</b> ← زر المشاركة ← <b>إضافة إلى الشاشة الرئيسية</b>. الإشعارات على iOS تعمل فقط من التطبيق المثبّت.",
        "افتح التطبيق من الشاشة الرئيسية ثم فعّل الإشعارات من داخله.",
        "الإعدادات ← <b>الإشعارات</b> ← اسم التطبيق ← فعّل <b>السماح بالإشعارات</b> والشارات والأصوات.",
        "الإعدادات ← <b>البطارية</b> ← عطّل <b>نمط الطاقة المنخفضة</b> (يؤخّر الإشعارات).",
        "الإعدادات ← <b>عام</b> ← <b>تحديث التطبيقات في الخلفية</b> ← فعّله لـ Safari.",
        "الإعدادات ← <b>التركيز</b> ← تأكد أن «عدم الإزعاج» لا يحجب التطبيق.",
      ])
    );
  } else {
    sections.push(
      step("سطح المكتب (Windows / macOS / Linux)", [
        "اضغط على أيقونة القفل 🔒 بجانب العنوان ← <b>الإشعارات</b> ← <b>السماح</b>.",
        "ثبّت التطبيق: من شريط العنوان اختر أيقونة <b>التثبيت</b> ⤓ حتى يعمل كنافذة مستقلة ويبقى في الخلفية.",
        "Windows: الإعدادات ← النظام ← الإشعارات ← تأكد أن متصفحك مسموح له، وعطّل <b>مساعد التركيز</b> عند الحاجة.",
        "macOS: تفضيلات النظام ← الإشعارات ← متصفحك ← السماح، وعطّل <b>عدم الإزعاج</b>.",
        "Chrome/Edge: الإعدادات ← النظام ← فعّل <b>متابعة تشغيل التطبيقات في الخلفية عند إغلاق المتصفح</b>.",
      ])
    );
  }

  sections.push(
    step("اختبار سريع", [
      "أغلق التطبيق تماماً واطلب من شخص إرسال رسالة أو الاتصال بك.",
      "إن لم يصل الإشعار خلال ثوانٍ: أعد فتح التطبيق ← الإعدادات ⚙️ ← <b>تفعيل إشعارات الجهاز</b> مرة أخرى لتجديد التوكن.",
    ])
  );

  return `<p class="bg-help-intro">${statusLabel}</p>${sections.join("")}`;
}

export function openBackgroundHelp() {
  const modal = $("#background-help-modal");
  const body = $("#background-help-body");
  if (!modal || !body) return;
  body.innerHTML = buildHelpHtml();
  modal.classList.remove("hidden");
}

export function closeBackgroundHelp() {
  $("#background-help-modal")?.classList.add("hidden");
}

export function wireBackgroundHelp() {
  $("#close-background-help")?.addEventListener("click", closeBackgroundHelp);
  $("#background-help-modal")?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeBackgroundHelp();
  });
}
