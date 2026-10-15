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
function createSwEnv({ visibleClient = false, clientUrl = "https://app.test/index.html", sdkDelayMs = 0 } = {}) {
  const self = new FakeEventTarget();
  const notifications = [];
  const openedWindows = [];
  const posted = [];
  const waitPromises = [];
  const logs = []; // كل استدعاءات console.* داخل الـ SW (للتحقق من السجلات)
  const subscribeCalls = []; // يجب أن يبقى فارغاً: لا يُنشئ الـ SW اشتراكاً خارج FCM
  self.registration_pushManager = {
    subscribe: (opts) => {
      subscribeCalls.push(opts);
      return Promise.resolve(null);
    },
  };

  self.location = { origin: "https://app.test", href: "https://app.test/firebase-messaging-sw.js" };
  self.registration = {
    scope: "https://app.test/firebase-cloud-messaging-push-scope",
    pushManager: self.registration_pushManager,
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
    url: clientUrl,
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
    console: {
      log: (...args) => logs.push(["log", ...args]),
      warn: (...args) => logs.push(["warn", ...args]),
      error: (...args) => logs.push(["error", ...args]),
    },
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
      if (sdkDelayMs) await new Promise((r) => setTimeout(r, sdkDelayMs));
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
    logs,
    subscribeCalls,
    /** دفعة لا يمكن تحليلها (json يرمي خطأ) */
    async pushUnparseable() {
      const pending = [];
      const event = {
        data: {
          json: () => {
            throw new SyntaxError("bad json");
          },
          text: () => "",
        },
        waitUntil: (p) => pending.push(p),
      };
      self.dispatch("push", event);
      await Promise.all(pending);
    },
    /** تغيّر الاشتراك دون اشتراك جديد (الإلغاء) */
    async subscriptionChange() {
      const pending = [];
      const event = {
        oldSubscription: { options: { applicationServerKey: new Uint8Array([4, 1]) } },
        newSubscription: null,
        waitUntil: (p) => pending.push(p),
      };
      self.dispatch("pushsubscriptionchange", event);
      await Promise.all(pending);
    },
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
    tag: conversationId ? `chat-${conversationId}` : "whatsapp-message",
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
  check("بطاقة واحدة تعرض آخر رسالة فقط", env.notifications.length === 1 && bodies[0] === "الثانية");
  const latest = env.notifications[0];
  check("وسم المحادثة موحد مع إعادة تنبيه وصوت النظام",
    latest.tag === "chat-c-20" && latest.options.renotify === true && latest.options.silent === false);
  check("الاهتزاز محفوظ والنقرة تشير لآخر رسالة",
    latest.options.vibrate.length > 0 && latest.data.messageId === "d-2");

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

/* 5b) نافذة أخرى ظاهرة من الأصل نفسه لا تُسقط إشعار التطبيق ---------------- */
{
  const env = createSwEnv({ visibleClient: true, clientUrl: "https://app.test/help" });
  await env.push({
    data: {
      type: "new_message",
      messageId: "m-visible-other-page",
      conversationId: "c-visible-other-page",
      title: "سارة",
      body: "يجب ألا يُسقط هذا الإشعار",
    },
  });
  await wait(700);
  check(
    "نافذة ظاهرة خارج مسار التطبيق لا تمنع عرض إشعار الخلفية",
    env.notifications.some((n) => n.options.body === "يجب ألا يُسقط هذا الإشعار"),
    `count=${env.notifications.length}`
  );
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
    tags.includes("chat-c-5") && tags.includes("missed-r-1"),
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

/* 9) [السبب الجذري] نسخة SDK ناقصة (بلا عنوان) لا تُسقط نسختنا الكاملة ----- */
{
  const env = createSwEnv();
  await env.push({
    notification: { body: "مرحبا", tag: "chat-c-30" }, // بلا title ⇒ نسخة SDK ناقصة
    data: { type: "new_message", messageId: "m-30", conversationId: "c-30", title: "أحمد", body: "مرحبا", senderId: "u-2" },
  });
  await wait(900);
  const titles = env.notifications.map((n) => n.title);
  check(
    "نسخة SDK ناقصة لا تُسقط نسختنا: يبقى إشعار واحد مكتمل",
    env.notifications.length === 1 && titles[0] === "أحمد",
    `titles=${JSON.stringify(titles)}`
  );
}

/* 10) نسخة SDK متأخرة وناقصة (تُعرض بعد نسختنا بالـ tag نفسه) ⇒ مصالحة ---- */
{
  const env = createSwEnv({ sdkDelayMs: 300 });
  await env.push({
    notification: { body: "مرحبا", tag: "chat-c-31" },
    data: { type: "new_message", messageId: "m-31", conversationId: "c-31", title: "سارة", body: "مرحبا", senderId: "u-3" },
  });
  await wait(150);
  const titles = env.notifications.map((n) => n.title);
  check(
    "نسخة SDK متأخرة وناقصة تُستبدل بنسختنا الكاملة بعد المصالحة",
    env.notifications.length === 1 && titles[0] === "سارة",
    `titles=${JSON.stringify(titles)}`
  );
}

/* 11) دفعة غير قابلة للتحليل ⇒ إشعار عام (يحفظ شرط userVisibleOnly) ----------- */
{
  const env = createSwEnv();
  await env.pushUnparseable();
  const fallback = env.notifications.find((n) => n.tag === "push-fallback");
  check("دفعة غير قابلة للتحليل ⇒ إشعار عام بدل تجاهلها", Boolean(fallback) && fallback.title === "رسالة جديدة");
}

/* 12) تغيّر الاشتراك: لا اشتراك خارج FCM (كان يتعارض مع منطق SDK) ----------- */
{
  const env = createSwEnv();
  await env.subscriptionChange();
  check("pushsubscriptionchange لا يستدعي pushManager.subscribe", env.subscribeCalls.length === 0);
  check(
    "pushsubscriptionchange يُبلغ الصفحات لإعادة مزامنة التوكن",
    env.posted.some((m) => m?.type === "PUSH_RESUBSCRIBE")
  );
}

/* 13) السجلات: وصول الدفعة من FCM يُسجَّل بمعرّفها، وقرار العرض يُسجَّل ------- */
{
  const env = createSwEnv();
  await env.push({ ...pushPayload({ messageId: "m-40", conversationId: "c-40" }), fcmMessageId: "fcm-123" });
  await wait(100);
  const received = env.logs.find((a) => a[1] === "[push-sw]" && a[2] === "push received");
  const decision = env.logs.find((a) => a[1] === "[push-sw]" && String(a[2]).startsWith("decision:"));
  check(
    "سجل [push-sw] يثبت وصول الدفعة مع معرّف FCM ومن ثم قرار العرض",
    Boolean(received) && received[3]?.fcmMessageId === "fcm-123" && Boolean(decision),
    `received=${JSON.stringify(received?.[3] || null)}`
  );
}

/* 14) إشعار «مستخدم جديد» (للمشرفين): tag مستقل + نقرة تفتح محادثة معه ----- */
{
  const env = createSwEnv();
  await env.push({
    data: {
      type: "new_user",
      userId: "u-77",
      title: "👤 مستخدم جديد: سارة",
      body: "انضم إلى التطبيق — +966500000000 — اضغط لبدء محادثة",
    },
  });
  await wait(700);

  const notice = env.notifications.find((n) => n.tag === "new-user-u-77");
  check("إشعار المستخدم الجديد يُعرض بـ tag خاص بالمستخدم", Boolean(notice), env.notifications.map((n) => n.tag).join(","));
  check("عنوان إشعار المستخدم الجديد يحمل الاسم", /سارة/.test(notice?.title || ""), notice?.title || "");

  // مع نافذة مفتوحة ⇒ رسالة OPEN_CONVERSATION تحمل userId
  const warm = createSwEnv();
  await warm.click(notice?.data || { type: "new_user", userId: "u-77" });
  const msg = warm.posted.find((m) => m?.type === "OPEN_CONVERSATION");
  check("نقرة الإشعار ترسل userId للنافذة المفتوحة", msg?.userId === "u-77", JSON.stringify(msg || null));

  // بلا نافذة مفتوحة ⇒ رابط يحمل ?user=<id>
  const cold = createSwEnv();
  cold.self.clients.matchAll = () => Promise.resolve([]);
  await cold.click(notice?.data || { type: "new_user", userId: "u-77" });
  check(
    "نقرة بلا نافذة تفتح ؟user=<id> لبدء محادثة فورية",
    cold.openedWindows[0]?.includes("user=u-77"),
    cold.openedWindows[0] || "(لا نافذة)"
  );
}

console.log(fails ? `\n❌ PUSH SW TESTS FAILED: ${fails}` : "\nPUSH SW TESTS PASSED");
process.exit(fails ? 1 : 0);
