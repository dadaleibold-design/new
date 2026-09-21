const CACHE_NAME = "wa-clone-shell-v10";
const APP_SHELL = [
  "./",
  "./index.html",
  "./partials/chat-panel.html",
  "./css/style.css",
  "./js/app.js",
  "./js/auth.js",
  "./js/config.js",
  "./js/i18n.js",
  "./js/supabaseClient.js",
  "./js/db.js",
  "./js/push.js",
  "./js/calls.js",
  "./js/media.js",
  "./js/safety.js",
  "./js/notifications.js",
  "./js/ringtone.js",
  "./js/realtime.js",
  "./js/notification-router.js",
  "./manifest.json",
  "./icons/icon.png",
  "./icons/notify.mp3",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// تطبيق نسخة جديدة فور توفّرها بدل انتظار إغلاق كل التبويبات
self.addEventListener("message", (event) => {
  if (event?.data?.type === "SKIP_WAITING") self.skipWaiting();
});

// Network-first for navigations and API calls, cache-first for static assets.
self.addEventListener("fetch", (event) => {
  const request = event.request;

  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);
  const isSupabase = url.hostname.endsWith(".supabase.co");
  const isSameOrigin = url.origin === self.location.origin;
  const isStaticAsset = /\.(css|js|png|jpg|jpeg|gif|svg|webp|mp3|json|html|ico|woff2?)$/i.test(url.pathname);

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put("./index.html", copy));
          }
          return response;
        })
        .catch(() => caches.match("./index.html"))
    );
    return;
  }

  if (isSupabase || !isSameOrigin) {
    event.respondWith(fetch(request).catch(() => new Response(null, { status: 503 })));
    return;
  }

  // JS/CSS/HTML: stale-while-revalidate — استجابة فورية من الكاش مع تحديث
  // خلفي حتى لا يعلق المستخدم على نسخة قديمة بعد كل نشر.
  const isCode = /\.(css|js|html)$/i.test(url.pathname);
  if (isCode) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        // network-first مع مهلة قصيرة: يضمن وصول أحدث CSS/JS فور النشر،
        // ويعود للكاش عند انقطاع الشبكة أو بطئها.
        const cached = await cache.match(request, { ignoreSearch: true });
        try {
          const response = await Promise.race([
            fetch(request),
            new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 3500)),
          ]);
          if (response && response.ok) cache.put(request, response.clone());
          return response;
        } catch {
          return cached || new Response(null, { status: 503 });
        }
      })
    );
    return;
  }

  if (isStaticAsset) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;

        return fetch(request).then((response) => {
          if (response && response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        }).catch(() => cached);
      })
    );
    return;
  }

  event.respondWith(
    fetch(request).catch(() => caches.match(request).then((cached) => cached || new Response(null, { status: 503 })))
  );
});

// Fallback for foreground notifications shown through the app-shell worker.
// Background FCM notifications are handled by firebase-messaging-sw.js.
// ملاحظة: الرابط يُشتق من نطاق التسجيل (يدعم الاستضافة على مسار فرعي)،
// ويُمرَّر معرّف الرسالة أيضاً ليتمكّن التطبيق من التمرير إليها.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const raw = event.notification?.data || {};
  const nested = raw?.FCM_MSG;
  const data = nested ? { ...nested.data, ...raw } : raw;
  const conversationId = data.conversationId || data.conversation_id || "";
  const messageId = data.messageId || data.message_id || "";

  const scope = (self.registration.scope || "/").replace(/firebase-cloud-messaging-push-scope\/?$/, "");
  let url;
  try {
    url = new URL("index.html", scope || self.location.origin + "/");
  } catch {
    url = new URL("/index.html", self.location.origin);
  }
  if (conversationId) url.searchParams.set("conversation", conversationId);
  if (messageId) url.searchParams.set("message", messageId);

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      const appClients = clientList.filter((client) => {
        try {
          return new URL(client.url).href.startsWith(url.origin + url.pathname.replace(/index\.html$/, ""));
        } catch {
          return false;
        }
      });

      const target = appClients.find((client) => client.visibilityState === "visible") || appClients[0];

      if (target) {
        if (conversationId) {
          target.postMessage({
            type: "OPEN_CONVERSATION",
            conversationId,
            messageId,
            url: url.href,
          });
        }
        return target.focus();
      }

      return clients.openWindow ? clients.openWindow(url.href) : null;
    })
  );
});
