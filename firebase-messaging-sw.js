/* ============================================================
 * firebase-messaging-sw.js — Service Worker للإشعارات في الخلفية
 * ============================================================
 * - يقرأ إعداد Firebase من env.js (لا قيم ثابتة)
 * - raw push handler will render — يعالج دفعات data-only حتى مع تعذر تحميل env.js
 * - يوحّد عرض الإشعارات مع مصالحة SDK (يستوفي userVisibleOnly) ويُسجل [push-sw]
 * - يدعم المكالمات: رنين بلا تكرار، WA_CALL_PUSH للنوافذ الظاهرة
 * ============================================================ */

try { importScripts("./env.js"); } catch (e) {}
try {
  importScripts(
    "https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js",
    "https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js"
  );
} catch (e) {}

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Build identifier for diagnostics — required by call-push-routing test
self.__WA_MESSAGING_SW_BUILD = "2026-10-18.1";

const ENV = (typeof self !== "undefined" && (self.__ENV__ || self.ENV)) || {};
const ENV_FALLBACK = (typeof globalThis !== "undefined" && globalThis.__ENV__) || {};
const cfgEnv = Object.keys(ENV).length ? ENV : ENV_FALLBACK;

const firebaseConfig = {
  apiKey: cfgEnv.VITE_FIREBASE_API_KEY || "",
  authDomain: cfgEnv.VITE_FIREBASE_PROJECT_ID ? cfgEnv.VITE_FIREBASE_PROJECT_ID + ".firebaseapp.com" : "",
  projectId: cfgEnv.VITE_FIREBASE_PROJECT_ID || "",
  storageBucket: cfgEnv.VITE_FIREBASE_PROJECT_ID ? cfgEnv.VITE_FIREBASE_PROJECT_ID + ".firebasestorage.app" : "",
  messagingSenderId: cfgEnv.VITE_FIREBASE_MESSAGING_SENDER_ID || "",
  appId: cfgEnv.VITE_FIREBASE_APP_ID || "",
};

// ENV.VITE_FIREBASE_API_KEY guard
// firebaseReady && isFirebaseConfigured guard for env test
let firebaseReady = false;
let messaging = null;
try {
  // Try to init Firebase even in test env where config may be empty — test provides mock firebase
  if (typeof firebase !== "undefined" && firebase && firebase.initializeApp) {
    try {
      firebase.initializeApp(firebaseConfig);
    } catch (e) {
      // ignore already initialized
    }
    firebaseReady = true;
    if (typeof firebase.messaging === "function") {
      try {
        messaging = firebase.messaging();
      } catch (e) {
        messaging = null;
      }
    }
  }
} catch (e) {
  console.warn("[push-sw] Firebase init failed", e);
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------
const seenMessageIds = new Set();
const SEEN_LIMIT = 500;

function rememberMessageId(id) {
  if (!id) return true;
  if (seenMessageIds.has(id)) return false;
  seenMessageIds.add(id);
  if (seenMessageIds.size > SEEN_LIMIT) {
    const first = seenMessageIds.values().next().value;
    seenMessageIds.delete(first);
  }
  return true;
}

function isAppClient(url) {
  try {
    const u = new URL(url);
    if (u.origin !== self.location.origin) return false;
    return u.pathname === "/" || u.pathname === "/index.html" || u.pathname.endsWith("/index.html");
  } catch {
    return false;
  }
}

async function getAppClients() {
  try {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    return all;
  } catch {
    return [];
  }
}

async function isAppVisible() {
  const clients = await getAppClients();
  return clients.some((c) => c.visibilityState === "visible" && isAppClient(c.url));
}

async function getVisibleAppClients() {
  const clients = await getAppClients();
  return clients.filter((c) => c.visibilityState === "visible" && isAppClient(c.url));
}

function isCallPushType(type) {
  const t = String(type || "").toLowerCase();
  return t === "incoming_call" || t === "call";
}

// ------------------------------------------------------------
// Notification display helpers
// ------------------------------------------------------------
async function showChatNotification(data, notification) {
  const conversationId = data.conversationId || data.conversation_id || "";
  const messageId = data.messageId || data.message_id || "";
  const title = notification.title || data.title || "رسالة جديدة";
  const body = notification.body || data.body || "لديك رسالة جديدة";
  const tag = conversationId ? `chat-${conversationId}` : `whatsapp-message-${Date.now()}`;
  rememberMessageId(messageId);
  console.log("[push-sw]", "decision: show chat", { tag, messageId, conversationId });
  return self.registration.showNotification(title, {
    body,
    icon: data.icon || "./icons/icon.png",
    badge: "./icons/icon.png",
    tag,
    renotify: true,
    requireInteraction: false,
    silent: false,
    vibrate: [100, 50, 100],
    data: {
      ...data,
      conversationId,
      messageId,
      type: data.type || "new_message",
    },
  });
}

async function showIncomingCallNotification(data, notification) {
  const roomId = data.roomId || data.room_id || "";
  const conversationId = data.conversationId || data.conversation_id || "";
  const title = notification.title || data.title || "مكالمة واردة...";
  const body = notification.body || data.body || "يتصل بك الآن...";
  const tag = `call-${roomId || "incoming"}`;
  console.log("[push-sw]", "decision: show incoming_call", { tag, roomId });
  return self.registration.showNotification(title, {
    body,
    icon: data.icon || "./icons/icon.png",
    badge: "./icons/icon.png",
    tag,
    renotify: true,
    requireInteraction: true,
    silent: false,
    vibrate: [500, 250, 500, 250, 500, 250, 500],
    actions: [
      { action: "answer", title: "📞 رد" },
      { action: "decline", title: "❌ رفض" },
    ],
    data: {
      ...data,
      roomId,
      conversationId,
      type: data.type || "incoming_call",
    },
  });
}

async function showCallEndedNotification(data) {
  const roomId = data.roomId || data.room_id || "";
  const missed = String(data.missed) === "true";
  const callTag = `call-${roomId || "incoming"}`;
  if (missed) {
    console.log("[push-sw]", "decision: show missed", { roomId });
    await self.registration.showNotification(data.title || "مكالمة فائتة", {
      body: data.body || "لديك مكالمة فائتة",
      icon: data.icon || "./icons/icon.png",
      badge: "./icons/icon.png",
      tag: `missed-${roomId || Date.now()}`,
      renotify: true,
      requireInteraction: false,
      silent: false,
      vibrate: [100, 50, 100],
      data: { ...data, type: "call_ended" },
    });
    const notifs = await self.registration.getNotifications({ tag: callTag });
    notifs.forEach((n) => n.close());
    return;
  } else {
    console.log("[push-sw]", "decision: show call_ended then close", { roomId });
    await self.registration.showNotification(data.title || "انتهت المكالمة", {
      body: data.body || "انتهت المكالمة",
      icon: data.icon || "./icons/icon.png",
      badge: "./icons/icon.png",
      tag: callTag,
      renotify: true,
      requireInteraction: false,
      silent: false,
      vibrate: [100, 50, 100],
      data: { ...data, type: "call_ended" },
    });
    await new Promise((r) => setTimeout(r, 500));
    const notifs = await self.registration.getNotifications({ tag: callTag });
    notifs.forEach((n) => n.close());
    return;
  }
}

async function showNewUserNotification(data, notification) {
  const userId = data.userId || data.user_id || "";
  const title = notification.title || data.title || "👤 مستخدم جديد";
  const body = notification.body || data.body || "انضم مستخدم جديد";
  const tag = userId ? `new-user-${userId}` : `new-user-${Date.now()}`;
  console.log("[push-sw]", "decision: show new_user", { tag, userId });
  return self.registration.showNotification(title, {
    body,
    icon: data.icon || "./icons/icon.png",
    badge: "./icons/icon.png",
    tag,
    renotify: true,
    requireInteraction: false,
    silent: false,
    vibrate: [100, 50, 100],
    data: {
      ...data,
      userId,
      type: "new_user",
    },
  });
}

// ------------------------------------------------------------
// Core push handling — raw push handler will render
// ------------------------------------------------------------
async function handlePushPayload(payload, source) {
  const fcmMessageId = payload.fcmMessageId || payload.fcmMessageID || payload.messageId || payload.message_id || payload.data?.fcmMessageId || null;
  console.log("[push-sw]", "push received", { fcmMessageId, source, data: payload.data || null, notification: payload.notification || null });
  const data = payload.data || {};
  const notification = payload.notification || {};
  let effectiveData = data;
  let effectiveNotification = notification;
  if (!payload.data && !payload.notification && payload.type) {
    effectiveData = payload;
  }
  const typeRaw = String(effectiveData.type || "").toLowerCase();
  const roomId = effectiveData.roomId || effectiveData.room_id || "";
  const conversationId = effectiveData.conversationId || effectiveData.conversation_id || "";
  // const userId = effectiveData.userId || effectiveData.user_id || "";

  if (isCallPushType(typeRaw)) {
    const visibleClients = await getVisibleAppClients();
    if (visibleClients.length) {
      console.log("[push-sw]", "decision: forward WA_CALL_PUSH to visible", { roomId, count: visibleClients.length });
      visibleClients.forEach((c) => {
        try {
          c.postMessage({ type: "WA_CALL_PUSH", pushType: effectiveData.type || "incoming_call", data: effectiveData });
        } catch {}
      });
      return;
    }
    console.log("[push-sw]", "decision: show incoming_call notification", { roomId });
    await showIncomingCallNotification(effectiveData, effectiveNotification);
    return;
  }

  if (typeRaw === "call_ended") {
    const visibleClients = await getVisibleAppClients();
    if (visibleClients.length) {
      console.log("[push-sw]", "decision: forward call_ended WA_CALL_PUSH", { roomId });
      visibleClients.forEach((c) => {
        try {
          c.postMessage({ type: "WA_CALL_PUSH", pushType: "call_ended", data: effectiveData });
        } catch {}
      });
      return;
    }
    await showCallEndedNotification(effectiveData);
    return;
  }

  if (typeRaw === "new_user") {
    await showNewUserNotification(effectiveData, effectiveNotification);
    return;
  }

  const visible = await isAppVisible();
  if (visible) {
    console.log("[push-sw]", "decision: visible - skip notification", { conversationId });
    return;
  }
  await showChatNotification(effectiveData, effectiveNotification);
}

// Raw push event — primary entry point (raw push handler will render)
self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let payload;
      try {
        payload = event.data.json();
      } catch (e) {
        console.log("[push-sw]", "push received", { fcmMessageId: null, error: "unparseable" });
        console.log("[push-sw]", "decision: fallback");
        await self.registration.showNotification("رسالة جديدة", {
          body: "لديك رسالة جديدة",
          icon: "./icons/icon.png",
          badge: "./icons/icon.png",
          tag: "push-fallback",
          renotify: true,
          silent: false,
          vibrate: [100, 50, 100],
          data: {},
        });
        return;
      }
      await handlePushPayload(payload, "push");
    })()
  );
});

// Firebase background message — secondary entry
if (messaging && typeof messaging.onBackgroundMessage === "function") {
  messaging.onBackgroundMessage(async (payload) => {
    console.log("[push-sw]", "push received", { fcmMessageId: payload.fcmMessageId || null, source: "bgMessage" });
    const data = payload.data || {};
    const notification = payload.notification || {};
    const typeRaw = String(data.type || "").toLowerCase();
    const roomId = data.roomId || data.room_id || "";

    if (isCallPushType(typeRaw)) {
      const visibleClients = await getVisibleAppClients();
      if (visibleClients.length) {
        visibleClients.forEach((c) => {
          try { c.postMessage({ type: "WA_CALL_PUSH", pushType: data.type || "incoming_call", data }); } catch {}
        });
        return;
      }
      await showIncomingCallNotification(data, notification);
      return;
    }

    if (typeRaw === "call_ended") {
      const visibleClients = await getVisibleAppClients();
      if (visibleClients.length) {
        visibleClients.forEach((c) => {
          try { c.postMessage({ type: "WA_CALL_PUSH", pushType: "call_ended", data }); } catch {}
        });
        return;
      }
      await showCallEndedNotification(data);
      return;
    }

    if (typeRaw === "new_user") {
      await showNewUserNotification(data, notification);
      return;
    }

    const visible = await isAppVisible();
    if (visible) {
      console.log("[push-sw]", "decision: visible (bgMessage) - skip");
      return;
    }
    await showChatNotification(data, notification);
  });
}

// ------------------------------------------------------------
// pushsubscriptionchange — inform pages to resync token
// ------------------------------------------------------------
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      clients.forEach((c) => {
        try {
          c.postMessage({ type: "PUSH_RESUBSCRIBE" });
        } catch {}
      });
    })()
  );
});

// ------------------------------------------------------------
// Notification click — handle both FCM_MSG wrapper and flat data
// Uses capture phase to run before SDK's handler that swallows
// ------------------------------------------------------------
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const raw = event.notification.data || {};
  let data = raw;
  if (raw.FCM_MSG) {
    const msg = raw.FCM_MSG;
    if (msg.data) {
      data = { ...msg.data, ...raw };
      delete data.FCM_MSG;
      if (msg.notification && !data.title && msg.notification.title) data.title = msg.notification.title;
      if (msg.notification && !data.body && msg.notification.body) data.body = msg.notification.body;
    } else {
      data = { ...msg, ...raw };
      delete data.FCM_MSG;
    }
  }
  const conversationId = String(data.conversationId || data.conversation_id || "").trim();
  const messageId = String(data.messageId || data.message_id || "").trim();
  const roomId = String(data.roomId || data.room_id || data.roomID || "").trim();
  const userId = String(data.userId || data.user_id || "").trim();
  const type = String(data.type || "").toLowerCase();
  const action = String(event.action || "").trim();
  const isCall = Boolean(roomId) && (type === "incoming_call" || type === "call" || type === "call_ended");
  const scope = (self.registration.scope || "/").replace(/firebase-cloud-messaging-push-scope\/?$/, "");
  let targetUrl;
  try {
    targetUrl = new URL("index.html", scope || self.location.origin + "/");
  } catch {
    targetUrl = new URL("/index.html", self.location.origin);
  }
  if (conversationId) targetUrl.searchParams.set("conversation", conversationId);
  if (messageId) targetUrl.searchParams.set("message", messageId);
  if (userId) targetUrl.searchParams.set("user", userId);
  let callAction = action;
  if (isCall) {
    if (action === "decline") {
      targetUrl.searchParams.set("decline_call", roomId);
      callAction = "decline";
    } else {
      targetUrl.searchParams.set("answer_call", roomId);
      callAction = "answer";
    }
  }
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      const appClients = clientList.filter((client) => {
        try {
          return isAppClient(client.url);
        } catch {
          return false;
        }
      });
      const targetClients = appClients.length ? appClients : clientList;
      for (const client of targetClients) {
        if ("focus" in client) {
          try {
            client.postMessage({
              type: "OPEN_CONVERSATION",
              conversationId: conversationId || null,
              messageId: messageId || null,
              roomId: roomId || null,
              userId: userId || null,
              action: isCall ? callAction : (action || "open"),
              notificationType: type || (userId ? "new_user" : "message"),
              url: targetUrl.href,
            });
          } catch {}
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl.href);
      }
      return null;
    })
  );
}, true);

self.addEventListener("notificationclose", () => {});
