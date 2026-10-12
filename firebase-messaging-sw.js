/* ============================================================
 * firebase-messaging-sw.js
 * Service Worker لإشعارات Firebase Cloud Messaging (Web Push).
 *
 * قواعد الموثوقية المطبَّقة:
 *  1) نقرة الإشعار: معالجنا مُسجَّل بمرحلة الالتقاط (capture) فيعمل قبل
 *     معالج Firebase SDK. الـ SDK يستدعي stopImmediatePropagation() عند
 *     عدم وجود رابط (fcm_options.link) فيبتلع النقرة — وهذا كان يمنع فتح
 *     المحادثة نهائياً. الآن نوقف الانتشار بأنفسنا ونعالج النقرة دائماً.
 *  2) الحمولة تأتي بأشكال متعددة: FCM_MSG (تغلّفها Firebase داخل
 *     notification.data)، أو data مباشرة. normalizePayload يوحّدها كلها —
 *     بما فيها بيانات النقرة (event.notification.data = { FCM_MSG: … }).
 *  3) منع التكرار بمفتاح الرسالة (messageId / roomId)، لا بالـ tag وحده.
 *     الـ tag وحده كان يُسقط رسالة جديدة إذا بقي إشعار سابق بنفس
 *     المحادثة في الصينية (الإشعار القديم يحمل نفس الـ tag).
 *  4) كل تسليم push يُنتج إشعاراً مرئياً عندما يكون التطبيق في الخلفية
 *     (شرط userVisibleOnly في Chrome/Android)، بما فيها إنهاء المكالمة.
 *  5) مكالمة فائتة لها tag خاص (missed-<room>) لا يستبدل إشعار المحادثة.
 *  6) pushsubscriptionchange → إعادة اشتراك + تنبيه التطبيق لتحديث التوكن.
 * ============================================================ */

const SW_BUILD = "2026-10-12.1";
self.__WA_MESSAGING_SW_BUILD = SW_BUILD;

let firebaseReady = false;

try {
  importScripts(
    "https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js",
    "https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js"
  );
  firebaseReady = true;
} catch (error) {
  // شبكة مقطوعة / حجب / CSP: نُكمل بالمسار الاحتياطي المستقل بدل سقوط الـ SW
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
 * يوحّد شكل الحمولة من أي مصدر:
 *   • push خام من FCM:            { data:{…}, notification:{…} }
 *   • كائن إشعار معروض (SDK):     { data:{ FCM_MSG:{ data:{…}, notification:{…} } } }
 *   • حمولة onBackgroundMessage:  { data:{…}, notification:{…} }
 */
function normalizePayload(raw = {}) {
  const wrapped = raw?.FCM_MSG || raw?.data?.FCM_MSG || raw?.notification?.data?.FCM_MSG || null;
  const source = wrapped ? { ...raw, ...wrapped } : raw;

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

/**
 * tag الإشعار: يحدد أيّ إشعارات تستبدل بعضها على الجهاز.
 *   • رسائل المحادثة: tag لكل محادثة (تتجمّع كما في واتساب).
 *   • المكالمة الواردة: tag لكل غرفة (تُغلق عند انتهائها).
 *   • المكالمة الفائتة: tag منفصل — لا تستبدل إشعار الرسائل.
 */
function notificationTag(payload) {
  if (payload.isCall) return `call-${payload.roomId || payload.conversationId || "incoming"}`;
  if (payload.isCallEnded) return `missed-${payload.roomId || Date.now()}`;
  if (payload.conversationId) return `conversation-${payload.conversationId}`;
  if (payload.messageId) return `message-${payload.messageId}`;
  return `whatsapp-message-${Date.now()}`;
}

/**
 * مفتاح الهوية للمنع من التكرار: كل إشعار يُمثّل حدثاً واحداً (رسالة أو
 * غرفة مكالمة). يُقارَن بالإشعارات المعروضة فعلاً وليس بالـ tag.
 */
function identityKey(data = {}) {
  const d = data?.FCM_MSG?.data || data || {};
  if (d.messageId || d.message_id) return `msg:${d.messageId || d.message_id}`;
  if (d.roomId || d.room_id) return `room:${d.type || "call"}:${d.roomId || d.room_id}`;
  return "";
}

function buildNotificationOptions(payload) {
  const tag = notificationTag(payload);
  const isCall = payload.isCall;
  const options = {
    body: payload.body,
    icon: iconUrl(payload.icon),
    badge: iconUrl(),
    tag,
    // renotify: إعادة التنبيه (صوت/اهتزاز) حتى مع وجود إشعار بنفس الـ tag
    renotify: true,
    requireInteraction: isCall,
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
    vibrate: isCall ? [500, 250, 500, 250, 500, 250, 500] : [100, 50, 100],
    actions: isCall
      ? [
          { action: "answer", title: "📞 رد" },
          { action: "decline", title: "رفض" },
        ]
      : [],
  };
  return { tag, options };
}

/* ------------------------------------------------------------
 * العرض: تسلسل داخلي + منع تكرار بالهوية
 * ---------------------------------------------------------- */

// المستمعان (Firebase SDK + المسار الاحتياطي) يعملان في نفس الـ SW؛ نُسلسل
// فحص "هل عُرض؟" + "اعرض" كي لا يفحص كلاهما قبل أن يعرض أيّ منهما.
let displayChain = Promise.resolve();

function enqueueDisplay(task) {
  const run = displayChain.then(task, task);
  displayChain = run.catch(() => {});
  return run;
}

/** يعرض الإشعار إن لم يكن هذا الحدث معروضاً بالفعل. يعيد true إن عرض. */
function showNotificationOnce(payload) {
  return enqueueDisplay(async () => {
    const { tag, options } = buildNotificationOptions(payload);
    const key = identityKey(payload.data);
    if (key) {
      try {
        const existing = await self.registration.getNotifications({ tag });
        if (existing.some((n) => identityKey(n.data) === key)) return false;
      } catch {
        /* getNotifications غير مدعومة — أكمل */
      }
    }
    await self.registration.showNotification(payload.title, options);
    return true;
  });
}

/**
 * إنهاء مكالمة: يُغلق رنين المكالمة الواردة. ولأن قواعد Push تُلزم بإظهار
 * إشعار لكل دفعة في الخلفية، فإن لم تكن فائتة نعرض إشعاراً صامتاً يستبدل
 * الرنين ثم يُغلق بعد لحظة قصيرة.
 */
async function handleCallEnded(payload) {
  const roomId = payload.roomId || "";
  const missed = String(payload.data.missed) === "true";

  if (missed) {
    await showNotificationOnce({
      ...payload,
      title: payload.title || "مكالمة فائتة",
      body: payload.body || "لديك مكالمة فائتة",
    });
    // أغلق رنين المكالمة الواردة
    try {
      const ringing = await self.registration.getNotifications({ tag: `call-${roomId}` });
      ringing.forEach((n) => n.close());
    } catch {
      /* تجاهل */
    }
    return;
  }

  // غير فائتة: استبدل الرنين بإشعار صامت قصير ثم أغلقه
  await enqueueDisplay(async () => {
    await self.registration.showNotification(payload.title || "انتهت المكالمة", {
      body: payload.body || "انتهت المكالمة",
      icon: iconUrl(payload.icon),
      badge: iconUrl(),
      tag: `call-${roomId || "ended"}`,
      renotify: false,
      silent: true,
      data: { ...payload.data, type: "call_ended", roomId },
    });
  });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  try {
    const shown = await self.registration.getNotifications({ tag: `call-${roomId || "ended"}` });
    shown.forEach((n) => n.close());
  } catch {
    /* تجاهل */
  }
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
  measurementId: "G-FFX14GZB51",
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
  // يُستدعى من الـ SDK فقط عندما لا توجد نافذة ظاهرة (وإلا تُرسَل الرسالة للصفحة)
  messaging.onBackgroundMessage(async (payload) => {
    const normalized = normalizePayload(payload);

    if (normalized.isCallEnded) {
      await handleCallEnded(normalized);
      return;
    }

    await showNotificationOnce(normalized);
  });
}

// المسار الاحتياطي المستقل: يعمل إن لم يعرض الـ SDK شيئاً (SDK غير متاح،
// أو نسخة قديمة، أو دفعة data-only). الفحص بالهوية يمنع الازدواج.
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

  event.waitUntil((async () => {
    // نافذة ظاهرة: الصفحة تتولّى العرض (onMessage) ولا نُزعج المستخدم مرتين
    if (await hasVisibleClient()) return;

    // امنح الـ SDK فرصة أولاً ثم تحقق من الهوية قبل العرض
    await new Promise((resolve) => setTimeout(resolve, 600));

    if (payload.isCallEnded) {
      await handleCallEnded(payload);
      return;
    }
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

// مرحلة الالتقاط (capture=true) + stopImmediatePropagation:
// يضمن أن معالجنا يعمل قبل معالج Firebase SDK الذي يبتلع النقرة بلا رابط.
self.addEventListener(
  "notificationclick",
  (event) => {
    event.stopImmediatePropagation();
    event.notification.close();
    const payload = normalizePayload(event.notification?.data || {});
    event.waitUntil(focusOrOpenClient(payload, event));
  },
  { capture: true }
);

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
