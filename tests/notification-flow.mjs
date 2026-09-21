/*
 * اختبار تدفّق الإشعارات والعدّادات (jsdom)
 * -------------------------------------------------------------
 * يغطّي الحالات التي كانت تُفشل الإشعارات/العدّادات في الإصدار السابق:
 *
 *   1) الرابط  … ?conversation=<id>&message=<id>  (نافذة جديدة فتحها الإشعار)
 *   2) الهدف المخزّن … نقر إشعار وصل قبل أن يُصبح التطبيق جاهزاً
 *      (`wa_pending_route` في localStorage) → يجب أن يُفتح بعد الإقلاع
 *   3) رسالة Service Worker … {type:"OPEN_CONVERSATION"} → فتح + تمرير للرسالة
 *   4) العدّاد … رسالة لحظية في محادثة غير مفتوحة تزيد الشارة، والنقر عليها
 *      يصفّرها *فوراً* (قبل أي طلب شبكة)
 *
 * كل حالة تعمل في عملية Node مستقلة لأن وحدات المشروع تُقيَّم مرة واحدة لكل
 * عملية (حالة modules مشتركة) — والعزل يمنع تسرّب الحالة بين السيناريوهات.
 *
 * التشغيل:  node tests/notification-flow.mjs
 */
import { register } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCENARIOS = ["url", "pending-route", "sw-message", "unread"];
const requested = process.argv[2] || "all";

/* ------------------------------------------------------------------
 * أمّ الاختبار: يشغّل كل سيناريو في عملية منفصلة
 * ---------------------------------------------------------------- */
if (requested === "all") {
  let failed = 0;
  for (const scenario of SCENARIOS) {
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), scenario], {
      stdio: "inherit",
    });
    if (result.status !== 0) failed += 1;
  }
  console.log(failed ? `\n❌ SCENARIOS FAILED: ${failed}` : "\nALL SCENARIOS PASSED");
  process.exit(failed ? 1 : 0);
}

register("./hooks.mjs", import.meta.url);
const { JSDOM } = await import("jsdom");
const fs = await import("node:fs");
const path = await import("node:path");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HTML = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const CHAT_PARTIAL = fs.readFileSync(path.join(ROOT, "partials/chat-panel.html"), "utf8");

let fails = 0;
const check = (name, ok, extra = "") => {
  console.log(ok ? "✅" : "❌", name, extra || "");
  if (!ok) fails += 1;
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------
 * بيئة jsdom + Supabase وهمي (شبيه بـ tests/smoke.mjs مع مهلة SW)
 * ---------------------------------------------------------------- */
function createEnv({ url = "http://localhost/index.html", storage = {} } = {}) {
  const dom = new JSDOM(HTML, { url, pretendToBeVisual: true });
  const { window } = dom;

  for (const key of [
    "window", "document", "navigator", "localStorage", "sessionStorage",
    "HTMLElement", "Event", "CustomEvent", "DocumentFragment", "Node",
    "location", "history", "CSS", "MutationObserver",
  ]) {
    try { globalThis[key] = window[key]; } catch { /* موجود مسبقاً */ }
  }
  window.matchMedia = globalThis.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
  Object.entries(storage).forEach(([k, v]) => window.localStorage.setItem(k, v));

  /* --- بيانات وهمية --- */
  const ME = { id: "me", display_name: "أنا", is_admin: false, is_super_admin: false, email: null };
  const ADMIN = { id: "a1", display_name: "المشرف الأول", is_admin: true, email: "almgawell1@gmail.com" };
  const CONVERSATION = { id: "c1", user_id: "me", admin_id: "a1", last_message: "قديم", last_message_at: "2026-09-21T09:00:00Z" };
  const MESSAGES = [
    { id: "m1", conversation_id: "c1", sender_id: "a1", content: "رسالة قديمة", message_type: "text", status: "read", created_at: "2026-09-21T09:00:00Z" },
    { id: "m2", conversation_id: "c1", sender_id: "a1", content: "الرسالة التي جاء منها الإشعار", message_type: "text", status: "sent", created_at: "2026-09-21T09:05:00Z" },
    { id: "m3", conversation_id: "c1", sender_id: "me", content: "ردي", message_type: "text", status: "read", created_at: "2026-09-21T09:06:00Z" },
  ];
  // غير المقروء في "قاعدة البيانات" الوهمية: صفّان في c1 — يُصفَّران عندما
  // تُنفَّذ قراءة المحادثة (RPC أو UPDATE status='read') كما يحدث فعلياً.
  let unreadRows = [{ conversation_id: "c1" }, { conversation_id: "c1" }];

  const realtimeHandlers = [];
  const rpcCalls = [];
  const swMessageListeners = [];

  const mkq = (table) => {
    const st = { table, filters: [] };
    const q = {};
    ["select", "eq", "neq", "in", "or", "gt", "gte", "lt", "order", "limit",
      "insert", "update", "upsert", "delete"].forEach((m) => {
      q[m] = (...args) => {
        st.filters.push([m, ...args]);
        // محاكاة أثر UPDATE status='read' على العدّاد في قاعدة البيانات
        if (table === "messages" && m === "update" && args[0]?.status === "read") unreadRows = [];
        return q;
      };
    });
    const resolve = () => {
      if (table === "profiles") {
        if (st.filters.some((f) => f[0] === "eq" && f[1] === "id" && f[2] === "a1")) return ADMIN;
        if (st.filters.some((f) => f[0] === "eq" && f[1] === "id")) return ME;
        return [ADMIN];
      }
      if (table === "conversations") {
        if (st.filters.some((f) => f[0] === "eq" && f[1] === "id" && f[2] !== "c1")) return null;
        return st.filters.some((f) => f[0] === "eq" && f[1] === "id") ? CONVERSATION : [CONVERSATION];
      }
      if (table === "messages") {
        if (st.filters.some((f) => f[0] === "neq" && f[1] === "status")) return unreadRows;
        if (st.filters.some((f) => f[0] === "eq" && f[1] === "conversation_id")) return MESSAGES;
        return MESSAGES;
      }
      return [];
    };
    q.maybeSingle = async () => ({ data: resolve(), error: null });
    q.single = async () => ({ data: resolve(), error: null });
    q.then = (res) => res({ data: resolve(), error: null });
    return q;
  };

  const registration = {
    active: true,
    scope: "http://localhost/firebase-cloud-messaging-push-scope/",
    showNotification: async () => {},
    getNotifications: async () => [],
    update: async () => {},
    addEventListener() {},
  };

  const serviceWorkerMock = {
    controller: null,
    addEventListener(type, cb) { if (type === "message") swMessageListeners.push(cb); },
    getRegistration: async () => registration,
    getRegistrations: async () => [registration],
    register: async () => registration,
    ready: Promise.resolve(registration),
  };

  const supabaseMock = {
    auth: {
      getSession: async () => ({ data: { session: { user: { id: "me" }, access_token: "t" } }, error: null }),
      onAuthStateChange() {},
      signOut: async () => ({}),
      signInWithPassword: async () => ({ data: { user: { id: "me" }, session: { user: { id: "me" } } }, error: null }),
    },
    from: mkq,
    rpc: async (name, args) => {
      rpcCalls.push({ name, args });
      if (name === "unread_counts") return { data: null, error: null }; // يسقط للمسار الاحتياطي (عدّ صفوف)
      if (name === "mark_conversation_read") {
        const count = unreadRows.length;
        unreadRows = [];
        return { data: count, error: null };
      }
      if (name === "push_diagnostics") return { data: { ok: true }, error: null };
      return { data: null, error: null };
    },
    channel: (name) => ({
      _handlers: [],
      state: "joined",
      topic: name,
      on(type, opts, cb) { this._handlers.push({ name, opts, cb }); return this; },
      subscribe(cb) { realtimeHandlers.push(...this._handlers); cb && setTimeout(() => cb("SUBSCRIBED"), 5); return this; },
      send: async () => "ok",
      track: async () => "ok",
      untrack: async () => "ok",
      presenceState: () => ({}),
    }),
    removeChannel() {},
    realtime: { connect() {}, disconnect() {}, connectionState: () => "connected" },
  };

  window.supabase = { createClient: () => supabaseMock };
  globalThis.supabase = window.supabase;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => CHAT_PARTIAL,
    json: async () => ({ token: "t" }),
  });

  window.HTMLMediaElement.prototype.play = async () => {};
  window.HTMLMediaElement.prototype.pause = () => {};
  globalThis.Notification = { permission: "granted", requestPermission: async () => "granted" };
  window.Notification = globalThis.Notification;
  globalThis.Audio = class { play() { return Promise.resolve(); } };
  Object.defineProperty(globalThis.navigator, "onLine", { value: true, configurable: true });
  Object.defineProperty(globalThis.navigator, "serviceWorker", { value: serviceWorkerMock, configurable: true });

  const errors = [];
  window.addEventListener("error", (e) => errors.push(e.message));
  process.on("unhandledRejection", (e) => errors.push("unhandled: " + (e?.message || e)));

  return { window, document: window.document, errors, realtimeHandlers, swMessageListeners, rpcCalls };
}

const importApp = (tag) => import(`file://${path.join(ROOT, "js/app.js")}?scenario=${tag}`);

/* ------------------------------------------------------------------
 * 1) الرابط: ?conversation=&message= (نافذة جديدة فتحها الإشعار)
 * ---------------------------------------------------------------- */
if (requested === "url") {
  const env = createEnv({ url: "http://localhost/index.html?conversation=c1&message=m2" });
  await importApp("url");
  await wait(1600);

  const doc = env.document;
  check("الرابط فتح شاشة الدردشة مباشرة", doc.body.classList.contains("viewing-chat"));
  check("الترويسة تعرض الطرف الصحيح", doc.querySelector("#chat-header-name")?.textContent?.trim() === "المشرف الأول");
  check("التمرير إلى الرسالة المطلوبة (تمييز مؤقت)", Boolean(doc.querySelector('.bubble-row[data-message-id="m2"].flash-message')));
  check("تم تنظيف وسائط الرابط بعد الاستهلاك", !env.window.location.search.includes("conversation="));
  check("عدّاد المحادثة صُفِّر عند الفتح", !doc.querySelector('[data-conversation-id="c1"] .unread-badge'));
  check("لا أخطاء تشغيل", env.errors.length === 0, env.errors.join(" | "));
}

/* ------------------------------------------------------------------
 * 2) الهدف المخزّن: نقر الإشعار وصل قبل جهوزية التطبيق
 * ---------------------------------------------------------------- */
if (requested === "pending-route") {
  const route = { conversationId: "c1", messageId: "m2", type: "new_message", source: "sw-message", at: Date.now() };
  const env = createEnv({
    storage: {
      wa_pending_route: JSON.stringify(route),
      wa_pending_route_at: String(route.at),
    },
  });
  await importApp("pending-route");
  await wait(2200);

  const doc = env.document;
  check("الهدف المخزّن فُتح بعد الإقلاع", doc.body.classList.contains("viewing-chat"));
  check("الطرف الصحيح في الترويسة", doc.querySelector("#chat-header-name")?.textContent?.trim() === "المشرف الأول");
  check("التمرير للرسالة المذكورة في الإشعار", Boolean(doc.querySelector('.bubble-row[data-message-id="m2"].flash-message')));
  check("استُخدمت دالة القراءة على الخادم", env.rpcCalls.some((c) => c.name === "mark_conversation_read" && c.args?.p_conversation_id === "c1"));
  check("الهدف لا يتكرّر (مُسِح من التخزين)", !env.window.localStorage.getItem("wa_pending_route"));
  check("لا أخطاء تشغيل", env.errors.length === 0, env.errors.join(" | "));
}

/* ------------------------------------------------------------------
 * 3) رسالة Service Worker (التطبيق مفتوح في تبويب آخر)
 * ---------------------------------------------------------------- */
if (requested === "sw-message") {
  const env = createEnv();
  await importApp("sw-message");
  await wait(1600);

  const doc = env.document;
  check("شاشة القائمة ظاهرة قبل النقر", !doc.body.classList.contains("viewing-chat"));
  check("مستمع رسائل Service Worker مسجَّل", env.swMessageListeners.length > 0);

  env.swMessageListeners.forEach((cb) =>
    cb({ data: { type: "OPEN_CONVERSATION", conversationId: "c1", messageId: "m2", notificationType: "new_message" } })
  );
  await wait(1200);

  check("نقر الإشعار فتح المحادثة الصحيحة", doc.body.classList.contains("viewing-chat"));
  check("الطرف الصحيح في الترويسة", doc.querySelector("#chat-header-name")?.textContent?.trim() === "المشرف الأول");
  check("الرسالة التي جاء منها الإشعار مميّزة", Boolean(doc.querySelector('.bubble-row[data-message-id="m2"].flash-message')));
  check("العدّاد صُفِّر", !doc.querySelector('[data-conversation-id="c1"] .unread-badge'));
  check("الرسائل ظهرت بلا تأخير", doc.querySelectorAll("#chat-messages .bubble-row:not(.call-row)").length >= 3);
  check("لا أخطاء تشغيل", env.errors.length === 0, env.errors.join(" | "));
}

/* ------------------------------------------------------------------
 * 4) العدّاد: زيادة فورية عند وصول رسالة + تصفير فوري بالنقر
 * ---------------------------------------------------------------- */
if (requested === "unread") {
  const env = createEnv();
  await importApp("unread");
  await wait(1600);

  const doc = env.document;
  const badgeText = () => doc.querySelector('[data-conversation-id="c1"] .unread-badge')?.textContent || "0";
  check("العدّاد الأولي من الشبكة = 2", badgeText() === "2", badgeText());

  const insertHandler = env.realtimeHandlers.find(
    (h) => h.opts?.table === "messages" && h.opts?.event === "INSERT" && !h.opts.filter
  );
  check("قناة مراقبة الرسائل مشتركة", Boolean(insertHandler));

  insertHandler.cb({ new: { id: "mX", conversation_id: "c1", sender_id: "a1", content: "ping", message_type: "text", created_at: new Date().toISOString() } });
  await wait(60);
  check("العدّاد زاد فوراً عند وصول رسالة", badgeText() === "3", badgeText());
  check("معاينة آخر رسالة تحدّثت", doc.querySelector('[data-conversation-id="c1"] .contact-sub')?.textContent?.includes("ping"));

  // النقر يجب أن يصفّر العدّاد *بشكل متزامن* قبل انتظار الشبكة
  doc.querySelector('[data-conversation-id="c1"]').click();
  check("العدّاد اختفى لحظة النقر (بلا انتظار شبكة)", !doc.querySelector('[data-conversation-id="c1"] .unread-badge'));
  check("فتحت شاشة الدردشة", doc.body.classList.contains("viewing-chat"));

  await wait(900);
  check("العدّاد ما زال صفراً بعد المزامنة", badgeText() === "0", badgeText());
  check("لا أخطاء تشغيل", env.errors.length === 0, env.errors.join(" | "));
}

console.log(fails ? `\n${fails} FAILED (${requested})` : `\nALL PASSED (${requested})`);
process.exit(fails ? 1 : 0);
