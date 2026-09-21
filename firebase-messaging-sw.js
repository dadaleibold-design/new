/* ============================================================
 * firebase-messaging-sw.js
 * Service Worker لإشعارات Firebase Cloud Messaging (Web Push).
 *
 * قواعد الموثوقية المطبَّقة هنا:
 *  1) لا يفشل السكربت كاملاً إذا تعذّر importScripts (شبكة/حجب gstatic):
 *     يُغلَّف ب try/catch ويبقى مستمع `push` الاحتياطي قادراً على عرض
 *     الإشعار من الحمولة الخام — وهي حالة واقعية لاختفاء الإشعارات.
 *  2) مستمع push احتياطي مستقل عن Firebase SDK، لا يعرض إشعاراً مكرراً
 *     (يفحص getNotifications بنفس الـ tag قبل العرض).
 *  3) تدفّق نقر الإشعار (notificationclick) يفتح *المحادثة الصحيحة* دائماً:
 *     يُرسل postMessage للنافذة الموجودة (بالمعرّف + معرّف الرسالة)، وإن
 *     تعذّر ذلك يوجّه النافذة أو يفتح نافذة جديدة على رابط صحيح مشتق من
 *     نطاق التسجيل (يدعم الاستضافة على مسار فرعي، لا يفترض الجذر).
 *  4) pushsubscriptionchange → إعادة اشتراك + تنبيه التطبيق ليحدّث التوكن.
 * ============================================================ */

const SW_BUILD = "2026-09-21.1";
self.__WA_MESSAGING_SW_BUILD = SW_BUILD;

let firebaseReady = false;

try {
  importScripts(
    "https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js",
    "https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js"
  );
  firebaseReady = true;
} catch (error) {
  // شبكة مقطوعة / حجب / CSP: نُكمل بمستمع push المستقل بدل سقوط الـ SW كله
  console.error("[messaging-sw] تعذّر تحميل Firebase SDK — سيُستخدم المسار الاحتياطي:", error);
}

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  if (event?.data?.type === "SKIP_WAITING") self.skipWaiting();
});

/* ------------------------------------------------------------
 * أدوات مشتركة
 * ---------------------------------------------------------- */

/** يبني رابط التطبيق بالنسبة الصحيحة حتى لو كان مستضافاً على مسار فرعي */
function appBaseUrl() {
  try {
    const scope = self.registration.scope || "/";
    const cleaned = scope.replace(/firebase-cloud-messaging-push-scope\/?$/, "");
    return cleaned || new URL("/", scope).href;
  } catch {
    return `${self.location.origin}/`;
  }
}

function appUrl(conversationId = "", messageId = "", extra = {}) {
  const url = new URL("index.html", appBaseUrl());
  if (conversationId) url.searchParams.set("conversation", conversationId);
  if (messageId) url.searchParams.set("message", messageId);
  Object.entries(extra).forEach(([key, value]) => {
    if (value) url.searchParams.set(key, value);
  });
  return url.href;
}

function iconUrl(hint) {
  if (hint && /^https?:\/\//i.test(hint)) return hint;
  try {
    return new URL("icons/icon.png", appBaseUrl()).href;
  } catch {
    return `${self.location.origin}/icons/icon.png`;
  }
}

/**
 * يوحّد شكل الحمولة: يدعم data-only، وnotification، وFCM_MSG (تعرضها
 * Firebase عند الإشعارات التلقائية داخل كائن notification.data).
 */
function normalizePayload(raw = {}) {
  const nested = raw?.notification?.data?.FCM_MSG;
  const source = nested ? { ...raw, ...nested } : raw;

  const data = source?.data || source?.notification?.data || {};
  const notification = source?.notification || {};

  const conversationId = String(
    data.conversationId || data.conversation_id || raw?.conversationId || raw?.conversation_id || ""
  );
  const messageId = String(data.messageId || data.message_id || raw?.messageId || raw?.message_id || "");
  const type = String(data.type || raw?.type || "message");
  const roomId = String(data.roomId || data.room_id || raw?.roomId || raw?.room_id || "");

  return {
    data: { ...data, conversationId, messageId, type, roomId },
    title: notification.title || data.title || raw?.title || "رسالة جديدة",
    body: notification.body || data.body || raw?.body || "لديك رسالة جديدة",
    icon: notification.icon || data.icon || raw?.icon || "",
    conversationId,
    messageId,
    type,
    roomId,
    isCall: type === "incoming_call",
    isCallEnded: type === "call_ended",
    isMessage: type === "new_message" || type === "message" || !type,
  };
}

function notificationTag(payload) {
  if (payload.isCall) return `call-${payload.roomId || payload.conversationId || "incoming"}`;
  if (payload.conversationId) return `conversation-${payload.conversationId}`;
  return "whatsapp-message";
}

function buildNotificationOptions(payload) {
  const tag = notificationTag(payload);
  const options = {
    body: payload.body,
    icon: iconUrl(payload.icon),
    badge: iconUrl(),
    tag,
    renotify: true,
    requireInteraction: payload.isCall,
    silent: false,
    timestamp: Date.now(),
    data: {
      ...payload.data,
      conversationId: payload.conversationId,
      messageId: payload.messageId,
      type: payload.type,
      roomId: payload.roomId,
      url: appUrl(payload.conversationId, payload.messageId),
    },
    vibrate: payload.isCall ? [500, 250, 500, 250, 500, 250, 500] : [100, 50, 100],
    actions: payload.isCall ? [
      { action: "answer", title: "📞 رد" },
      { action: "decline", title: "رفض" },
    ] : [],
  };
  return { tag, options };
}

/** يعرض الإشعار إن لم يوجد إشعار بنفس الـ tag (يمنع الازدواج) */
async function showNotificationOnce(payload) {
  const { tag, options } = buildNotificationOptions(payload);
  try {
    const existing = await self.registration.getNotifications({ tag });
    if (existing && existing.length) return false;
  } catch {
    /* getNotifications غير مدعومة — أكمل */
  }
  await self.registration.showNotification(payload.title, options);
  return true;
}

async function hasVisibleClient() {
  try {
    const clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    return clientList.some((client) => client.visibilityState === "visible");
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------
 * الاستقبال: Firebase SDK إن توفّر + مسار احتياطي مستقل
 * ---------------------------------------------------------- */

const firebaseConfig = {
  apiKey: "AIzaSyDeg6RBNC9bWw1QYxBkYtCuMMFPBzxpw4o",
  authDomain: "studio-6422025604-b97aa.firebaseapp.com",
  projectId: "studio-6422025604-b97aa",
  storageBucket: "studio-6422025604-b97aa.firebasestorage.app",
  messagingSenderId: "599267399266",
  appId: "1:599267399266:web:4cd19dbf69068019f5e33b",
  measurementId: "G-FFX14GZB51"
};

let messaging = null;

if (firebaseReady) {
  try {
    firebase.initializeApp(firebaseConfig);
    messaging = firebase.messaging();
  } catch (error) {
    console.error("[messaging-sw] فشل تهيئة Firebase Messaging:", error);
    messaging = null;
  }
}

if (messaging) {
  messaging.onBackgroundMessage(async (payload) => {
    console.log("[messaging-sw] Background message:", payload);
    const normalized = normalizePayload(payload);

    // انتهت المكالمة/فائتة: أغلق إشعار الرنين واعرض "مكالمة فائتة"
    if (normalized.isCallEnded) {
      try {
        const list = await self.registration.getNotifications({
          tag: `call-${normalized.roomId || ""}`,
        });
        list.forEach((n) => n.close());
      } catch {
        /* تجاهل */
      }
      if (String(normalized.data.missed) === "true") {
        await showNotificationOnce({
          ...normalized,
          title: normalized.title || "مكالمة فائتة",
          body: normalized.body || "لديك مكالمة فائتة",
          data: { ...normalized.data, conversationId: normalized.conversationId },
        });
      }
      return;
    }

    await showNotificationOnce(normalized);
  });
}

// شبكة أمان: إن لم يعرض Firebase SDK إشعاراً (نسخة قديمة، خطأ تهيئة، أو
// تعذّر تحميل importScripts) نعرضه من الحمولة الخام حتى لا يضيع الإشعار.
self.addEventListener("push", (event) => {
  if (!event.data) return;

  let raw = null;
  try {
    raw = event.data.json();
  } catch {
    try {
      raw = { data: { body: event.data.text() } };
    } catch {
      raw = null;
    }
  }
  if (!raw) return;

  const payload = normalizePayload(raw);
  if (payload.isCallEnded) return; // يعالجه onBackgroundMessage

  event.waitUntil((async () => {
    // إن كان هناك تبويب ظاهر فالتطبيق نفسه مسؤول عن العرض (يمنع الازدواج
    // ويحترم قرار الواجهة بعدم الإزعاج أثناء قراءة نفس المحادثة).
    if (await hasVisibleClient()) return;

    // امنح Firebase SDK فرصة أولاً حتى لا يظهر الإشعار مرتين
    await new Promise((resolve) => setTimeout(resolve, 600));
    await showNotificationOnce(payload);
  })());
});

/* ------------------------------------------------------------
 * نقرة الإشعار → المحادثة الصحيحة
 * ---------------------------------------------------------- */

async function focusOrOpenClient(payload, event) {
  const conversationId = payload.conversationId;
  const messageId = payload.messageId;
  const targetUrl = appUrl(
    conversationId,
    messageId,
    event?.action === "decline"
      ? { decline_call: payload.roomId || "1" }
      : payload.isCall
        ? { answer_call: payload.roomId || "1" }
        : {}
  );

  const base = appBaseUrl();
  const message = {
    type: "OPEN_CONVERSATION",
    conversationId,
    messageId,
    roomId: payload.roomId,
    notificationType: payload.type,
    action: event?.action || "open",
    url: targetUrl,
  };

  let clientList = [];
  try {
    clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  } catch {
    clientList = [];
  }

  // نافذة التطبيق نفسها (نفس الأصل والمسار) — سواء كانت ظاهرة أو مُجمّدة
  const appClients = clientList.filter((client) => {
    try {
      return new URL(client.url).href.startsWith(base);
    } catch {
      return false;
    }
  });

  const target = appClients.find((client) => client.visibilityState === "visible") || appClients[0];

  if (target) {
    try {
      if (conversationId || payload.roomId) target.postMessage(message);
    } catch (error) {
      console.warn("[messaging-sw] postMessage failed:", error);
    }
    try {
      if (typeof target.focus === "function") await target.focus();
    } catch {
      /* بعض المتصفحات ترفض focus بدون تفاعل — تجاهل */
    }
    return target;
  }

  // نافذة على نفس الأصل لكن خارج مسار التطبيق → وجّهها
  const otherSameOrigin = clientList.find((client) => {
    try {
      return new URL(client.url).origin === self.location.origin;
    } catch {
      return false;
    }
  });

  if (otherSameOrigin && typeof otherSameOrigin.navigate === "function") {
    try {
      const navigated = await otherSameOrigin.navigate(targetUrl);
      if (navigated) {
        try {
          if (typeof navigated.focus === "function") await navigated.focus();
        } catch {
          /* تجاهل */
        }
        return navigated;
      }
    } catch (error) {
      console.warn("[messaging-sw] navigate failed:", error);
    }
  }

  if (self.clients.openWindow) {
    return self.clients.openWindow(targetUrl);
  }
  return null;
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const payload = normalizePayload(event.notification?.data || {});
  event.waitUntil(focusOrOpenClient(payload, event));
});

self.addEventListener("notificationclose", () => {
  // no-op: الإشعارات تُدار بالـ tag من التطبيق نفسه
});

// تدوير اشتراك Push: نُعيد الاشتراك ونُبلّغ التطبيق ليحدّث توكن FCM في قاعدة البيانات
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil((async () => {
    console.warn("[messaging-sw] تغيّر اشتراك Push — يجب تحديث التوكن.");
    try {
      const clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      clientList.forEach((client) => {
        try {
          client.postMessage({ type: "PUSH_RESUBSCRIBE" });
        } catch {
          /* تجاهل */
        }
      });
    } catch {
      /* تجاهل */
    }
    try {
      if (event.newSubscription) return;
      const applicationServerKey = event.oldSubscription?.options?.applicationServerKey;
      if (!applicationServerKey) return;
      await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey,
      });
    } catch (error) {
      console.warn("[messaging-sw] تعذّر إعادة الاشتراك:", error);
    }
  })());
});
