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
  apiKey: "AIzaSyDeg6RBNC9bWw1QYxBkYtCuMMFPBzxpw4o",
  authDomain: "studio-6422025604-b97aa.firebaseapp.com",
  projectId: "studio-6422025604-b97aa",
  storageBucket: "studio-6422025604-b97aa.firebasestorage.app",
  messagingSenderId: "599267399266",
  appId: "1:599267399266:web:329e49e24298af60f5e33b",
};

firebase.initializeApp(firebaseConfig);
const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  console.log("[firebase-messaging-sw.js] Background message:", payload);

  const notification = payload?.notification || {};
  const data = payload?.data || {};
  const conversationId = data.conversationId || data.conversation_id || "";

  const title = notification.title || data.title || "رسالة جديدة";
  const body = notification.body || data.body || "لديك رسالة جديدة";
  const isCall = data.type === "incoming_call";
  const isCallEnded = data.type === "call_ended";

  // انتهت المكالمة/فائتة: أغلق إشعار الرنين واعرض "مكالمة فائتة"
  if (isCallEnded) {
    return self.registration.getNotifications({ tag: `call-${data.roomId || ""}` }).then((list) => {
      list.forEach((n) => n.close());
      if (data.missed === "true" || data.missed === true) {
        return self.registration.showNotification(title || "مكالمة فائتة", {
          body: body || "لديك مكالمة فائتة",
          icon: data.icon || new URL("/icons/icon.png", self.location.origin).href,
          badge: new URL("/icons/icon.png", self.location.origin).href,
          tag: `missed-${data.roomId || Date.now()}`,
          data: { ...data, conversationId },
        });
      }
      return null;
    });
  }

  const notificationOptions = {
    body,
    icon: data.icon || new URL("/icons/icon.png", self.location.origin).href,
    badge: data.badge || new URL("/icons/icon.png", self.location.origin).href,
    tag: isCall ? `call-${data.roomId || conversationId}` : conversationId ? `conversation-${conversationId}` : "whatsapp-message",
    renotify: true,
    requireInteraction: true,
    silent: false,
    data: { ...data, conversationId },
    vibrate: isCall ? [500, 250, 500, 250, 500, 250, 500] : [100, 50, 100],
    actions: isCall
      ? [
          { action: "answer", title: "📞 رد" },
          { action: "decline", title: "رفض" },
        ]
      : [],
  };

  return self.registration.showNotification(title, notificationOptions);
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const data = event.notification?.data || {};
  const conversationId = data.conversationId || data.conversation_id || "";
  const targetUrl = new URL("/index.html", self.location.origin);
  if (conversationId) {
    targetUrl.searchParams.set("conversation", conversationId);
  }
  if (event.action === "decline") {
    // الرفض من الإشعار: افتح التطبيق بصمت ليُرسل إشارة الرفض (لا جلسة داخل الـ SW)
    targetUrl.searchParams.set("decline_call", data.roomId || "1");
  } else if (data.type === "incoming_call") {
    targetUrl.searchParams.set("answer_call", data.roomId || "1");
  }

  event.waitUntil(
    clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if ("focus" in client) {
            if (conversationId) {
              client.postMessage({
                type: "OPEN_CONVERSATION",
                conversationId,
              });
            }
            return client.focus();
          }
        }
        if (clients.openWindow) {
          return clients.openWindow(targetUrl.href);
        }
        return null;
      })
  );
});

self.addEventListener("notificationclose", () => {
  // no-op
});
