// =========================================================
// js/lightbox.js — عارض الصور بملء الشاشة لمرفقات المحادثة
//
// - يعمل بتفويض الأحداث (Event Delegation) على document، لذا يغطي
//   الصور القديمة والجديدة التي تُضاف ديناميكياً إلى #chat-messages.
// - الإغلاق: زر X، النقر على الخلفية، زر Escape، وزر الرجوع في المتصفح/الجوال.
// - التنزيل: fetch + Blob (مع احتياطي عبر رابط مباشر عند فشل CORS).
// - التكبير/التصغير: عجلة الفأرة، قرص الإصبعين (Pinch)، نقر مزدوج/نقر مزدوج
//   على الجوال، زر +/−، والسحب (Pan) عند التكبير.
// =========================================================

const SELECTOR = "#chat-messages img.msg-attachment";
const MAX_SCALE = 5;
const DOUBLE_TAP_SCALE = 2.5;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_DIST = 30;
const TAP_MOVE_LIMIT = 10;
const HISTORY_FLAG = "waLightbox";

const TEXTS = {
  ar: {
    close: "إغلاق",
    download: "تنزيل الصورة",
    zoom_in: "تكبير",
    zoom_out: "تصغير",
    reset: "إعادة الضبط",
    loading: "جارٍ تحميل الصورة…",
    load_error: "تعذّر تحميل الصورة.",
    download_error: "تعذّر التنزيل المباشر، تم فتح الصورة في تبويب جديد.",
    downloading: "جارٍ التنزيل…",
    image: "صورة",
  },
  en: {
    close: "Close",
    download: "Download image",
    zoom_in: "Zoom in",
    zoom_out: "Zoom out",
    reset: "Reset zoom",
    loading: "Loading image…",
    load_error: "Could not load the image.",
    download_error: "Direct download failed, the image was opened in a new tab.",
    downloading: "Downloading…",
    image: "Image",
  },
};

const ICONS = {
  close: "✕",
  download: "⬇",
  zoom_in: "+",
  zoom_out: "−",
  reset: "⤢",
};

let root = null;
let stage = null;
let img = null;
let spinner = null;
let statusEl = null;
let btnClose = null;
let btnDownload = null;
let btnZoomIn = null;
let btnZoomOut = null;
let btnReset = null;

let isOpen = false;
let pushedHistory = false;
// عند الإغلاق بالزر نستدعي history.back() فيصل حدث popstate لاحقاً؛ نتجاهله
let pendingHistoryBack = false;
let lastFocus = null;
let currentSrc = "";
let currentAlt = "";

// حالة التكبير: الإزاحة بالبكسل داخل الحاوية، والمقياس
let scale = 1;
let tx = 0;
let ty = 0;

// مؤشرات اللمس/الفأرة النشطة
const pointers = new Map();
let gestureStartScale = 1;
let gestureStartDist = 0;
let dragMoved = false;
// عند التقاط المؤشر (setPointerCapture) قد يُوجَّه حدث click إلى الحاوية بدل الصورة،
// لذلك نسجّل من أين بدأت الضغطة نفسها
let pressStartedOnImage = false;
let lastTap = null;

function lang() {
  return document.documentElement.lang === "en" ? "en" : "ar";
}

function t(key) {
  return (TEXTS[lang()] || TEXTS.ar)[key];
}

// ---------------------------------------------------------
// بناء DOM مرة واحدة
// ---------------------------------------------------------
function button(id, icon, labelKey, extraClass = "") {
  const b = document.createElement("button");
  b.type = "button";
  b.id = id;
  b.className = `lightbox-btn ${extraClass}`.trim();
  b.textContent = icon;
  b.dataset.labelKey = labelKey;
  return b;
}

function buildDom() {
  if (root) return;

  root = document.createElement("div");
  root.id = "image-lightbox";
  root.className = "lightbox hidden";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", t("image"));

  const toolbar = document.createElement("div");
  toolbar.className = "lightbox-toolbar";

  const group = document.createElement("div");
  group.className = "lightbox-group";

  btnZoomOut = button("lightbox-zoom-out", ICONS.zoom_out, "zoom_out");
  btnZoomIn = button("lightbox-zoom-in", ICONS.zoom_in, "zoom_in");
  btnReset = button("lightbox-reset", ICONS.reset, "reset");
  group.append(btnZoomOut, btnReset, btnZoomIn);

  btnClose = button("lightbox-close", ICONS.close, "close", "lightbox-close");
  btnDownload = button("lightbox-download", ICONS.download, "download", "lightbox-download");

  // ترتيب RTL/LTR تلقائي: زر الإغلاق في بداية الشريط، والتنزيل في نهايته
  const end = document.createElement("div");
  end.className = "lightbox-group";
  end.append(btnDownload);

  const start = document.createElement("div");
  start.className = "lightbox-group";
  start.append(btnClose);

  toolbar.append(start, group, end);

  stage = document.createElement("div");
  stage.className = "lightbox-stage";

  spinner = document.createElement("div");
  spinner.className = "lightbox-spinner";
  spinner.setAttribute("aria-hidden", "true");

  img = document.createElement("img");
  img.className = "lightbox-img";
  img.alt = "";
  img.draggable = false;
  img.decoding = "async";

  statusEl = document.createElement("div");
  statusEl.className = "lightbox-status";
  statusEl.setAttribute("role", "status");
  statusEl.setAttribute("aria-live", "polite");

  stage.append(spinner, img);
  root.append(toolbar, stage, statusEl);
  document.body.appendChild(root);

  wireDomEvents();
  applyLabels();
}

function applyLabels() {
  root.setAttribute("aria-label", t("image"));
  root.querySelectorAll("[data-label-key]").forEach((b) => {
    const label = t(b.dataset.labelKey);
    b.setAttribute("aria-label", label);
    b.title = label;
  });
}

// ---------------------------------------------------------
// التحكم بالتكبير والإزاحة
// ---------------------------------------------------------
function stageRect() {
  return stage.getBoundingClientRect();
}

function baseSize() {
  // offsetWidth/Height لا يتأثران بـ transform، فهما الحجم الأساسي المعروض
  return { w: img.offsetWidth || 0, h: img.offsetHeight || 0 };
}

// إبقاء الصورة داخل حدود الشاشة قدر الإمكان (لا تُسحب بعيداً عن الحواف)
function clampPan() {
  const { w, h } = baseSize();
  const r = stageRect();
  const maxX = Math.max(0, (w * scale - r.width) / 2);
  const maxY = Math.max(0, (h * scale - r.height) / 2);
  tx = Math.min(maxX, Math.max(-maxX, tx));
  ty = Math.min(maxY, Math.max(-maxY, ty));
}

function render() {
  if (scale <= 1) {
    scale = 1;
    tx = 0;
    ty = 0;
  }
  clampPan();
  img.style.transform = `translate3d(${tx}px, ${ty}px, 0) scale(${scale})`;
  img.classList.toggle("is-zoomed", scale > 1);
  btnZoomIn.disabled = scale >= MAX_SCALE;
  btnZoomOut.disabled = scale <= 1;
  btnReset.disabled = scale === 1 && tx === 0 && ty === 0;
}

// تكبير/تصغير مع إبقاء نقطة (px,py) — بإحداثيات الشاشة — ثابتة تحت الإصبع/المؤشر
function zoomAt(px, py, nextScale) {
  const r = stageRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const s = Math.min(MAX_SCALE, Math.max(1, nextScale));
  const dx = px - cx;
  const dy = py - cy;
  // q = (p - t)/s ثابتة قبل وبعد التغيير ⇒ t' = p - (s'/s)(p - t)
  const ratio = s / scale;
  tx = dx - ratio * (dx - tx);
  ty = dy - ratio * (dy - ty);
  scale = s;
  render();
}

function resetZoom() {
  scale = 1;
  tx = 0;
  ty = 0;
  render();
}

function zoomByButton(factor) {
  const r = stageRect();
  zoomAt(r.left + r.width / 2, r.top + r.height / 2, scale * factor);
}

// ---------------------------------------------------------
// الأحداث: إيماءات، عجلة، نقر مزدوج، لوحة المفاتيح
// ---------------------------------------------------------
function pointerDistance() {
  const [a, b] = [...pointers.values()];
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function pointerMidpoint() {
  const [a, b] = [...pointers.values()];
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function onPointerDown(e) {
  if (!isOpen || (e.target !== img && e.target !== stage)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: Date.now() });
  try { stage.setPointerCapture(e.pointerId); } catch { /* ignore */ }

  if (pointers.size === 1) {
    dragMoved = false;
    pressStartedOnImage = e.target === img;
  } else if (pointers.size === 2) {
    gestureStartScale = scale;
    gestureStartDist = pointerDistance() || 1;
    dragMoved = true; // قرص الإصبعين لا يُعتبر نقرة لإغلاق النافذة
  }
}

function onPointerMove(e) {
  const p = pointers.get(e.pointerId);
  if (!p) return;

  const dx = e.clientX - p.x;
  const dy = e.clientY - p.y;
  p.x = e.clientX;
  p.y = e.clientY;

  if (Math.hypot(e.clientX - p.sx, e.clientY - p.sy) > TAP_MOVE_LIMIT) dragMoved = true;

  if (pointers.size >= 2) {
    // قرص للتكبير/التصغير حول منتصف الإصبعين
    const mid = pointerMidpoint();
    const dist = pointerDistance() || 1;
    zoomAt(mid.x, mid.y, gestureStartScale * (dist / gestureStartDist));
    return;
  }

  if (pointers.size === 1 && scale > 1) {
    // سحب الصورة عند التكبير
    tx += dx;
    ty += dy;
    render();
  }
}

function onPointerUp(e) {
  const p = pointers.get(e.pointerId);
  if (!p) return;
  pointers.delete(e.pointerId);

  // نقرة مزدوجة (لمس أو فأرة): تبديل بين 1× و DOUBLE_TAP_SCALE× عند نقطة النقر
  const isTap = pointers.size === 0 && !dragMoved && Date.now() - p.t < 500;
  if (isTap) {
    const now = Date.now();
    if (
      lastTap &&
      now - lastTap.t < DOUBLE_TAP_MS &&
      Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < DOUBLE_TAP_DIST
    ) {
      lastTap = null;
      if (scale > 1) resetZoom();
      else zoomAt(e.clientX, e.clientY, DOUBLE_TAP_SCALE);
    } else {
      lastTap = { t: now, x: e.clientX, y: e.clientY };
    }
  }
}

function onWheel(e) {
  if (!isOpen) return;
  e.preventDefault();
  const factor = Math.exp(-e.deltaY * 0.0015);
  zoomAt(e.clientX, e.clientY, scale * factor);
}

function onStageClick(e) {
  // النقر على الخلفية (لا على الصورة) يغلق النافذة، إلا إذا كان جزءاً من سحب/قرص
  if (dragMoved) {
    dragMoved = false;
    return;
  }
  if (pressStartedOnImage) return;
  if (e.target === stage || e.target === spinner) closeLightbox();
}

function onKeydown(e) {
  if (!isOpen) return;

  if (e.key === "Escape") {
    e.preventDefault();
    closeLightbox();
    return;
  }

  if (e.key === "+" || e.key === "=") zoomByButton(1.25);
  else if (e.key === "-" || e.key === "_") zoomByButton(0.8);
  else if (e.key === "0") resetZoom();
  else if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown") {
    // تحريك الصورة المكبّرة بالأسهم
    if (scale > 1) {
      const step = 40;
      if (e.key === "ArrowLeft") tx += step;
      if (e.key === "ArrowRight") tx -= step;
      if (e.key === "ArrowUp") ty += step;
      if (e.key === "ArrowDown") ty -= step;
      render();
    }
  } else if (e.key === "Tab") {
    // حبس التركيز داخل النافذة
    const focusables = [...root.querySelectorAll("button:not([disabled])")];
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
}

// فتح الصورة عند الضغط على Enter/Space للوصول من لوحة المفاتيح
function onGlobalKeydownOpen(e) {
  if (isOpen) return;
  if (e.key !== "Enter" && e.key !== " ") return;
  const el = e.target;
  if (el && el.tagName === "IMG" && typeof el.matches === "function" && el.matches(SELECTOR)) {
    e.preventDefault();
    openLightbox(el);
  }
}

function wireDomEvents() {
  stage.addEventListener("pointerdown", onPointerDown);
  stage.addEventListener("pointermove", onPointerMove);
  stage.addEventListener("pointerup", onPointerUp);
  stage.addEventListener("pointercancel", onPointerUp);
  stage.addEventListener("wheel", onWheel, { passive: false });
  stage.addEventListener("click", onStageClick);

  img.addEventListener("load", () => {
    spinner.classList.add("hidden");
    statusEl.textContent = "";
    render();
  });
  img.addEventListener("error", () => {
    spinner.classList.add("hidden");
    statusEl.textContent = t("load_error");
  });

  btnClose.addEventListener("click", closeLightbox);
  btnDownload.addEventListener("click", () => downloadCurrentImage());
  btnZoomIn.addEventListener("click", () => zoomByButton(1.5));
  btnZoomOut.addEventListener("click", () => zoomByButton(1 / 1.5));
  btnReset.addEventListener("click", resetZoom);

  // منع السحب الافتراضي للصورة (ghost image) على الفأرة
  img.addEventListener("dragstart", (e) => e.preventDefault());

  // زر الرجوع في المتصفح/الجوال يغلق النافذة أولاً بدل مغادرة المحادثة
  window.addEventListener("popstate", () => {
    if (pendingHistoryBack) {
      pendingHistoryBack = false;
      return;
    }
    if (!isOpen) return;
    isOpen = false;
    pushedHistory = false; // الرجوع نفسه أزال حالة الـ Lightbox
    hideDom();
  });
}

// ---------------------------------------------------------
// فتح/إغلاق
// ---------------------------------------------------------
function pushHistoryEntry() {
  try {
    const h = window.history;
    if (!h || typeof h.pushState !== "function") return;
    h.pushState({ ...(h.state || {}), [HISTORY_FLAG]: true }, "", window.location.href);
    pushedHistory = true;
  } catch {
    pushedHistory = false;
  }
}

export function openLightbox(sourceImg) {
  const src = sourceImg?.currentSrc || sourceImg?.src;
  if (!src) return;

  buildDom();
  lastFocus = document.activeElement;
  currentSrc = src;
  currentAlt = sourceImg.alt || t("image");

  if (!isOpen) pushHistoryEntry();
  isOpen = true;

  applyLabels();
  resetZoom();
  pointers.clear();
  lastTap = null;

  statusEl.textContent = "";
  spinner.classList.remove("hidden");
  img.alt = currentAlt;
  img.src = src;

  root.classList.remove("hidden");
  document.body.classList.add("lightbox-open");
  btnClose.focus({ preventScroll: true });
}

function hideDom() {
  root.classList.add("hidden");
  document.body.classList.remove("lightbox-open");
  pointers.clear();
  img.removeAttribute("src");
  img.style.transform = "";
  spinner.classList.add("hidden");
  statusEl.textContent = "";
  currentSrc = "";
  if (lastFocus && typeof lastFocus.focus === "function" && document.contains(lastFocus)) {
    lastFocus.focus({ preventScroll: true });
  }
  lastFocus = null;
}

export function closeLightbox() {
  if (!isOpen) return;
  isOpen = false;

  // إزالة حالة الـ Lightbox من السجل إن كانت هي الحالية
  if (pushedHistory) {
    pushedHistory = false;
    try {
      pendingHistoryBack = true;
      window.history.back();
    } catch {
      pendingHistoryBack = false;
    }
  }
  hideDom();
}

export function isLightboxOpen() {
  return isOpen;
}

// ---------------------------------------------------------
// التنزيل
// ---------------------------------------------------------
const MIME_EXT = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
  "image/avif": "avif",
  "image/heic": "heic",
  "image/heif": "heif",
};

function fileNameFromUrl(url) {
  try {
    const { pathname } = new URL(url, window.location.href);
    const last = decodeURIComponent(pathname.split("/").filter(Boolean).pop() || "");
    const clean = last.replace(/[^\p{L}\p{N}._-]+/gu, "_").replace(/^_+|_+$/g, "");
    if (/\.(jpe?g|png|webp|gif|bmp|svg|avif|heic|heif)$/i.test(clean)) return clean;
  } catch { /* ignore */ }
  return "";
}

function resolveFileName(url, mime) {
  const existing = fileNameFromUrl(url);
  if (existing) return existing;
  const ext = MIME_EXT[(mime || "").toLowerCase()] || "jpg";
  return `image-${Date.now()}.${ext}`;
}

function triggerAnchorDownload(href, filename, { newTab = false } = {}) {
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  if (newTab) {
    a.target = "_blank";
    a.rel = "noopener noreferrer";
  }
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function setDownloading(busy) {
  btnDownload.disabled = busy;
  btnDownload.classList.toggle("is-busy", busy);
  if (busy) statusEl.textContent = t("downloading");
}

export async function downloadImageUrl(url) {
  if (!url) return;

  setDownloading(true);
  try {
    // المسار الأساسي: جلب الصورة كـ Blob ثم رابط تنزيل محلي (يعمل مع Supabase وغيره عند توفر CORS)
    const res = await fetch(url, { mode: "cors", credentials: "omit", cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const blob = await res.blob();
    const mime = blob.type || res.headers.get("content-type") || "";
    const objectUrl = URL.createObjectURL(blob);
    triggerAnchorDownload(objectUrl, resolveFileName(url, mime));
    // تأخير الإلغاء ليكتمل التنزيل على متصفحات الجوال
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    statusEl.textContent = "";
  } catch (error) {
    console.warn("[lightbox] fetch download failed, falling back:", error);
    // احتياطي: رابط مباشر مع download attribute (يعمل للروابط نفسها المنشأة)،
    // وإن كان عبر أصل مختلف يفتح الصورة في تبويب جديد ليحفظها المستخدم يدوياً
    const sameOrigin = new URL(url, window.location.href).origin === window.location.origin;
    triggerAnchorDownload(url, resolveFileName(url, ""), { newTab: !sameOrigin });
    if (!sameOrigin) statusEl.textContent = t("download_error");
  } finally {
    if (statusEl.textContent === t("downloading")) statusEl.textContent = "";
    setDownloading(false);
  }
}

function downloadCurrentImage() {
  if (!currentSrc) return;
  downloadImageUrl(currentSrc);
}

// ---------------------------------------------------------
// نقطة الدخول: تفويض الأحداث على الوثيقة كاملة
// ---------------------------------------------------------
let initialized = false;

export function initImageLightbox() {
  if (initialized) return;
  initialized = true;

  document.addEventListener("click", (e) => {
    const target = e.target;
    if (!target || typeof target.closest !== "function") return;
    const image = target.closest(SELECTOR);
    if (!image) return;
    // العارض هو الوجهة المقصودة لنقر الصورة: نمنع أي تنقل لرابط يحيط بها
    e.preventDefault();
    openLightbox(image);
  });

  document.addEventListener("keydown", onKeydown);
  document.addEventListener("keydown", onGlobalKeydownOpen);
}
