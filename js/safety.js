/* ============================================================
 * js/safety.js
 * طبقة حماية الواجهة من الانهيار (Error Boundaries).
 *
 * توفّر:
 *   - safeAsync / safeSync : تغليف أي عملية بـ try/catch مع قيمة بديلة (fallback).
 *   - safeQuery            : تغليف استعلامات Supabase مع تطبيع شكل النتيجة.
 *   - safeDom              : تنفيذ تعديلات DOM دون أن يوقف خطأٌ واحد بقية التدفق.
 *   - guard                : تغليف مستمعي الأحداث (event handlers).
 *   - installGlobalErrorBoundary : التقاط الأخطاء غير المعالجة على مستوى النافذة.
 * ============================================================ */

const DEFAULT_RETRY = { retries: 0, delayMs: 400 };

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logError(label, error) {
  // eslint-disable-next-line no-console
  console.error(`[safety] ${label}:`, error);
}

/**
 * ينفّذ دالة غير متزامنة بأمان.
 * @returns {Promise<{ok:boolean, data:any, error:any}>}
 */
export async function safeAsync(label, fn, options = {}) {
  const { fallback = null, retries, delayMs } = { ...DEFAULT_RETRY, ...options };

  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const data = await fn(attempt);
      return { ok: true, data, error: null };
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await delay(delayMs * (attempt + 1));
      }
    }
  }

  logError(label, lastError);
  if (typeof options.onError === "function") {
    try {
      options.onError(lastError);
    } catch (handlerError) {
      logError(`${label} (onError)`, handlerError);
    }
  }

  return { ok: false, data: fallback, error: lastError };
}

/** نسخة متزامنة من safeAsync */
export function safeSync(label, fn, fallback = null) {
  try {
    return { ok: true, data: fn(), error: null };
  } catch (error) {
    logError(label, error);
    return { ok: false, data: fallback, error };
  }
}

/**
 * تغليف استعلام Supabase (الذي يُرجع { data, error } ولا يرمي عادةً)
 * مع التقاط أخطاء الشبكة التي ترمي فعلاً.
 * @returns {Promise<{ok:boolean, data:any, error:any}>}
 */
export async function safeQuery(label, queryFn, fallback = null) {
  try {
    const response = await queryFn();

    if (!response) {
      return { ok: true, data: fallback, error: null };
    }

    if (response.error) {
      logError(label, response.error);
      return { ok: false, data: response.data ?? fallback, error: response.error };
    }

    return { ok: true, data: response.data ?? fallback, error: null };
  } catch (error) {
    logError(`${label} (network)`, error);
    return { ok: false, data: fallback, error };
  }
}

/** تعديل DOM آمن: لا يوقف بقية التنفيذ إن اختفى العنصر أو تغيّر الـ partial */
export function safeDom(label, fn) {
  try {
    fn();
    return true;
  } catch (error) {
    logError(`dom:${label}`, error);
    return false;
  }
}

/** تغليف مستمع حدث بحيث لا يُسرِّب استثناءً إلى المتصفح */
export function guard(label, handler, onError = null) {
  return function guarded(...args) {
    try {
      const out = handler.apply(this, args);
      if (out && typeof out.then === "function") {
        return out.catch((error) => {
          logError(label, error);
          if (typeof onError === "function") onError(error);
        });
      }
      return out;
    } catch (error) {
      logError(label, error);
      if (typeof onError === "function") onError(error);
      return undefined;
    }
  };
}

/** يمنع تكرار نفس الرسالة بشكل مزعج خلال فترة قصيرة */
function createThrottledReporter(reporter, windowMs = 8000) {
  const seen = new Map();
  return (message) => {
    const now = Date.now();
    const last = seen.get(message) || 0;
    if (now - last < windowMs) return;
    seen.set(message, now);
    if (seen.size > 40) seen.clear();
    try {
      reporter(message);
    } catch {
      /* لا شيء يمكن فعله */
    }
  };
}

/**
 * يركّب حاجز أخطاء عالمي: أي خطأ غير معالج أو Promise مرفوض
 * يُسجَّل ويُعرض للمستخدم كتنبيه لطيف بدل شاشة بيضاء.
 */
export function installGlobalErrorBoundary({ notify = null } = {}) {
  const report = createThrottledReporter((message) => {
    if (typeof notify === "function") notify(message);
  });

  window.addEventListener("error", (event) => {
    // أخطاء تحميل الموارد (صور/سكربتات) لا تستحق إزعاج المستخدم
    if (event?.target && event.target !== window && event.target.tagName) {
      console.warn("[safety] فشل تحميل مورد:", event.target.src || event.target.href);
      return;
    }
    logError("window.error", event?.error || event?.message);
    report("حدث خطأ غير متوقع — تم تجاوزه والتطبيق يعمل.");
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event?.reason;
    logError("unhandledrejection", reason);

    const message = String(reason?.message || reason || "");
    // تجاهل أخطاء الشبكة المؤقتة وإلغاء الطلبات
    if (/aborted|AbortError|Failed to fetch|NetworkError|Load failed/i.test(message)) {
      return;
    }
    report("تعذّر إتمام عملية في الخلفية — سيُعاد المحاولة تلقائياً.");
  });
}
