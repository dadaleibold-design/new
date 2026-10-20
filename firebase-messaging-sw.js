/* ============================================================
 * firebase-messaging-sw.js (المدمج والمستقر مع دعم المكالمات)
 * ============================================================ */

importScripts(
  "https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js",
  "https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js"
);

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

const firebaseConfig = {
  apiKey: "AIzaSyA-1dtHG5KbjITzsY7LCWcoYjqXEszMrBE",
  authDomain: "chat-master-c5984.firebaseapp.com",
  projectId: "chat-master-c5984",
  storageBucket: "chat-master-c5984.firebasestorage.app",
  messagingSenderId: "717464814562",
  appId: "1:717464814562:web:2493c537528f59f87eefbb"
};

firebase.initializeApp(firebaseConfig);
const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  console.log("[firebase-messaging-sw.js] Background message received:", payload);

  const notification = payload?.notification || {};
  const data = payload?.data || {};

  const type = data.type || "message";
  const conversationId = data.conversationId || data.conversation_id || "";
  const roomId = data.roomId || data.room_id || "";
  const userId = data.userId || data.user_id || "";

  const isCall = type === "incoming_call" || type === "call";
  const isCallEnded = type === "call_ended";

  // 1) معالجة انتهاء المكالمة (Call Ended)
  if (isCallEnded) {
    const missed = String(data.missed) === "true";
    const callTag = `call-${roomId || "incoming"}`;

    if (missed) {
      return self.registration.showNotification("مكالمة فائتة", {
        body: data.body || "لديك مكالمة فائتة",
        icon: data.icon || "./icons/icon.png",
        badge: "./icons/icon.png",
        tag: `missed-${roomId || Date.now()}`,
        renotify: true,
        data: { ...data, type: "call_ended" }
      }).then(() => {
        // إغلاق إشعار الرنين النشط إن وجد
        return self.registration.getNotifications({ tag: callTag }).then(notifications => {
          notifications.forEach(n => n.close());
        });
      });
    } else {
      // إذا انتهت المكالمة بشكل طبيعي، أغلق إشعار الرنين فوراً
      return self.registration.getNotifications({ tag: callTag }).then(notifications => {
        notifications.forEach(n => n.close());
      });
    }
  }

  // 2) تحديد العناوين والنصوص للإشعارات العادية أو المكالمات الواردة
  const title = notification.title || data.title || (isCall ? "مكالمة واردة..." : "رسالة جديدة");
  const body = notification.body || data.body || (isCall ? "يتصل بك الآن..." : "لديك رسالة جديدة");

  const tag = isCall 
    ? `call-${roomId || "incoming"}` 
    : (conversationId ? `chat-${conversationId}` : `whatsapp-message-${Date.now()}`);

  const notificationOptions = {
    body,
    icon: data.icon || "./icons/icon.png",
    badge: data.badge || "./icons/icon.png",
    tag,
    renotify: true,
    requireInteraction: isCall, // تبقى إشعارات المكالمات ظاهرة حتى يتفاعل المستخدم
    silent: false,
    vibrate: isCall ? [500, 250, 500, 250, 500, 250, 500] : [100, 50, 100],
    actions: isCall ? [
      { action: "answer", title: "📞 رد" },
      { action: "decline", title: "❌ رفض" }
    ] : [],
    data: {
      ...data,
      conversationId,
      roomId,
      type,
      userId
    },
  };

  return self.registration.showNotification(title, notificationOptions);
});

// التعامل مع النقر على الإشعار أو أزرار المكالمات (رد / رفض)
self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const data = event.notification?.data || {};
  const conversationId = data.conversationId || data.conversation_id || "";
  const roomId = data.roomId || "";
  const userId = data.userId || data.user_id || "";
  const action = event.action; // "answer" أو "decline" أو نقرة عادية على الإشعار

  let targetUrl = "./index.html";
  const params = new URLSearchParams();
  if (conversationId) params.set("conversation", conversationId);
  if (userId) params.set("user", userId);
  
  if (roomId) {
    if (action === "decline") {
      params.set("decline_call", roomId);
    } else {
      // سواء ضغط على زر "رد" أو على جسم إشعار المكالمة نفسه
      params.set("answer_call", roomId);
    }
  }

  if (params.toString()) {
    targetUrl += "?" + params.toString();
  }

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) {
          client.postMessage({
            type: "OPEN_CONVERSATION",
            conversationId,
            roomId,
            userId,
            action: action || "open",
            notificationType: data.type
          });
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
      return null;
    })
  );
});

self.addEventListener("notificationclose", () => {
  // no-op
});
