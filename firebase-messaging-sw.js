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

  const notificationOptions = {
    body,
    icon: data.icon || "./icons/icon.png",
    badge: data.badge || "./icons/icon.png",
    tag: conversationId || "whatsapp-message",
    renotify: true,
    requireInteraction: true,
    silent: false,
    data: { ...data, conversationId },
    vibrate: [100, 50, 100],
  };

  return self.registration.showNotification(title, notificationOptions);
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const data = event.notification?.data || {};
  const conversationId = data.conversationId || data.conversation_id || "";
  const targetUrl = conversationId
    ? `./index.html?conversation=${encodeURIComponent(conversationId)}`
    : "./index.html";

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
          return clients.openWindow(targetUrl);
        }
        return null;
      })
  );
});

self.addEventListener("notificationclose", () => {
  // no-op
});
