/* ============================================================
 * js/notification-router.js
 * موجّه نقرات الإشعارات (Notification Click Router).
 *
 * المشكلة التي يحلّها:
 *   عند النقر على إشعار، يرسل Service Worker رسالة (`OPEN_CONVERSATION`) إلى
 *   النافذة، أو يفتح نافذة جديدة على `?conversation=<id>`. إن وصلت الرسالة
 *   قبل جهوزية التطبيق (أثناء الإقلاع، قبل تحميل الملف الشخصي، أو قبل ربط
 *   المستمع) كان النقر يضيع بلا أثر، ويفتح التطبيق على القائمة العامة.
 *
 * الحل:
 *   • `initNotificationRouter()` تُستدعى عند استيراد الوحدة (قبل boot) فتلتقط
 *     الحدث والرابط فوراً وتخزّنهما في `localStorage` بصلاحية 30 دقيقة.
 *   • التطبيق يسجّل `setNotificationRouteHandler` بعد جهوزيته، فتُسلَّم
 *     الأهداف المخزّنة بالترتيب (الأحدث أولاً) ويُفتح آخر إشعار نُقر عليه.
 *   • إزالة وسائط الرابط بعد الالتقاط حتى لا يُعاد الفتح عند كل تحديث.
 * ============================================================ */

const PENDING_KEY = "wa_pending_route";
const PENDING_TS_KEY = "wa_pending_route_at";
const ROUTE_TTL_MS = 30 * 60 * 1000;
const URL_KEYS = ["conversation", "message", "answer_call", "decline_call"];

let handler = null;
let initialized = false;
const pendingRoutes = [];

function safeStorage() {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

function isFresh(route) {
  if (!route) return false;
  if (!route.at) return true;
  return Date.now() - Number(route.at) < ROUTE_TTL_MS;
}

/** يستخرج هدف الفتح من بيانات الإشعار القادمة من الـ Service Worker */
export function routeFromNotificationData(data = {}) {
  const conversationId = String(data.conversationId || data.conversation_id || "").trim();
  const messageId = String(data.messageId || data.message_id || "").trim();
  const type = String(data.type || "").trim();
  const roomId = String(data.roomId || data.room_id || "").trim();
  const action = String(data.action || "").trim();

  if (!conversationId && !roomId) return null;

  return {
    conversationId: conversationId || null,
    messageId: messageId || null,
    roomId: roomId || null,
    type: type || "message",
    action: action || null,
    at: Date.now(),
    source: "sw-message",
  };
}

/** يستخرج هدف الفتح من رابط الصفحة (?conversation=&message=&answer_call=) */
export function routeFromUrl(href = (typeof location !== "undefined" ? location.href : "")) {
  try {
    const url = new URL(href);
    const conversationId = url.searchParams.get("conversation");
    const messageId = url.searchParams.get("message");
    const answerCall = url.searchParams.get("answer_call");
    const declineCall = url.searchParams.get("decline_call");

    if (!conversationId && !answerCall && !declineCall) return null;

    return {
      conversationId: conversationId || null,
      messageId: messageId || null,
      roomId: answerCall || declineCall || null,
      type: answerCall ? "incoming_call" : declineCall ? "call_decline" : "message",
      action: answerCall ? "answer" : declineCall ? "decline" : "open",
      at: Date.now(),
      source: "url",
    };
  } catch {
    return null;
  }
}

/** ينظّف وسائط الرابط الخاصة بالإشعارات حتى لا يُعاد الفتح عند كل تحديث */
export function clearRouteFromUrl() {
  try {
    if (typeof history === "undefined" || typeof location === "undefined") return;
    const url = new URL(location.href);
    let changed = false;
    URL_KEYS.forEach((key) => {
      if (url.searchParams.has(key)) {
        url.searchParams.delete(key);
        changed = true;
      }
    });
    if (!changed) return;
    const search = url.searchParams.toString();
    history.replaceState({}, "", url.pathname + (search ? `?${search}` : "") + url.hash);
  } catch {
    /* بيئات لا تسمح بتعديل الرابط — تجاهل */
  }
}

/** يخزّن الهدف في الذاكرة + localStorage ليبقى حتى بعد إعادة تحميل الصفحة */
export function queuePendingRoute(route) {
  if (!route || (!route.conversationId && !route.roomId)) return false;

  // تجاهل التكرار لنفس الهدف خلال 5 ثوانٍ (رسالة SW + رابط في نفس النقرة)
  const duplicate = pendingRoutes.find(
    (item) =>
      item.conversationId === route.conversationId &&
      item.messageId === route.messageId &&
      Math.abs((item.at || 0) - (route.at || 0)) < 5000
  );
  if (duplicate) return false;

  pendingRoutes.push(route);
  if (pendingRoutes.length > 5) pendingRoutes.splice(0, pendingRoutes.length - 5);

  const storage = safeStorage();
  if (storage) {
    try {
      storage.setItem(PENDING_KEY, JSON.stringify(route));
      storage.setItem(PENDING_TS_KEY, String(route.at || Date.now()));
    } catch {
      /* التخزين ممتلئ/معطّل — الذاكرة تكفي */
    }
  }
  return true;
}

/** يقرأ الهدف المخزّن (من الذاكرة أو من localStorage) دون حذفه */
export function peekPendingRoute() {
  const inMemory = pendingRoutes.find(isFresh);
  if (inMemory) return inMemory;

  const storage = safeStorage();
  if (!storage) return null;

  try {
    const raw = storage.getItem(PENDING_KEY);
    if (!raw) return null;
    const route = JSON.parse(raw);
    const storedAt = Number(storage.getItem(PENDING_TS_KEY) || route?.at || 0);
    if (!isFresh({ ...route, at: storedAt })) {
      storage.removeItem(PENDING_KEY);
      storage.removeItem(PENDING_TS_KEY);
      return null;
    }
    return { ...route, at: storedAt };
  } catch {
    return null;
  }
}

/** يسحب الهدف المخزّن ويمسحه (يُستدعى مرة واحدة عند التنفيذ) */
export function takePendingRoute() {
  const route = pendingRoutes.find(isFresh) || null;
  if (route) {
    const index = pendingRoutes.indexOf(route);
    if (index > -1) pendingRoutes.splice(index, 1);
  }

  const storage = safeStorage();
  let stored = null;
  if (storage) {
    try {
      const raw = storage.getItem(PENDING_KEY);
      stored = raw ? JSON.parse(raw) : null;
      storage.removeItem(PENDING_KEY);
      storage.removeItem(PENDING_TS_KEY);
    } catch {
      stored = null;
    }
  }
  return route || stored || null;
}

export function clearPendingRoutes() {
  pendingRoutes.length = 0;
  const storage = safeStorage();
  try {
    storage?.removeItem(PENDING_KEY);
    storage?.removeItem(PENDING_TS_KEY);
  } catch {
    /* تجاهل */
  }
}

/** يسلّم الهدف للمعالج المسجَّل، أو يخزّنه إن لم يكن التطبيق جاهزاً بعد */
export function dispatchRoute(route) {
  if (!route) return false;
  if (typeof handler === "function") {
    try {
      const result = handler(route);
      if (result && typeof result.then === "function") result.catch((error) => console.warn("[route] فشل فتح الهدف:", error));
      return true;
    } catch (error) {
      console.warn("[route] فشل فتح الهدف:", error);
      return false;
    }
  }
  return queuePendingRoute(route);
}

/** يسجّل معالج الفتح (يتكرّر استدعاؤه بأمان) ثم يفرّغ أي هدف معلّق */
export function setNotificationRouteHandler(fn) {
  handler = typeof fn === "function" ? fn : null;
  if (handler) flushPendingRoutes();
}

export function flushPendingRoutes() {
  const route = takePendingRoute();
  if (!route) return false;
  return dispatchRoute(route);
}

/**
 * يبدأ الموجّه: يلتقط رابط الصفحة ورسائل Service Worker فوراً.
 * تكرار الاستدعاء لا يضيف مستمعين مكرّرين.
 */
export function initNotificationRouter() {
  if (initialized) return;
  initialized = true;

  // 1) رابط الصفحة (?conversation=<id>&message=<id>) — نافذة فتحها الإشعار
  const fromUrl = routeFromUrl();
  if (fromUrl) {
    queuePendingRoute(fromUrl);
    clearRouteFromUrl();
  }

  // 2) رسائل Service Worker (التطبيق مفتوح بالفعل في تبويب آخر)
  try {
    if (typeof navigator !== "undefined" && navigator.serviceWorker?.addEventListener) {
      navigator.serviceWorker.addEventListener("message", (event) => {
        const message = event?.data;
        if (!message || typeof message !== "object") return;

        if (message.type === "OPEN_CONVERSATION") {
          const route = routeFromNotificationData(message) || routeFromRoutePayload(message);
          if (route) {
            route.source = "sw-message";
            dispatchRoute(route);
          }
          return;
        }

        // رسالة إشعار وصلت والتطبيق في المقدمة (يستخدمها الـ SW لتسليم الحمولة)
        if (message.type === "PUSH_DELIVERED" || message.type === "PENDING_MESSAGES") {
          window.dispatchEvent(new CustomEvent("wa-push-delivered", { detail: message.data || message }));
        }

        // تغيّر اشتراك Push → يلزم إعادة تسجيل توكن FCM على السيرفر
        if (message.type === "PUSH_RESUBSCRIBE") {
          window.dispatchEvent(new CustomEvent("wa-push-resubscribe"));
        }
      });
    }
  } catch (error) {
    console.warn("[route] تعذّر ربط مستمع رسائل Service Worker:", error);
  }
}

/** مسار احتياطي: بعض المتصفحات تمرّر الحقول داخل حقل data كنص JSON */
function routeFromRoutePayload(message) {
  try {
    const data = message.data ? (typeof message.data === "string" ? JSON.parse(message.data) : message.data) : message;
    return routeFromNotificationData(data);
  } catch {
    return null;
  }
}
