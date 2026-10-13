/* ============================================================
 * firebase-messaging-sw.js
 * Service Worker لإشعارات Firebase Cloud Messaging (Web Push).
 *
 * المبدأ الحاكم (SW_BUILD 2026-10-13.4):
 *   «مصدر واحد يعرض الإشعار، والبقية تسجّل فقط».
 *
 *  1) الخادم (send-push) يرسل دفعة data-only للويب (بلا webpush.notification).
 *     بذلك لا يعرض Firebase SDK إشعاراً تلقائياً بشكل لا نتحكم فيه (كان الإشعار
 *     التلقائي يُبنى من حقل notification الخام، فيختلف عن حمولتنا، ثم كان منع
 *     التكرار يُسقط نسختنا الصحيحة لصالح نسخة SDK الناقصة).
 *  2) معالج `push` الخام في هذا الملف هو المسؤول الوحيد عن العرض. يعمل مع كل
 *     دفعة (حتى لو فشل تحميل SDK)، ويعرض دائماً عندما لا توجد نافذة ظاهرة —
 *     وهذا ما يستوفي شرط userVisibleOnly في Chrome/Android وSafari.
 *  3) SDK.onBackgroundMessage يسجّل الاستلام فقط (تشخيص).
 *  4) منع التكرار بهوية الحدث (messageId / roomId) لا بالـ tag وحده، مع قفل
 *     تسلسلي ومهلة لكل عملية عرض كي لا يتجمّد الطابور فيُفقد كل ما يليه.
 *  5) إن ظهرت نسخة ناقصة من SDK لنفس الحدث (بلا عنوان) تُستبدل بنسختنا الكاملة.
 *  6) pushsubscriptionchange: SDK هو المسؤول عن التوكن؛ نكتفي بإبلاغ الصفحات.
 *  7) سجلات تتبع واضحة بالبادئة [push-sw] لمعرفة هل تصل الدفعة من Google
 *     أصلاً إلى الجهاز، ومن قرّر العرض أو التخطّي ولماذا.
 * ============================================================ */

const SW_BUILD = "2026-10-13.4";
const LOG = "[push-sw]";
self.__WA_MESSAGING_SW_BUILD = SW_BUILD;

function swLog(step, info) {
  try {
    console.log(LOG, step, info === undefined ? "" : info);
  } catch {
    /* تجاهل */
  }
}
function swWarn(step, info) {
  try {
    console.warn(LOG, step, info === undefined ? "" : info);
  } catch {
    /* تجاهل */
  }
}
function swError(step, info) {
  try {
    console.error(LOG, step, info === undefined ? "" : info);
  } catch {
    /* تجاهل */
  }
}

swLog("evaluating service worker", { build: SW_BUILD });

let firebaseReady = false;

/* ------------------------------------------------------------
 * متغيرات البيئة: Service Worker لا يملك `import.meta.env` (لا يعمل إلا
 * داخل حزمة Vite)، لذا نقرأ الملف المولَّد `./env.js` الذي يضبط
 * `self.__ENV__` بنفس الأسماء (VITE_FIREBASE_*). الملف يُنشأ عند النشر
 * بالأمر `npm run env:generate` — ولا يحتوي أي سرّ سيرفري.
 * غياب الملف لا يُسقط الـ SW: معالج الدفعات الخام يكمل العرض وحده.
 * ---------------------------------------------------------- */
let ENV = {};
try {
  importScripts("./env.js");
  ENV = (self.__ENV__ && typeof self.__ENV__ === "object") ? self.__ENV__ : {};
  swLog("env loaded", { keys: Object.keys(ENV).length });
} catch (error) {
  swError("env.js غير موجود أو تعذّر تحميله — الإشعارات تعمل بمعالج الدفعات الخام", String(error));
}

try {
  importScripts(
    "https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js",
    "https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js"
  );
  firebaseReady = true;
  swLog("firebase sdk loaded");
} catch (error) {
  // شبكة مقطوعة / حجب / CSP: المعالج الخام يكمل العرض وحده
  swError("firebase sdk failed to load — raw push handler will render", String(error));
}

self.addEventListener("install", () => {
  swLog("install → skipWaiting");
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  swLog("activate → clients.claim");
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  if (event?.data?.type === "SKIP_WAITING") self.skipWaiting();
});

/* ------------------------------------------------------------
 * أدوات مساعدة
 * ---------------------------------------------------------- */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** يحوّل قيم الحمولة إلى نصوص (شرط FCM: data قيمها نصوص فقط) */
function stringMap(source) {
  const out = {};
  if (!isObject(source)) return out;
  for (const [key, value] of Object.entries(source)) {
    if (value === null || value === undefined || typeof value === "object") continue;
    out[key] = String(value);
  }
  return out;
}

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

/* ------------------------------------------------------------
 * توحيد الحمولة: مصدر واحد لكل أشكال الدفعة
 * ---------------------------------------------------------- */

/**
 * يبني الحمولة الموحّدة من أي شكل:
 *   • دفعة push خام من FCM:        { data:{…}, notification?:{…}, fcmMessageId }
 *   • كائن SDK المُغلّف:           { FCM_MSG:{ data:{…}, notification?:{…} } }
 *   • حمولة onBackgroundMessage:   { data:{…}, messageId, notification? }
 * الأولوية دائماً لـ data (عقدنا مع الخادم)، ثم لحقل notification (توافق رجعي).
 */
function fromPushPayload(raw) {
  const src = isObject(raw) ? raw : {};
  let inner = src;
  if (isObject(src.FCM_MSG)) inner = src.FCM_MSG;
  else if (isObject(src.data) && isObject(src.data.FCM_MSG)) inner = src.data.FCM_MSG;

  const data = stringMap(inner.data);
  const note = isObject(inner.notification) ? inner.notification : {};
  return buildPayload({
    data,
    title: data.title || note.title,
    body: data.body || note.body,
    icon: data.icon || note.icon,
  });
}

/** بيانات إشعار معروض (نقرة، أو notification.data): مسطّحة أو مُغلّفة بـ FCM_MSG */
function fromNotificationData(notificationData) {
  if (isObject(notificationData?.FCM_MSG)) {
    return fromPushPayload({ FCM_MSG: notificationData.FCM_MSG });
  }
  const data = stringMap(notificationData);
  return buildPayload({ data, title: data.title, body: data.body, icon: data.icon });
}

function buildPayload({ data, title, body, icon }) {
  const type = data.type || "message";
  const conversationId = data.conversationId || data.conversation_id || "";
  const messageId = data.messageId || data.message_id || "";
  const roomId = data.roomId || data.room_id || "";
  return {
    data: { ...data, type, conversationId, messageId, roomId },
    title: title || "رسالة جديدة",
    body: body || "لديك رسالة جديدة",
    icon: icon || "",
    conversationId,
    messageId,
    type,
    roomId,
    isCall: type === "incoming_call",
    isCallEnded: type === "call_ended",
  };
}

/** بيانات إشعار موجود (من getNotifications) — تدعم النسخة المُغلّفة من SDK */
function extractData(notificationData) {
  if (isObject(notificationData?.FCM_MSG)) return stringMap(notificationData.FCM_MSG.data);
  return stringMap(notificationData);
}

/**
 * مفتاح الهوية: كل إشعار يمثّل حدثاً واحداً (رسالة أو غرفة مكالمة).
 * يُقارَن بالإشعارات المعروضة فعلاً وبالذاكرة القصيرة، لا بالـ tag وحده.
 */
function identityKey(data = {}) {
  if (data.messageId) return `msg:${data.messageId}`;
  if (data.roomId) return `room:${data.roomId}`;
  // إشعار "مستخدم جديد" (كل مستخدم = حدث واحد)
  if (data.userId || data.user_id) return `user:${data.userId || data.user_id}`;
  return "";
}

/** tag الإشعار: يحدد أيّ إشعارات تستبدل بعضها على الجهاز */
function notificationTag(payload) {
  if (payload.isCall) return `call-${payload.roomId || payload.conversationId || "incoming"}`;
  if (payload.isCallEnded) return `missed-${payload.roomId || Date.now()}`;
  // مستخدم جديد: إشعار مستقل لكل مستخدم (لا يستبدل إشعاراً آخر)
  if (payload.data?.userId || payload.data?.user_id) return `new-user-${payload.data.userId || payload.data.user_id}`;
  if (payload.conversationId) return `conversation-${payload.conversationId}`;
  if (payload.messageId) return `message-${payload.messageId}`;
  return `whatsapp-message-${Date.now()}`;
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
      // ?user=<id> ⇒ التطبيق يفتح (أو يُنشئ) محادثة مباشرة مع صاحب الإشعار
      url: appUrl(
        payload.conversationId,
        payload.messageId,
        payload.data?.userId || payload.data?.user_id
          ? { user: payload.data.userId || payload.data.user_id }
          : {}
      ),
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
 * العرض: طابور تسلسلي + مهلة لكل عملية + ذاكرة قصيرة لمنع التكرار
 * ---------------------------------------------------------- */

const DISPLAY_TIMEOUT_MS = 8000;
const RECENT_TTL_MS = 60_000;
const recentKeys = new Map(); // identityKey -> وقت العرض
let displayChain = Promise.resolve();

function withTimeout(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout: ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * عملية عرض واحدة في كل مرة. المهلة تمنع تجمّد الطابور: إن علقت عملية
 * (getNotifications لا يعود مثلاً) تُكمل العمليات التالية بدلاً من أن يصبح
 * كل push لاحق بلا إشعار (وهو ما يُطلق إشعار Chrome العام «تم تحديث الموقع»).
 */
function enqueueDisplay(label, task) {
  const run = displayChain.then(() =>
    withTimeout(Promise.resolve().then(task), DISPLAY_TIMEOUT_MS, label)
  );
  displayChain = run.catch(() => {});
  return run;
}

function rememberKey(key) {
  const now = Date.now();
  for (const [stored, at] of recentKeys) {
    if (now - at > RECENT_TTL_MS) recentKeys.delete(stored);
  }
  recentKeys.set(key, now);
}

/**
 * يعرض الإشعار إن لم يكن هذا الحدث معروضاً. يعيد true إن عرض.
 * إن وُجدت نسخة ناقصة لنفس الحدث (بلا عنوان) تُغلق وتُستبدل بنسختنا.
 */
function showPayloadOnce(payload) {
  const key = identityKey(payload.data);
  const { tag, options } = buildNotificationOptions(payload);

  return enqueueDisplay("show-payload", async () => {
    if (key) {
      const seenAt = recentKeys.get(key);
      if (seenAt && Date.now() - seenAt < RECENT_TTL_MS) {
        swLog("duplicate skipped (recent)", { key });
        return false;
      }
      rememberKey(key);

      let same = [];
      try {
        const existing = await self.registration.getNotifications({ tag });
        same = existing.filter((n) => identityKey(extractData(n.data)) === key);
      } catch (error) {
        swWarn("getNotifications failed — continuing", String(error));
      }

      if (same.some((n) => String(n.title || "").trim())) {
        swLog("duplicate skipped (already displayed)", { key, tag });
        return false;
      }
      same.forEach((n) => n.close()); // نسخة ناقصة لنفس الحدث
    }

    try {
      await self.registration.showNotification(payload.title, options);
    } catch (error) {
      if (key) recentKeys.delete(key);
      throw error;
    }
    swLog("notification shown", { tag, title: payload.title, key });
    return true;
  });
}

/**
 * بعد العرض: إن ظهرت متأخرة نسخة ناقصة من SDK لنفس الحدث (ومن غير نسختنا
 * الكاملة) فإنها تستبدل نسختنا بالـ tag نفسه. نغلقها ونعيد عرض نسختنا.
 */
async function reconcileLateCopies(payload, tag) {
  const key = identityKey(payload.data);
  if (!key) return;
  await sleep(800);
  try {
    await enqueueDisplay("reconcile", async () => {
      const existing = await self.registration.getNotifications({ tag });
      const same = existing.filter((n) => identityKey(extractData(n.data)) === key);
      const incomplete = same.filter((n) => !String(n.title || "").trim());
      if (!incomplete.length) return;
      const complete = same.some((n) => String(n.title || "").trim());
      incomplete.forEach((n) => n.close());
      swWarn("incomplete late copy replaced", { key, complete });
      if (!complete) {
        const { options } = buildNotificationOptions(payload);
        await self.registration.showNotification(payload.title, options);
      }
    });
  } catch (error) {
    swWarn("reconcile failed", String(error));
  }
}

/** إشعار عام عند فشل كل المسارات — يحافظ على شرط userVisibleOnly */
async function showGenericFallback(reason) {
  try {
    await enqueueDisplay("fallback", () =>
      self.registration.showNotification("رسالة جديدة", {
        body: "افتح التطبيق لعرض التفاصيل",
        icon: iconUrl(),
        badge: iconUrl(),
        tag: "push-fallback",
        renotify: true,
        silent: false,
        data: { type: "fallback", url: appUrl() },
      })
    );
    swLog("fallback notification shown", { reason });
  } catch (error) {
    swError("fallback notification failed", String(error));
  }
}

/**
 * إنهاء مكالمة: فائتة ⇒ إشعار مستقل ويُغلق الرنين. غير فائتة ⇒ يستبدل
 * الرنين بإشعار صامت قصير ثم يُغلق (ويستوفي userVisibleOnly أيضاً).
 */
async function handleCallEnded(payload) {
  const roomId = payload.roomId || "";
  const missed = String(payload.data.missed) === "true";

  if (missed) {
    await showPayloadOnce({
      ...payload,
      title: payload.title || "مكالمة فائتة",
      body: payload.body || "لديك مكالمة فائتة",
    });
    await enqueueDisplay("close-ringing", async () => {
      const ringing = await self.registration.getNotifications({ tag: `call-${roomId}` });
      ringing.forEach((n) => n.close());
    });
    return;
  }

  const endTag = `call-${roomId || "ended"}`;
  await enqueueDisplay("call-ended-silent", () =>
    self.registration.showNotification(payload.title || "انتهت المكالمة", {
      body: payload.body || "انتهت المكالمة",
      icon: iconUrl(payload.icon),
      badge: iconUrl(),
      tag: endTag,
      renotify: false,
      silent: true,
      data: { ...payload.data, type: "call_ended", roomId },
    })
  );
  await sleep(1500);
  try {
    const shown = await self.registration.getNotifications({ tag: endTag });
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
 * تهيئة Firebase SDK (للـ onMessage في الواجهة + تسجيل الاستلام)
 * ---------------------------------------------------------- */

/**
 * تهيئة Firebase من متغيرات البيئة فقط — لا مفاتيح ثابتة في هذا الملف.
 * الأسماء: VITE_FIREBASE_API_KEY / VITE_FIREBASE_PROJECT_ID /
 *          VITE_FIREBASE_MESSAGING_SENDER_ID / VITE_FIREBASE_APP_ID
 */
const FIREBASE_PROJECT_ID = String(ENV.VITE_FIREBASE_PROJECT_ID || "").trim();

const firebaseConfig = {
  apiKey: String(ENV.VITE_FIREBASE_API_KEY || "").trim(),
  authDomain: FIREBASE_PROJECT_ID ? `${FIREBASE_PROJECT_ID}.firebaseapp.com` : "",
  projectId: FIREBASE_PROJECT_ID,
  storageBucket: FIREBASE_PROJECT_ID ? `${FIREBASE_PROJECT_ID}.firebasestorage.app` : "",
  messagingSenderId: String(ENV.VITE_FIREBASE_MESSAGING_SENDER_ID || "").trim(),
  appId: String(ENV.VITE_FIREBASE_APP_ID || "").trim(),
};

/** هل إعدادات Firebase مكتملة داخل الـ SW؟ */
const isFirebaseConfigured = Boolean(
  firebaseConfig.apiKey &&
    firebaseConfig.projectId &&
    firebaseConfig.messagingSenderId &&
    firebaseConfig.appId
);

let messaging = null;

if (firebaseReady && isFirebaseConfigured) {
  try {
    firebase.initializeApp(firebaseConfig);
    messaging = firebase.messaging();
    swLog("firebase messaging initialized");
  } catch (error) {
    swError("firebase messaging init failed — raw push handler only", String(error));
    messaging = null;
  }
} else if (firebaseReady) {
  swLog("firebase config missing in env.js — raw push handler only (display path unaffected)");
}

if (messaging) {
  // يُستدعى من SDK لكل دفعة في الخلفية. لا نعرض هنا (المصدر الوحيد للعرض
  // هو معالج push الخام)، بل نسجّل الاستلام للتشخيص فقط.
  messaging.onBackgroundMessage((payload) => {
    swLog("sdk onBackgroundMessage (log only)", {
      type: payload?.data?.type || "",
      messageId: payload?.data?.messageId || "",
      fcmMessageId: payload?.messageId || "",
      sdkNotification: Boolean(payload?.notification),
    });
  });
}

/* ------------------------------------------------------------
 * الاستقبال: معالج push الخام (المصدر الوحيد للعرض)
 * ---------------------------------------------------------- */

function parsePushEvent(event) {
  if (!event?.data) return null;
  try {
    const value = event.data.json();
    return isObject(value) ? value : null;
  } catch {
    try {
      const text = event.data.text();
      return text ? { data: { body: text } } : null;
    } catch {
      return null;
    }
  }
}

function describePush(raw, received) {
  const inner = isObject(raw?.FCM_MSG) ? raw.FCM_MSG : raw || {};
  const data = isObject(inner.data) ? inner.data : {};
  return {
    build: SW_BUILD,
    receivedAt: new Date(received).toISOString(),
    hasPayload: Boolean(raw),
    fcmMessageId: raw?.fcmMessageId || inner.fcmMessageId || "",
    type: data.type || "",
    messageId: data.messageId || "",
    roomId: data.roomId || "",
    // true ⇒ الدفعة تحمل notification (نسخة قديمة من الخادم): قد يعرض SDK نسخته
    sdkAutoDisplayCandidate: Boolean(inner.notification),
    dataKeys: Object.keys(data),
  };
}

async function handlePush(raw, received) {
  let payload = null;
  try {
    payload = raw ? fromPushPayload(raw) : null;
  } catch (error) {
    swError("payload normalization failed", String(error));
  }

  // نافذة ظاهرة: الصفحة تتولّى العرض عبر onMessage (لا إشعار مزدوج)
  if (await hasVisibleClient()) {
    swLog("decision: app window visible → page renders via onMessage", {
      type: payload?.type || "",
      messageId: payload?.messageId || "",
    });
    return;
  }

  try {
    if (!payload) {
      swWarn("decision: unparseable push → generic notification");
      await showGenericFallback("unparseable");
      return;
    }
    if (payload.isCallEnded) {
      swLog("decision: call_ended", { roomId: payload.roomId, missed: payload.data.missed });
      await handleCallEnded(payload);
      return;
    }
    swLog("decision: background → render notification", {
      type: payload.type,
      messageId: payload.messageId,
      roomId: payload.roomId,
      elapsedMs: Date.now() - received,
    });
    const shown = await showPayloadOnce(payload);
    if (shown) await reconcileLateCopies(payload, notificationTag(payload));
  } catch (error) {
    swError("display failed → generic fallback", String(error));
    await showGenericFallback("display-failed");
  }
}

self.addEventListener("push", (event) => {
  const received = Date.now();
  const raw = parsePushEvent(event);
  // أول سطر: يثبت وصول الدفعة من FCM إلى الجهاز حتى لو فشل ما بعده
  swLog("push received", describePush(raw, received));
  event.waitUntil(handlePush(raw, received));
});

/* ------------------------------------------------------------
 * نقرة الإشعار → المحادثة الصحيحة
 * ---------------------------------------------------------- */

async function focusOrOpenClient(payload, event) {
  const conversationId = payload.conversationId;
  const messageId = payload.messageId;
  const userId = payload.data?.userId || payload.data?.user_id || "";
  const targetUrl = appUrl(
    conversationId,
    messageId,
    event?.action === "decline"
      ? { decline_call: payload.roomId || "1" }
      : payload.isCall
        ? { answer_call: payload.roomId || "1" }
        : userId
          ? { user: userId }
          : {}
  );

  const base = appBaseUrl();
  const message = {
    type: "OPEN_CONVERSATION",
    conversationId,
    messageId,
    roomId: payload.roomId,
    userId,
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
      if (conversationId || payload.roomId || userId) target.postMessage(message);
    } catch (error) {
      swWarn("postMessage to client failed", String(error));
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
      swWarn("navigate failed", String(error));
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
    const payload = fromNotificationData(event.notification?.data || {});
    swLog("notification clicked", {
      action: event.action || "open",
      type: payload.type,
      conversationId: payload.conversationId,
      messageId: payload.messageId,
    });
    event.waitUntil(focusOrOpenClient(payload, event));
  },
  { capture: true }
);

self.addEventListener("notificationclose", () => {
  // no-op: الإشعارات تُدار بالـ tag من التطبيق نفسه
});

/* ------------------------------------------------------------
 * تدوير الاشتراك: SDK يعيد التوكن بنفسه (onSubChange). نكتفي بإبلاغ الصفحات
 * لتعيد المزامنة مع قاعدة البيانات. (لا نستدعي pushManager.subscribe هنا:
 * كان ذلك يُنشئ اشتراكاً خارج FCM ويتعارض مع منطق SDK.)
 * ---------------------------------------------------------- */
self.addEventListener("pushsubscriptionchange", (event) => {
  swWarn("pushsubscriptionchange — notifying pages to re-sync FCM token", {
    hasNewSubscription: Boolean(event.newSubscription),
  });
  event.waitUntil(
    (async () => {
      let clientList = [];
      try {
        clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      } catch {
        clientList = [];
      }
      clientList.forEach((client) => {
        try {
          client.postMessage({ type: "PUSH_RESUBSCRIBE" });
        } catch {
          /* تجاهل */
        }
      });
    })()
  );
});
