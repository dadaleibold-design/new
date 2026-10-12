/*
 * اختبار Service Worker للإشعارات (firebase-messaging-sw.js) — بلا متصفح
 * -------------------------------------------------------------
 * يحمّل الملف الحقيقي داخل sandbox مع محاكاة لـ Firebase SDK تتصرّف كما في
 * الكود المصدري لـ @firebase/messaging (v10):
 *   • عند عدم وجود نافذة ظاهرة: تعرض الـ SDK إشعار `notification` بنفسها ثم
 *     تستدعي onBackgroundMessage.
 *   • يسجّل معالج notificationclick قبل كودنا، ويستدعي
 *     stopImmediatePropagation() عند غياب الرابط (يبتلع النقرة).
 *
 * ملاحظة: المحاكي يُنفّذ مراحل الحدث كما في المتصفح (مستمعو الالتقاط أولاً ثم
 * مستمعو الفقاعة) لأن Node لا يحاكي ذلك.
 *
 * التشغيل: node tests/push-sw.mjs
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SW_SOURCE = fs.readFileSync(path.join(ROOT, "firebase-messaging-sw.js"), "utf8");

let fails = 0;
const check = (name, ok, extra = "") => {
  console.log(ok ? "✅" : "❌", name, extra);
  if (!ok) fails += 1;
};

/* ------------------------------------------------------------
 * هدف أحداث يحاكي الالتقاط ثم الفقاعة + stopImmediatePropagation
 * ---------------------------------------------------------- */
class FakeEventTarget {
  constructor() {
    this.listeners = new Map(); // type -> [{fn, capture}]
  }
  addEventListener(type, fn, options = {}) {
    const capture = typeof options === "boolean" ? options : Boolean(options.capture);
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push({ fn, capture });
  }
  dispatch(type, event) {
    const list = this.listeners.get(type) || [];
    const ordered = [...list.filter((l) => l.capture), ...list.filter((l) => !l.capture)];
    let stopped = false;
    event.stopImmediatePropagation = () => {
      stopped = true;
    };
    for (const { fn } of ordered) {
      if (stopped) break;
      fn(event);
    }
    return event;
  }
}

/** بيئة SW وهمية كاملة */
function createSwEnv({ visibleClient = false } = {}) {
  const self = new FakeEventTarget();
  const notifications = [];
  const openedWindows = [];
  const posted = [];
  const waitPromises = [];

  self.location = { origin: "https://app.test", href: "https://app.test/firebase-messaging-sw.js" };
  self.registration = {
    scope: "https://app.test/firebase-cloud-messaging-push-scope",
    showNotification(title, options) {
      const record = {
        title,
        options,
        tag: options.tag,
        data: options.data,
        closed: false,
        close() {
          this.closed = true;
          const i = notifications.indexOf(this);
          if (i >= 0) notifications.splice(i, 1);
        },
      };
      // سلوك المنصة: إشعار بنفس الـ tag يستبدل السابق
      if (record.tag) {
        for (let i = notifications.length - 1; i >= 0; i -= 1) {
          if (notifications[i].tag === record.tag) notifications.splice(i, 1);
        }
      }
      notifications.push(record);
      return Promise.resolve();
    },
    getNotifications({ tag } = {}) {
      return Promise.resolve(notifications.filter((n) => !tag || n.tag === tag));
    },
  };
  const client = {
    url: "https://app.test/index.html",
    visibilityState: visibleClient ? "visible" : "hidden",
    focus: () => Promise.resolve(),
    postMessage: (msg) => posted.push(msg),
  };
  self.clients = {
    matchAll: () => Promise.resolve([client]),
    openWindow: (url) => {
      openedWindows.push(url);
      return Promise.resolve(null);
    },
    claim: () => Promise.resolve(),
  };
  self.skipWaiting = () => {};

  let bgHandler = null;
  const sdk = {
    initializeApp() {},
    messaging() {
      return {
        onBackgroundMessage(fn) {
          bgHandler = fn;
        },
      };
    },
  };

  const context = {
    self,
    console: { log() {}, warn() {}, error() {} },
    URL,
    Date,
    Promise,
    Set,
    Map,
    JSON,
    Array,
    Object,
    String,
    Error,
    Number,
    setTimeout,
    clearTimeout,
    firebase: sdk,
    importScripts() {
      // محاكاة معالجات Firebase SDK التي تُسجَّل عند تحميل السكربت
      self.addEventListener("push", (event) => {
        event.waitUntil(sdkOnPush(event));
      });
      self.addEventListener("notificationclick", (event) => {
        // سلوك SDK: بلا رابط ⇒ يبتلع النقرة (stopImmediatePropagation)
        if (!event.action) {
          event.stopImmediatePropagation();
          event.notification.close();
        }
      });
    },
  };

  async function sdkOnPush(event) {
    let internal = null;
    try {
      internal = event.data.json();
    } catch {
      return;
    }
    const visible = (await self.clients.matchAll()).some((c) => c.visibilityState === "visible");
    if (visible) {
      posted.push({ sdk: true, internal });
      return;
    }
    if (internal.notification) {
      // الـ SDK يعرض notification بنفسه ويلفّ الحمولة في FCM_MSG
      const { title, body, icon, tag, actions, renotify, requireInteraction, vibrate, silent } =
        internal.notification;
      await self.registration.showNotification(title, {
        body,
        icon,
        tag,
        actions,
        renotify,
        requireInteraction,
        vibrate,
        silent,
        data: { FCM_MSG: internal },
      });
    }
    if (bgHandler) {
      await bgHandler({ data: internal.data, notification: internal.notification });
    }
  }

  vm.createContext(context);
  vm.runInContext(SW_SOURCE, context, { filename: "firebase-messaging-sw.js" });

  return {
    self,
    notifications,
    openedWindows,
    posted,
    /** يرسل push ثم ينتظر كل ما أُعطي لـ waitUntil */
    async push(payload) {
      const pending = [];
      const event = {
        data: {
          json: () => payload,
          text: () => JSON.stringify(payload),
        },
        waitUntil: (p) => pending.push(p),
      };
      self.dispatch("push", event);
      await Promise.all(pending);
    },
    /** ينقر إشعاراً معروضاً (أو وهمياً من بيانات) */
    async click(notificationData, action = "") {
      const pending = [];
      const event = {
        action,
        notification: {
          data: notificationData,
          close() {},
        },
        waitUntil: (p) => pending.push(p),
      };
      self.dispatch("notificationclick", event);
      await Promise.all(pending);
    },
  };
}

const pushPayload = ({ type = "new_message", messageId, conversationId, title = "أحمد", body = "مرحبا" }) => ({
  notification: {
    title,
    body,
    tag: conversationId ? `conversation-${conversationId}` : "whatsapp-message",
    renotify: true,
    silent: false,
    requireInteraction: false,
    vibrate: [100, 50, 100],
    actions: [],
  },
  data: { type, messageId, conversationId, title, body, senderId: "u-2" },
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* 1) النقرة تُعالَج (لا تبتلعها الـ SDK) ----------------------------------- */
{
  const env = createSwEnv();
  await env.click({ FCM_MSG: { data: { type: "new_message", conversationId: "c-9", messageId: "m-7" } } });
  const msg = env.posted.find((m) => m?.type === "OPEN_CONVERSATION");
  check(
    "نقرة إشعار SDK (FCM_MSG) تُوجّه المحادثة والرسالة الصحيحتين (لم تبتلعها الـ SDK)",
    Boolean(msg) && msg.conversationId === "c-9" && msg.messageId === "m-7",
    JSON.stringify(msg || null)
  );
}

{
  const env = createSwEnv();
  await env.click({ type: "new_message", conversationId: "c-3", messageId: "m-1" });
  const msg = env.posted.find((m) => m?.type === "OPEN_CONVERSATION");
  check(
    "نقرة إشعار معروض من كودنا (بيانات مسطحة) تعمل أيضاً",
    msg?.conversationId === "c-3",
    JSON.stringify(msg || null)
  );

  // بلا نافذة مفتوحة ⇒ يُفتح رابط صحيح بالمحادثة
  const cold = createSwEnv();
  cold.self.clients.matchAll = () => Promise.resolve([]);
  await cold.click({ type: "new_message", conversationId: "c-8", messageId: "m-8" });
  check(
    "نقرة بلا نافذة مفتوحة ⇒ فتح نافذة برابط المحادثة",
    cold.openedWindows[0]?.includes("conversation=c-8") && cold.openedWindows[0]?.includes("message=m-8"),
    cold.openedWindows[0] || "(لا نافذة)"
  );
}

/* 2) تسليم رسالة في الخلفية: إشعار واحد فقط (بلا تكرار) -------------------- */
{
  const env = createSwEnv();
  await env.push(pushPayload({ messageId: "m-1", conversationId: "c-1" }));
  await wait(700);
  check("رسالة خلفية واحدة ⇒ إشعار واحد بالضبط", env.notifications.length === 1, `count=${env.notifications.length}`);
}

/* 3) رسالة ثانية في نفس المحادثة لا تُسقَط (كان الـ tag وحده يُسقطها) ------ */
{
  const env = createSwEnv();
  await env.push(pushPayload({ messageId: "m-1", conversationId: "c-1", body: "الأولى" }));
  await wait(700);
  await env.push(pushPayload({ messageId: "m-2", conversationId: "c-1", body: "الثانية" }));
  await wait(700);
  const bodies = env.notifications.map((n) => n.options.body);
  check(
    "رسالة ثانية بنفس المحادثة تُعرض (لا تُكتم بالإشعار السابق)",
    bodies.includes("الثانية"),
    `bodies=${JSON.stringify(bodies)}`
  );
}

/* 3b) دفعة data-only (لا يعرض الـ SDK شيئاً) ⇒ رسالة ثانية بنفس المحادثة
 *     يجب أن تظهر. كان فحص الـ tag وحده يُسقطها لأن إشعاراً سابقاً بالـ tag نفسه معروض. */
{
  const env = createSwEnv();
  const dataOnly = (messageId, body) => ({
    data: { type: "new_message", messageId, conversationId: "c-20", title: "سارة", body, senderId: "u-3" },
  });
  await env.push(dataOnly("d-1", "الأولى"));
  await wait(700);
  await env.push(dataOnly("d-2", "الثانية"));
  await wait(700);
  const bodies = env.notifications.map((n) => n.options.body);
  check(
    "دفعة data-only ثانية بنفس المحادثة تُعرض (لا تُسقط)",
    bodies.includes("الثانية"),
    `bodies=${JSON.stringify(bodies)}`
  );
}

/* 4) تكرار نفس الرسالة (push مزدوج) لا يُنتج إشعارين ----------------------- */
{
  const env = createSwEnv();
  await env.push(pushPayload({ messageId: "m-5", conversationId: "c-2" }));
  await env.push(pushPayload({ messageId: "m-5", conversationId: "c-2" }));
  await wait(900);
  check("الرسالة نفسها مرّتين ⇒ إشعار واحد", env.notifications.length === 1, `count=${env.notifications.length}`);
}

/* 5) نافذة ظاهرة ⇒ الصفحة تتولّى العرض، لا إشعار من الـ SW ---------------- */
{
  const env = createSwEnv({ visibleClient: true });
  await env.push(pushPayload({ messageId: "m-9", conversationId: "c-4" }));
  await wait(700);
  check("نافذة ظاهرة ⇒ لا إشعار خلفي مكرر", env.notifications.length === 0, `count=${env.notifications.length}`);
}

/* 6) مكالمة فائتة لا تستبدل إشعار المحادثة (tag منفصل) ---------------------- */
{
  const env = createSwEnv();
  await env.push(pushPayload({ messageId: "m-3", conversationId: "c-5" }));
  await wait(700);
  await env.push({
    data: { type: "call_ended", roomId: "r-1", conversationId: "c-5", missed: "true", title: "مكالمة فائتة من أحمد", body: "مكالمة صوتية فائتة" },
  });
  await wait(300);
  const tags = env.notifications.map((n) => n.tag);
  check(
    "المكالمة الفائتة لها tag خاص ولا تستبدل رسالة المحادثة",
    tags.includes("conversation-c-5") && tags.includes("missed-r-1"),
    `tags=${JSON.stringify(tags)}`
  );
}

/* 7) إنهاء مكالمة غير فائتة: يستبدل الرنين ثم يُغلق (ويستوفي userVisibleOnly) */
{
  const env = createSwEnv();
  await env.push({
    notification: undefined,
    data: { type: "incoming_call", roomId: "r-2", conversationId: "c-6", title: "متصل", body: "📞" },
  });
  await wait(700);
  const ringingBefore = env.notifications.filter((n) => n.tag === "call-r-2").length;
  const endedPush = env.push({ data: { type: "call_ended", roomId: "r-2", missed: "false", title: "انتهت المكالمة", body: "" } });
  await wait(400);
  const shownEnded = env.notifications.filter((n) => n.tag === "call-r-2").length;
  await endedPush;
  const leftover = env.notifications.filter((n) => n.tag === "call-r-2").length;
  check(
    "إنهاء المكالمة: الرنين يُستبدل ثم يُغلق بعد لحظة",
    ringingBefore === 1 && shownEnded >= 1 && leftover === 0,
    `before=${ringingBefore} during=${shownEnded} after=${leftover}`
  );
}

/* 8) أول إشعار مكالمة واردة يبقى مرئياً (requireInteraction) --------------- */
{
  const env = createSwEnv();
  await env.push({
    notification: {
      title: "أحمد",
      body: "📞 مكالمة صوتية",
      tag: "call-r-7",
      requireInteraction: true,
      renotify: true,
      silent: false,
      vibrate: [500, 250, 500],
      actions: [{ action: "answer", title: "رد" }],
    },
    data: { type: "incoming_call", roomId: "r-7", conversationId: "c-7" },
  });
  await wait(700);
  const call = env.notifications.find((n) => n.tag === "call-r-7");
  check("المكالمة الواردة تُعرض بـ tag الغرفة وتبقى مرئية", Boolean(call && call.options.requireInteraction));
}

console.log(fails ? `\n❌ PUSH SW TESTS FAILED: ${fails}` : "\nPUSH SW TESTS PASSED");
process.exit(fails ? 1 : 0);
