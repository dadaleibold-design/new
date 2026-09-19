/* ============================================================
 * js/media.js
 * ضغط وتحسين الوسائط قبل رفعها إلى Supabase Storage.
 *
 * الأهداف:
 *   - تقليل حجم الملف المرفوع (توفير حزمة الإنترنت وتكلفة التخزين).
 *   - تقليل استهلاك الذاكرة أثناء المعالجة (تحرير الموارد فوراً).
 *   - الفشل الآمن: إن تعذّر الضغط لأي سبب يُرجَع الملف الأصلي كما هو
 *     بدلاً من إيقاف عملية الإرسال.
 * ============================================================ */

import { MEDIA_LIMITS } from "./config.js";

/** أنواع الصور التي لا يجب ضغطها (فقدان الحركة / الشفافية المتجهة) */
const NON_COMPRESSIBLE_IMAGE_TYPES = new Set([
  "image/gif",
  "image/svg+xml",
  "image/avif",
  "image/heic",
  "image/heif",
]);

let webpSupportCache = null;

/** هل يدعم المتصفح تصدير WebP من Canvas؟ (أفضل ضغطاً من JPEG بـ 25‑35%) */
function supportsWebpExport() {
  if (webpSupportCache !== null) return webpSupportCache;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    webpSupportCache = canvas.toDataURL("image/webp").startsWith("data:image/webp");
  } catch {
    webpSupportCache = false;
  }
  return webpSupportCache;
}

export function isImageFile(file) {
  return Boolean(file && typeof file.type === "string" && file.type.startsWith("image/"));
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * تحميل الصورة إلى مصدر قابل للرسم مع تفضيل createImageBitmap
 * لأنه يعمل خارج الـ main thread ويستهلك ذاكرة أقل بكثير من <img>.
 */
async function decodeImage(file) {
  if (typeof createImageBitmap === "function") {
    try {
      // imageOrientation يضمن احترام EXIF (صور الجوال المقلوبة)
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        release: () => {
          try {
            bitmap.close?.();
          } catch {
            /* تجاهل */
          }
        },
      };
    } catch {
      /* المتصفح لا يدعم الخيارات — نكمل بالطريقة التقليدية */
    }
  }

  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.decoding = "async";
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("تعذّر قراءة الصورة"));
      el.src = url;
    });

    return {
      source: img,
      width: img.naturalWidth || img.width,
      height: img.naturalHeight || img.height,
      release: () => URL.revokeObjectURL(url),
    };
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
}

/** احسب الأبعاد النهائية مع الحفاظ على نسبة العرض للارتفاع */
function fitWithin(width, height, maxWidth, maxHeight) {
  if (width <= maxWidth && height <= maxHeight) {
    return { width, height, resized: false };
  }
  const ratio = Math.min(maxWidth / width, maxHeight / height);
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
    resized: true,
  };
}

/** ارسم على canvas (يُفضَّل OffscreenCanvas لتقليل ضغط الـ DOM) */
function createCanvas(width, height) {
  if (typeof OffscreenCanvas === "function") {
    try {
      return new OffscreenCanvas(width, height);
    } catch {
      /* fallback */
    }
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

async function canvasToBlob(canvas, mimeType, quality) {
  if (typeof canvas.convertToBlob === "function") {
    return canvas.convertToBlob({ type: mimeType, quality });
  }
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), mimeType, quality);
    } catch {
      resolve(null);
    }
  });
}

/** حرّر ذاكرة الـ canvas صراحةً (مهم جداً على iOS Safari) */
function releaseCanvas(canvas) {
  try {
    canvas.width = 0;
    canvas.height = 0;
  } catch {
    /* تجاهل */
  }
}

/**
 * يضغط ملف صورة ويُرجع كائناً موحّداً:
 *   { file, changed, originalSize, size, width, height, extension, contentType }
 * لا يرمي استثناءً أبداً — يرجع الأصل عند أي فشل.
 */
export async function compressImageFile(file, options = {}) {
  const result = {
    file,
    changed: false,
    originalSize: file?.size || 0,
    size: file?.size || 0,
    width: null,
    height: null,
    extension: null,
    contentType: file?.type || "application/octet-stream",
  };

  if (!isImageFile(file)) return result;

  // GIF/SVG وغيرها: الضغط يفسدها أو لا يفيد
  if (NON_COMPRESSIBLE_IMAGE_TYPES.has(file.type.toLowerCase())) return result;

  const minSize = options.skipUnderBytes ?? MEDIA_LIMITS.skipCompressionUnderBytes;
  if (file.size && file.size < minSize) return result;

  const maxWidth = options.maxWidth ?? MEDIA_LIMITS.imageMaxWidth;
  const maxHeight = options.maxHeight ?? MEDIA_LIMITS.imageMaxHeight;
  const quality = options.quality ?? MEDIA_LIMITS.imageQuality;

  let decoded = null;
  let canvas = null;

  try {
    decoded = await decodeImage(file);

    if (!decoded.width || !decoded.height) return result;

    const target = fitWithin(decoded.width, decoded.height, maxWidth, maxHeight);

    // ضع الشفافية في الحسبان: PNG بشفافية يُصدَّر WebP/PNG، غير ذلك JPEG
    const preferWebp = options.preferWebp !== false && supportsWebpExport();
    const hasAlpha = file.type === "image/png" || file.type === "image/webp";
    const outputType = preferWebp ? "image/webp" : hasAlpha ? "image/png" : "image/jpeg";

    canvas = createCanvas(target.width, target.height);
    const ctx = canvas.getContext("2d", { alpha: hasAlpha || preferWebp });
    if (!ctx) return result;

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";

    if (!hasAlpha && !preferWebp) {
      // خلفية بيضاء بدل الشفافية السوداء عند التحويل إلى JPEG
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, target.width, target.height);
    }

    ctx.drawImage(decoded.source, 0, 0, target.width, target.height);

    const blob = await canvasToBlob(canvas, outputType, quality);
    if (!blob || !blob.size) return result;

    // لا تستبدل الملف إن كان الناتج أكبر ولم يحدث تصغير للأبعاد
    if (blob.size >= file.size && !target.resized) return result;

    const extension =
      outputType === "image/webp" ? "webp" : outputType === "image/png" ? "png" : "jpg";

    const baseName = (file.name || "image").replace(/\.[a-zA-Z0-9]+$/, "") || "image";

    const compressed = new File([blob], `${baseName}.${extension}`, {
      type: outputType,
      lastModified: Date.now(),
    });

    return {
      file: compressed,
      changed: true,
      originalSize: file.size,
      size: compressed.size,
      width: target.width,
      height: target.height,
      extension,
      contentType: outputType,
    };
  } catch (err) {
    console.warn("[media] تعذّر ضغط الصورة، سيتم رفع الأصل:", err);
    return result;
  } finally {
    // تحرير الذاكرة فوراً بدل انتظار الـ GC
    try {
      decoded?.release?.();
    } catch {
      /* تجاهل */
    }
    if (canvas) releaseCanvas(canvas);
  }
}

/**
 * نقطة الدخول العامة: حضّر أي ملف للرفع.
 * يضغط الصور، ويتحقق من الحد الأقصى للحجم لباقي الأنواع.
 */
export async function prepareFileForUpload(file, options = {}) {
  if (!file) throw new Error("لم يتم اختيار ملف");

  const maxBytes = options.maxUploadBytes ?? MEDIA_LIMITS.maxUploadBytes;

  let prepared = {
    file,
    changed: false,
    originalSize: file.size || 0,
    size: file.size || 0,
    extension: null,
    contentType: file.type || "application/octet-stream",
  };

  if (isImageFile(file)) {
    prepared = await compressImageFile(file, options);
  }

  if (prepared.size > maxBytes) {
    throw new Error(
      `حجم الملف (${formatBytes(prepared.size)}) يتجاوز الحد المسموح ${formatBytes(maxBytes)}`
    );
  }

  return prepared;
}

/** إعدادات جاهزة لكل سياق رفع */
export const MEDIA_PRESETS = {
  attachment: {
    maxWidth: MEDIA_LIMITS.imageMaxWidth,
    maxHeight: MEDIA_LIMITS.imageMaxHeight,
    quality: MEDIA_LIMITS.imageQuality,
  },
  avatar: {
    maxWidth: MEDIA_LIMITS.avatarMaxWidth,
    maxHeight: MEDIA_LIMITS.avatarMaxHeight,
    quality: MEDIA_LIMITS.avatarQuality,
    skipUnderBytes: 0, // الصورة الشخصية تُصغَّر دائماً
  },
  wallpaper: {
    maxWidth: MEDIA_LIMITS.wallpaperMaxWidth,
    maxHeight: MEDIA_LIMITS.wallpaperMaxHeight,
    quality: MEDIA_LIMITS.wallpaperQuality,
    skipUnderBytes: 0,
  },
};
