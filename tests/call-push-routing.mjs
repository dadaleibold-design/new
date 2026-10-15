/*
 * اختبار مسار Push للمكالمات (v2.10) — Service Worker حقيقي داخل vm + فحص المصادر
 * -------------------------------------------------------------
 * (أ) سلوك firebase-messaging-sw.js عند دفعة incoming_call / call_ended:
 *     • التطبيق ظاهر ⇒ يُرسَل WA_CALL_PUSH إلى النافذة الظاهرة فقط (لا المخفية)
 *       ولا يُعرض إشعار نظام (فلا يرنّ الهاتف مرتين)
 *     • نافذتان ظاهرة ومخفية ⇒ استلام واحد فقط (لا رنين في كل التبويبات)
 *     • لا نافذة ظاهرة (التطبيق مغلق/خلفية) ⇒ إشعار مكالمة بزري الرد/الرفض
 *       بالـ tag = call-<roomId> وrequireInteraction
 *     • رسالة عادية والتطبيق ظاهر ⇒ السلوك القديم (لا WA_CALL_PUSH)
 *     • نقرة الجسم على إشعار مكالمة ⇒ action = answer (كزر الرد)
 *     • زر الرفض ⇒ action = decline
 *     • call_ended غير فائتة والتطبيق ظاهر ⇒ WA_CALL_PUSH بنوع call_ended
 * (ب) فحص المصادر: الموجّه يحوّل WA_CALL_PUSH إلى حدث wa-call-push، وpush.js
 *     لا يشغّل صوت الإشعار ولا يعرض إشعاراً مكرراً للمكالمات، وsend-push يتحقق
 *     من حالة الغرفة ويرسل إلى callee فقط.
 *
 * التشغيل: node tests/call-push-routing.mjs
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const SW_SOURCE = read("firebase-messaging-sw.js");

let fails = 0;
const check = (name, ok, extra = "") => {
  console.log(ok ? "✅" : "❌", name, extra);
  if (!ok) fails += 1;
};

/** هدف أحداث يحاكي الالتقاط ثم الفقاعة + stopImmediatePropagation */
class FakeEventTarget {
  constructor() {
    this.listeners = new Map();
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

/**
 * بيئة SW. clientsSpec: مصفوفة { visibilityState, url } لكل نافذة.
 * يسجّل كل postMessage على كل نافذة، وكل إشعار معروض، وكل نافذة فُتحت.
 */
function createSwEnv({ clientsSpec = [] } = {}) {
  const self = new FakeEventTarget();
  const notifications = [];
  const openedWindows = [];
  const waitPromises = [];
  const clientsLog = [];

  const clients = clientsSpec.map((spec, i) => ({
    id: `c${i}`,
    url: spec.url || "https://app.test/index.html",
    visibilityState: spec.visibilityState || "hidden",
    focus: () => Promise.resolve(),
    postMessage(msg) {
      clientsLog.push({ id: `c${i}`, msg });
    },
  }));

  self.location = { origin: "https://app.test", href: "https://app.test/firebase-messaging-sw.js" };
  self.registration = {
    scope: "https://app.test/firebase-cloud-messaging-push-scope",
    showNotification(title, options) {
      const record = {
        title,
        options,
        tag: options.tag,
        data: options.data,
        close() {
          const i = notifications.indexOf(this);
          if (i >= 0) notifications.splice(i, 1);
        },
      };
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
  self.clients = {
    matchAll: () => Promise.resolve(clients),
    openWindow: (url) => {
      openedWindows.push(url);
      return Promise.resolve(null);
    },
    claim: () => Promise.resolve(),
  };
  self.skipWaiting = () => {};

  const logs = [];
  const context = {
    self,
    console: {
      log: (...a) => logs.push(["log", ...a]),
      warn: (...a) => logs.push(["warn", ...a]),
      error: (...a) => logs.push(["error", ...a]),
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
    // لا نحمّل Firebase في هذا الاختبار: مسار الدفعة الخام يكفي
    importScripts() {
      throw new Error("importScripts unavailable in routing test");
    },
  };

  vm.createContext(context);
  vm.runInContext(SW_SOURCE, context, { filename: "firebase-messaging-sw.js" });

  return {
    self,
    notifications,
    openedWindows,
    clientsLog,
    logs,
    /** يرسل دفعة push خام ويُرجع بعد اكتمال waitUntil */
    async push(raw) {
      const pending = [];
      const event = {
        data: { json: () => raw },
        waitUntil: (p) => pending.push(p),
      };
      self.dispatch("push", event);
      await Promise.all(pending);
    },
    /** ينقر إشعاراً معروضاً: action = "" للجسم، أو "answer"/"decline" للزر */
    async click(notification, action = "") {
      const pending = [];
      const event = {
        action,
        notification: { data: notification.data, close() {} },
        waitUntil: (p) => pending.push(p),
      };
      self.dispatch("notificationclick", event);
      await Promise.all(pending);
    },
  };
}

const callPush = (overrides = {}) => ({
  data: {
    type: "incoming_call",
    roomId: "room-123",
    conversationId: "conv-1",
    callerId: "caller-1",
    calleeId: "callee-1",
    callType: "audio",
    title: "أحمد",
    body: "📞 مكالمة صوتية واردة — اضغط للرد",
    icon: "",
    ...overrides,
  },
});

const APP_WINDOW = (visibilityState) => ({ visibilityState, url: "https://app.test/index.html" });

/* ---------- (أ-1) التطبيق ظاهر: WA_CALL_PUSH بلا إشعار نظام ---------- */
{
  const env = createSwEnv({ clientsSpec: [APP_WINDOW("visible")] });
  await env.push(callPush());
  const forwarded = env.clientsLog.filter((x) => x.msg.type === "WA_CALL_PUSH");
  check("ظاهر ⇒ WA_CALL_PUSH إلى النافذة الظاهرة", forwarded.length === 1, `count=${forwarded.length}`);
  check(
    "الرسالة تحمل نوع الدفعة والحمولة كاملة",
    forwarded[0]?.msg.pushType === "incoming_call" && forwarded[0]?.msg.data.roomId === "room-123" && forwarded[0]?.msg.data.calleeId === "callee-1"
  );
  check("ظاهر ⇒ لا إشعار نظام (لا رنين مزدوج)", env.notifications.length === 0, `notifications=${env.notifications.length}`);
}

/* ---------- (أ-2) نافذتان: ظاهرة ومخفية ⇒ استلام واحد ---------- */
{
  const env = createSwEnv({ clientsSpec: [APP_WINDOW("hidden"), APP_WINDOW("visible")] });
  await env.push(callPush());
  const ids = env.clientsLog.filter((x) => x.msg.type === "WA_CALL_PUSH").map((x) => x.id);
  check("نافذتان ⇒ الظاهرة فقط تستلم (لا تكرار بين التبويبات)", ids.length === 1 && ids[0] === "c1", `ids=${ids.join(",")}`);
}

/* ---------- (أ-3) لا نافذة ظاهرة: إشعار النظام بالرد/الرفض ---------- */
{
  const env = createSwEnv({ clientsSpec: [APP_WINDOW("hidden")] });
  await env.push(callPush());
  check("خلفية ⇒ لا WA_CALL_PUSH إلى النوافذ المخفية", env.clientsLog.length === 0);
  const n = env.notifications[0];
  check("خلفية ⇒ إشعار مكالمة معروض", env.notifications.length === 1 && Boolean(n));
  check("tag الإشعار = call-<roomId>", n?.tag === "call-room-123", n?.tag);
  check("الإشعار يبقى حتى التفاعل (requireInteraction)", n?.options.requireInteraction === true);
  const actions = (n?.options.actions || []).map((a) => a.action).join(",");
  check("زرا الرد والرفض موجودان", actions === "answer,decline", actions);
}

/* ---------- (أ-4) لا نافذة على الإطلاق (التطبيق مغلق) ---------- */
{
  const env = createSwEnv({ clientsSpec: [] });
  await env.push(callPush());
  check("التطبيق مغلق ⇒ إشعار مكالمة يُعرض", env.notifications.length === 1 && env.notifications[0].tag === "call-room-123");
}

/* ---------- (أ-5) رسالة عادية والتطبيق ظاهر: السلوك القديم ---------- */
{
  const env = createSwEnv({ clientsSpec: [APP_WINDOW("visible")] });
  await env.push({ data: { type: "message", conversationId: "c1", messageId: "m1", title: "t", body: "b" } });
  const callPushes = env.clientsLog.filter((x) => x.msg.type === "WA_CALL_PUSH");
  check("رسالة ⇒ لا WA_CALL_PUSH", callPushes.length === 0);
  check("رسالة + ظاهر ⇒ تُترك للصفحة (بلا إشعار نظام) كما كان", env.notifications.length === 0);
}

/* ---------- (أ-6) call_ended غير فائتة + ظاهر ⇒ WA_CALL_PUSH ---------- */
{
  const env = createSwEnv({ clientsSpec: [APP_WINDOW("visible")] });
  await env.push({ data: { type: "call_ended", roomId: "room-9", missed: "false", title: "انتهت", body: "" } });
  const m = env.clientsLog.find((x) => x.msg.type === "WA_CALL_PUSH");
  check("call_ended + ظاهر ⇒ WA_CALL_PUSH بنوع call_ended", m?.msg.pushType === "call_ended" && m?.msg.data.roomId === "room-9");
}

/* ---------- (أ-7) نقرات الإشعار ---------- */
{
  const env = createSwEnv({ clientsSpec: [] });
  await env.push(callPush());
  const note = env.notifications[0];
  await env.click(note, "");
  check("نقرة الجسم ⇒ الرابط answer_call", env.openedWindows.some((u) => /answer_call=room-123/.test(u)), env.openedWindows[0]);

  const env2 = createSwEnv({ clientsSpec: [APP_WINDOW("visible")] });
  await env2.push(callPush({ title: "x" }));
  // ظاهر ⇒ لا إشعار؛ نحاكي إشعاراً معروضاً من دفعة سابقة للنقر
  const fake = { data: { type: "incoming_call", roomId: "room-123", conversationId: "conv-1", callerId: "caller-1" } };
  await env2.click(fake, "");
  const opened = env2.clientsLog.find((x) => x.msg.type === "OPEN_CONVERSATION");
  check("نقرة الجسم ⇒ action = answer (كزر الرد)", opened?.msg.action === "answer", opened?.msg.action);
  check("نقرة الجسم ⇒ roomId يصل للتطبيق", opened?.msg.roomId === "room-123");

  const env3 = createSwEnv({ clientsSpec: [APP_WINDOW("visible")] });
  await env3.click(fake, "decline");
  const declined = env3.clientsLog.find((x) => x.msg.type === "OPEN_CONVERSATION");
  check("زر الرفض ⇒ action = decline", declined?.msg.action === "decline", declined?.msg.action);

  const env4 = createSwEnv({ clientsSpec: [APP_WINDOW("visible")] });
  await env4.click({ data: { type: "message", conversationId: "c9", messageId: "m9" } }, "");
  const msgOpen = env4.clientsLog.find((x) => x.msg.type === "OPEN_CONVERSATION");
  check("رسالة ⇒ action يبقى open (لا تغيير للسلوك القديم)", msgOpen?.msg.action === "open", msgOpen?.msg.action);
}

/* ---------- (أ-8) بناء SW ---------- */
{
  const env = createSwEnv({ clientsSpec: [] });
  check("SW_BUILD = 2026-10-15.1", env.self.__WA_MESSAGING_SW_BUILD === "2026-10-15.1", env.self.__WA_MESSAGING_SW_BUILD);
}

/* ---------- (ب) فحص المصادر ---------- */
const router = read("js/notification-router.js");
const push = read("js/push.js");
const calls = read("js/calls.js");
const app = read("js/app.js");
const sendPush = read("supabase/functions/send-push/index.ts");

check("الموجّه يحوّل WA_CALL_PUSH إلى wa-call-push", /message\.type === "WA_CALL_PUSH"[\s\S]{0,300}wa-call-push/.test(router));
check("push.js: إشعارات المكالمات لا تشغّل صوت notify.mp3 ولا تعرض إشعاراً مكرراً", /isCallPushType\(data\.type\)[\s\S]{0,400}return;/.test(push));
check("push.js: يمرّر حدث wa-call-push بدل العرض", /new CustomEvent\("wa-call-push"/.test(push));
check("calls.js: يستمع إلى wa-call-push", /addEventListener\("wa-call-push"/.test(calls));
check("calls.js: call_ended تمر عبر handlePeerEnded بلا شرط connected", /if \(type === "call_ended"\)[\s\S]{0,200}handlePeerEnded\(\{ roomId \}\)/.test(calls));
check("calls.js: دفعة Push تتحقق من calleeId قبل الرنين", /data\.calleeId && data\.calleeId !== me\.id/.test(calls));
check("app.js: لا يوجد openCallFromNotification بعد الآن", !app.includes("openCallFromNotification"));
check("app.js: النقر يمر عبر presentIncomingCallFromRoom مع رجوع للمحادثة", /presentIncomingCallFromRoom\(route\.roomId/.test(app) && /if \(handled\.ok && handled\.data\) return;/.test(app));
check("send-push: حارس حالة الغرفة (ringing فقط) لـ incoming_call", /call not ringing/.test(sendPush) && /String\(room\.status \|\| ""\) !== "ringing"/.test(sendPush));
check("send-push: حداثة الرنين من started_at (ساعة الخادم) لـ incoming_call", /select\("started_at"\)/.test(sendPush) && /CALL_RING_MAX_AGE_MS/.test(sendPush));
check("send-push: الإرسال لـ callee_id فقط (لا بث)", /loadDeviceTokens\(recipientId\)/.test(sendPush) && !/loadAdminIds[\s\S]{0,40}incoming_call/.test(sendPush));

console.log(fails ? `\nFAILED ${fails}` : "\nPASSED call-push-routing");
process.exit(fails ? 1 : 0);
