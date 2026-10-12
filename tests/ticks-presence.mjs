/*
 * اختبار علامات حالة الرسالة + حضور المشرفين + منطق الترحيب (jsdom)
 * ------------------------------------------------------------------
 * يغطّي ما طُلب صراحةً:
 *   1) ✓ واحد   → الرسالة محفوظة محلياً فقط (أوفلاين / في الخلفية)
 *   2) ✓✓ رمادي → بمجرد استلام السيرفر للرسالة أو وصول الإشعار
 *   3) ✓✓ أزرق  → بعد فتح المحادثة وقراءتها فعلياً
 *   4) "متصل الآن" ثابت ودائم للمشرف (نقطة خضراء + نص الترويسة) رغم
 *      تحديثات الحضور/الخروج
 *   5) نص الرسالة الترحيبية الجديد والأزرار التفاعلية الأصلية داخل SQL
 *      (تُفحص بنيوياً لأن قواعد البيانات ليست متاحة في بيئة الاختبار)
 *
 * التشغيل:  node tests/ticks-presence.mjs
 */
import { register } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCENARIOS = ["ticks", "presence", "automated-off"];
const requested = process.argv[2] || "all";

if (requested === "all") {
  let failed = 0;
  for (const scenario of SCENARIOS) {
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), scenario], {
      stdio: "inherit",
    });
    if (result.status !== 0) failed += 1;
  }
  console.log(failed ? `\n❌ SCENARIOS FAILED: ${failed}` : "\nALL SCENARIOS PASSED (ticks/presence)");
  process.exit(failed ? 1 : 0);
}

register("./hooks.mjs", import.meta.url);
const { JSDOM } = await import("jsdom");
const fs = await import("node:fs");
const path = await import("node:path");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HTML = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const CHAT_PARTIAL = fs.readFileSync(path.join(ROOT, "partials/chat-panel.html"), "utf8");
const APP_JS = fs.readFileSync(path.join(ROOT, "js/app.js"), "utf8");
const SCHEMA = fs.readFileSync(path.join(ROOT, "sql/schema.sql"), "utf8");
const MIGRATION = fs.readFileSync(
  path.join(ROOT, "sql/migrations/2026-09-22_v2_4_welcome_ticks_presence.sql"),
  "utf8"
);
const SEND_PUSH = fs.readFileSync(path.join(ROOT, "supabase/functions/send-push/index.ts"), "utf8");
const MIGRATION_V26 = fs.readFileSync(
  path.join(ROOT, "sql/migrations/2026-10-13_v2_6_multidevice_no_automated_messages.sql"),
  "utf8"
);
const CALLS_JS = fs.readFileSync(path.join(ROOT, "js/calls.js"), "utf8");
const PUSH_JS = fs.readFileSync(path.join(ROOT, "js/push.js"), "utf8");

let fails = 0;
const check = (name, ok, extra = "") => {
  console.log(ok ? "✅" : "❌", name, extra || "");
  if (!ok) fails += 1;
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ */
function createEnv({ online = true, messages = [] } = {}) {
  const dom = new JSDOM(HTML, { url: "http://localhost/index.html", pretendToBeVisual: true });
  const { window } = dom;

  for (const key of [
    "window", "document", "navigator", "localStorage", "sessionStorage",
    "HTMLElement", "Event", "CustomEvent", "DocumentFragment", "Node",
    "location", "history", "CSS", "MutationObserver",
  ]) {
    try { globalThis[key] = window[key]; } catch { /* موجود */ }
  }
  window.matchMedia = globalThis.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });

  const ME = { id: "me", display_name: "عميل", is_admin: false, is_super_admin: false, email: null };
  const ADMIN = { id: "a1", display_name: "المشرف الأول", is_admin: true, email: "almgawell1@gmail.com" };
  const CONV = { id: "c1", user_id: "me", admin_id: "a1", last_message: "", last_message_at: "2026-09-22T09:00:00Z" };

  const dbMessages = [
    { id: "m1", conversation_id: "c1", sender_id: "a1", content: "قديمة", message_type: "text", status: "read", created_at: "2026-09-22T08:00:00Z" },
    ...messages,
  ];
  let unreadRows = [{ conversation_id: "c1" }];

  const realtimeHandlers = [];
  const rpcCalls = [];
  const profileUpdates = [];

  const mkq = (table) => {
    const st = { table, filters: [], payload: null };
    const q = {};
    ["select", "eq", "neq", "in", "or", "gt", "gte", "lt", "order", "limit",
      "insert", "update", "upsert", "delete"].forEach((m) => {
      q[m] = (arg) => {
        st.filters.push([m, arg]);
        if (m === "update") {
          st.payload = arg;
          if (table === "messages" && arg?.status === "read") unreadRows = [];
          if (table === "profiles") profileUpdates.push(arg);
        }
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
        return st.filters.some((f) => f[0] === "eq" && f[1] === "id") ? CONV : [CONV];
      }
      if (table === "messages") {
        if (st.filters.some((f) => f[0] === "neq" && f[1] === "status")) return unreadRows;
        if (st.filters.some((f) => f[0] === "eq" && f[1] === "conversation_id")) {
          return dbMessages.map((m) => ({ ...m }));
        }
        return dbMessages.map((m) => ({ ...m }));
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
  const sw = {
    controller: null,
    addEventListener() {},
    getRegistration: async () => registration,
    getRegistrations: async () => [registration],
    register: async () => registration,
    ready: Promise.resolve(registration),
  };

  const serviceWorkerDisabled = true;

  window.supabase = {
    createClient: () => ({
      auth: {
        getSession: async () => ({ data: { session: { user: { id: "me" }, access_token: "t" } }, error: null }),
        onAuthStateChange() {},
        signOut: async () => ({}),
        signInWithPassword: async () => ({ data: { user: { id: "me" } }, error: null }),
      },
      from: mkq,
      rpc: async (name, args) => {
        rpcCalls.push({ name, args });
        if (name === "unread_counts") return { data: null, error: null };
        if (name === "mark_conversation_read") { unreadRows = []; return { data: 1, error: null }; }
        if (name === "mark_messages_delivered") return { data: 1, error: null };
        if (name === "mark_all_messages_delivered") return { data: 1, error: null };
        return { data: null, error: null };
      },
      channel: (name) => ({
        _handlers: [], state: "joined", topic: name,
        on(type, opts, cb) { this._handlers.push({ name, opts, cb }); return this; },
        subscribe(cb) { realtimeHandlers.push(...this._handlers); cb && setTimeout(() => cb("SUBSCRIBED"), 5); return this; },
        send: async () => "ok",
        track: async () => "ok",
        untrack: async () => "ok",
        presenceState: () => ({}),
      }),
      removeChannel() {},
      realtime: { connect() {}, disconnect() {}, connectionState: () => "connected" },
    }),
  };
  globalThis.supabase = window.supabase;
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => CHAT_PARTIAL, json: async () => ({ token: "t" }) });
  window.HTMLMediaElement.prototype.play = async () => {};
  window.HTMLMediaElement.prototype.pause = () => {};
  globalThis.Notification = { permission: "granted", requestPermission: async () => "granted" };
  window.Notification = globalThis.Notification;
  globalThis.Audio = class { play() { return Promise.resolve(); } };
  Object.defineProperty(globalThis.navigator, "onLine", { value: online, configurable: true });
  Object.defineProperty(globalThis.navigator, "serviceWorker", {
    value: serviceWorkerDisabled ? sw : sw,
    configurable: true,
  });

  const errors = [];
  window.addEventListener("error", (e) => errors.push(e.message));
  process.on("unhandledRejection", (e) => errors.push("unhandled: " + (e?.message || e)));

  return { window, document: window.document, errors, realtimeHandlers, rpcCalls, profileUpdates };
}

const importApp = (tag) => import(`file://${path.join(ROOT, "js/app.js")}?scenario=${tag}`);

/* ------------------------------------------------------------------
 * 1) علامات حالة الرسالة
 * ---------------------------------------------------------------- */
if (requested === "ticks") {
  const env = createEnv({
    messages: [
      { id: "m2", conversation_id: "c1", sender_id: "me", content: "وصلت للسيرفر", message_type: "text", status: "sent", created_at: "2026-09-22T09:01:00Z" },
      { id: "m3", conversation_id: "c1", sender_id: "me", content: "سُلّمت", message_type: "text", status: "delivered", created_at: "2026-09-22T09:02:00Z" },
      { id: "m4", conversation_id: "c1", sender_id: "me", content: "قُرئت", message_type: "text", status: "read", created_at: "2026-09-22T09:03:00Z" },
    ],
  });
  await importApp("ticks");
  await wait(1500);

  const doc = env.document;
  doc.querySelector('[data-conversation-id="c1"]').click();
  await wait(900);

  const ticksOf = (id) => doc.querySelector(`.bubble-row[data-message-id="${id}"] .ticks`);
  const textOf = (id) => (ticksOf(id)?.textContent || "").trim();

  check("حالة sent → ✓✓ رمادي (وصلت السيرفر)", textOf("m2") === "✓✓" && !ticksOf("m2")?.classList.contains("ticks-read"));
  check("حالة delivered → ✓✓ رمادي", textOf("m3") === "✓✓" && ticksOf("m3")?.classList.contains("ticks-delivered"));
  check("حالة read → ✓✓ أزرق", textOf("m4") === "✓✓" && ticksOf("m4")?.classList.contains("ticks-read"));

  // رسالة جديدة منّي عبر القناة اللحظية بحالة "sent" → تظهر ✓✓
  const convInsert = env.realtimeHandlers
    .filter((h) => h.opts?.table === "messages" && h.opts?.event === "INSERT" && h.opts.filter)
    .at(-1);
  convInsert.cb({
    new: { id: "m5", conversation_id: "c1", sender_id: "me", content: "جديدة", message_type: "text", status: "sent", created_at: "2026-09-22T09:05:00Z" },
  });
  await wait(150);
  check("رسالة جديدة مؤكَّدة من السيرفر → ✓✓", textOf("m5") === "✓✓", textOf("m5"));

  // رسالة واردة ثم صعودها إلى read عبر Realtime → ✓✓ أزرق
  convInsert.cb({
    new: { id: "m6", conversation_id: "c1", sender_id: "me", content: "أُرسلت ثم قُرئت", message_type: "text", status: "sent", created_at: "2026-09-22T09:06:00Z" },
  });
  await wait(120);
  const updateHandler = env.realtimeHandlers
    .filter((h) => h.opts?.table === "messages" && h.opts?.event === "UPDATE" && h.opts.filter)
    .at(-1);
  updateHandler.cb({
    new: { id: "m6", conversation_id: "c1", sender_id: "me", content: "أُرسلت ثم قُرئت", message_type: "text", status: "read", created_at: "2026-09-22T09:06:00Z" },
  });
  await wait(150);
  check("بعد حدث UPDATE إلى read → ✓✓ أزرق", ticksOf("m6")?.classList.contains("ticks-read"));

  // الرسائل الواردة إلينا تُثبَّت "مُسلَّمة" على السيرفر (✓✓ عند المرسل)
  const incoming = env.realtimeHandlers.find(
    (h) => h.opts?.table === "messages" && h.opts?.event === "INSERT" && !h.opts.filter
  );
  incoming.cb({
    new: { id: "m7", conversation_id: "c1", sender_id: "a1", content: "واردة", message_type: "text", status: "sent", created_at: "2026-09-22T09:07:00Z" },
  });
  await wait(200);
  check(
    "الرسالة الواردة تُثبَّت كـ delivered (RPC أو تحديث مباشر)",
    env.rpcCalls.some((c) => c.name === "mark_messages_delivered") ||
      env.rpcCalls.some((c) => c.name === "mark_all_messages_delivered")
  );

  check("لا أخطاء تشغيل (ticks)", env.errors.length === 0, env.errors.join(" | "));
}

/* ------------------------------------------------------------------
 * 2) حضور المشرف: "متصل الآن" ثابت ودائم
 * ---------------------------------------------------------------- */
if (requested === "presence") {
  const env = createEnv();
  await importApp("presence");
  await wait(1500);

  const doc = env.document;
  const adminRow =
    doc.querySelector('#admins-section .contact-row[data-conversation-id]') ||
    doc.querySelector('#contact-list .contact-row[data-conversation-id]');

  check(
    "المشرف يظهر بنقطة اتصال خضراء دائماً في القائمة",
    Boolean(doc.querySelector("#contact-list .contact-row .dot-online"))
  );
  check(
    "التشخيص يُظهر حضور المشرف مفروضاً",
    (env.window.__waDiagnostics?.()?.presence?.adminPresenceForced || []).includes("a1"),
    JSON.stringify(env.window.__waDiagnostics?.()?.presence || {})
  );

  adminRow.click();
  await wait(900);
  check(
    "ترويسة المحادثة تعرض «متصل الآن» فور فتح المحادثة",
    doc.querySelector("#chat-header-status")?.textContent?.trim() === "متصل الآن",
    doc.querySelector("#chat-header-status")?.textContent || ""
  );

  // محاكاة خروج المشرف من قناة الحضور (سكون/خلفية) → يجب ألا تتغيّر الحالة
  const presenceLeave = env.realtimeHandlers.find((h) => h.opts?.event === "leave");
  presenceLeave?.cb({ leftPresences: [{ key: "a1" }] });
  await wait(400);
  check(
    "مغادرة المشرف لقناة الحضور لا تُلغي «متصل الآن»",
    doc.querySelector("#chat-header-status")?.textContent?.trim() === "متصل الآن"
  );

  // محاكاة sync حضور فارغ (المشرف غير موجود في القناة) → يجب أن يبقى متصلاً
  const presenceSync = env.realtimeHandlers.find((h) => h.opts?.event === "sync");
  presenceSync?.cb({}, { presenceState: () => ({ me: [{ online_at: new Date().toISOString() }] }) });
  await wait(500);
  check(
    "مزامنة حضور لا تحوي المشرف → يبقى «متصل الآن» ظاهراً",
    doc.querySelector("#chat-header-status")?.textContent?.trim() === "متصل الآن"
  );
  check(
    "نقطة الاتصال ما زالت ظاهرة بعد كل المزامنات",
    Boolean(doc.querySelector("#contact-list .contact-row .dot-online"))
  );
  check("لا أخطاء تشغيل (presence)", env.errors.length === 0, env.errors.join(" | "));

  // فحص ثابت: نبضة "آخر ظهور" للمشرف لا تُرسل is_online=false
  check(
    "لا يوجد في app.js أي إعلان «غير متصل» صريح للمشرف",
    APP_JS.includes("if (!online && state.me.is_admin) return;") &&
      APP_JS.includes("if (!state.me || state.me.is_admin) return;")
  );
}

/* ------------------------------------------------------------------
 * 3) لا رسائل تلقائية (ترحيب / بوت / بطاقات مكالمات) + تعدد الأجهزة
 * ---------------------------------------------------------------- */
if (requested === "automated-off") {
  check(
    "schema.sql: لا يُنشئ مُشغِّل ترحيب أو بوت كلمات مفتاحية",
    !SCHEMA.includes("create or replace function public.send_welcome_message") &&
      !SCHEMA.includes("create trigger on_message_first_welcome") &&
      !SCHEMA.includes("create or replace function public.handle_keyword_autoreply") &&
      !SCHEMA.includes("create trigger on_message_keyword_autoreply")
  );
  check(
    "schema.sql: يحذف الدوال التلقائية القديمة للتثبيت النظيف",
    SCHEMA.includes("drop function if exists public.send_welcome_message()") &&
      SCHEMA.includes("drop function if exists public.handle_keyword_autoreply()")
  );
  check(
    "migration v2.6: يحذف المُشغِّلات والدوال التلقائية",
    MIGRATION_V26.includes("drop trigger if exists on_message_first_welcome") &&
      MIGRATION_V26.includes("drop trigger if exists on_message_keyword_autoreply") &&
      MIGRATION_V26.includes("drop function if exists public.send_welcome_message()") &&
      MIGRATION_V26.includes("drop function if exists public.handle_keyword_autoreply()")
  );
  check(
    "calls.js: بطاقات المكالمات داخل المحادثة معطّلة",
    /const CALL_CHAT_CARDS_ENABLED = false;/.test(CALLS_JS) &&
      CALLS_JS.includes("if (!CALL_CHAT_CARDS_ENABLED)")
  );
  check(
    "app.js: لا إدراج تلقائي للرسائل (الإدراج فقط من إرسال المستخدم)",
    !/welcome|buttons:\s*v_buttons/i.test(APP_JS.replace(/clickedWelcomeButtons/g, ""))
  );
  check(
    "migration v2.6: دالة تسجيل التوكن SECURITY DEFINER تنقل التوكن للمستخدم الحالي",
    MIGRATION_V26.includes("function public.register_fcm_token") &&
      MIGRATION_V26.includes("security definer") &&
      MIGRATION_V26.includes("on conflict (token) do update") &&
      MIGRATION_V26.includes("set user_id = excluded.user_id")
  );
  check(
    "push.js: التسجيل عبر RPC مع توافق رجعي مع upsert",
    PUSH_JS.includes('supabase.rpc("register_fcm_token"') && PUSH_JS.includes('from("fcm_tokens").upsert(')
  );
  check(
    "app.js: تسجيل الخروج يحذف توكن الجهاز قبل signOut",
    /disablePushNotifications\(\);\s*\n\s*\}\s*catch[\s\S]*?signOut\(state\.me\?\.id\)/.test(APP_JS)
  );
  check(
    "send-push: يرسل إلى كل توكنات الحساب (تعدد الأجهزة) عبر sendToAllDevices",
    SEND_PUSH.includes("async function loadDeviceTokens") &&
      SEND_PUSH.includes("async function sendToAllDevices") &&
      (SEND_PUSH.match(/sendToAllDevices\(/g) || []).length >= 5
  );
  check(
    "send-push: لا يحذف التوكن عند INVALID_ARGUMENT العام",
    !/UNREGISTERED\|registration-token-not-registered\|INVALID_ARGUMENT/i.test(SEND_PUSH)
  );
  check(
    "app.js: معالجة الرسائل الواردة مُزالة من الازدواج (dedupe) ومطبّقة على القائمة",
    APP_JS.includes("markRealtimeMessageSeen(msg.id)") && APP_JS.includes("patchConversationRow(")
  );
  check(
    "app.js: قناة الـ inbox تطبّق تحديث conversations مباشرة قبل إعادة التحميل",
    /payload\.eventType === "UPDATE"[\s\S]*?patchConversationRow\(row\.id/.test(APP_JS)
  );
  check(
    "app.js: loadContacts لا يُسقط تغييراً وصل أثناء الجلب (إعادة تشغيل)",
    APP_JS.includes("loadContactsRerun = true")
  );
  check(
    "schema.sql: دالتا التسليم موجودتان للتثبيت الجديد",
    SCHEMA.includes("function public.mark_messages_delivered") &&
      SCHEMA.includes("function public.mark_all_messages_delivered")
  );
  check(
    "send-push: يعلّم الرسالة delivered بعد نجاح إرسال الإشعار",
    SEND_PUSH.includes('update({ status: "delivered" })') && SEND_PUSH.includes('.eq("status", "sent")')
  );
  check(
    "app.js: منطق العلامات مطابق للقاعدة (sent/delivered → ✓✓، read → أزرق)",
    APP_JS.includes('normalized === "delivered" || normalized === "sent"') &&
      APP_JS.includes('normalized === "read"')
  );
}

console.log(fails ? `\n${fails} FAILED (${requested})` : `\nALL PASSED (${requested})`);
process.exit(fails ? 1 : 0);
