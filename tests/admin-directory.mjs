/*
 * اختبار ميزتي المشرفين (v2.8) — jsdom + فحوصات ثابتة على الملفات
 * -------------------------------------------------------------
 * (أ) إشعار «مستخدم جديد» لكل المشرفين (v3.0 — Database Webhook):
 *     - لا trigger ولا دالة إشعار في قاعدة البيانات (فُصلت في v3.0)
 *     - webhook على profiles INSERT ⇒ send-push (نوع new_user)
 *     - فرع new_user في send-push (كل المشرفين غير المحظورين × كل أجهزتهم)
 *     - توجيه النقرة: ?user=<id> ورسالة SW {type:"OPEN_CONVERSATION", userId}
 *       → فتح/إنشاء محادثة فورية مع المستخدم الجديد.
 * (ب) دليل المستخدمين الشامل (بحث حي في كل المسجّلين):
 *     - فتح الدليل يجلب كل المسجّلين من admin_directory_search
 *     - الكتابة تُصفّي ثم النقر على نتيجة يُنشئ محادثة فورية
 *     - مسار احتياطي (استعلام مباشر على profiles) عند غياب الدالة
 *     - غير المشرف لا يرى الدليل ولا يستدعي الدالة
 *     - Realtime: ملف شخصي جديد ⇒ تحديث الدليل + تنبيه قابل للنقر
 *
 * كل سيناريو يعمل في عملية Node منفصلة (حالة الوحدات تُقيَّم مرة واحدة للعملية).
 *
 * التشغيل: node tests/admin-directory.mjs [scenario|all]
 */
import { register } from "node:module";
import { installTestEnv } from "./test-env.mjs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCENARIOS = ["directory", "pagination", "fallback", "non-admin", "new-user-route", "realtime", "static"];
const requested = process.argv[2] || "all";

if (requested === "all") {
  let failed = 0;
  for (const scenario of SCENARIOS) {
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), scenario], {
      stdio: "inherit",
    });
    if (result.status !== 0) failed += 1;
  }
  console.log(failed ? `\n❌ SCENARIOS FAILED: ${failed}` : "\nALL ADMIN SCENARIOS PASSED");
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
 * فحوصات ثابتة على الملفات (قاعدة البيانات، الدالة، الـ SW، الموجّه)
 * ---------------------------------------------------------------- */
if (requested === "static") {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

  const migration = read("sql/migrations/2026-10-13_v2_8_admin_new_user_alerts_directory.sql");
  const schema = read("sql/schema.sql");
  const sw = read("firebase-messaging-sw.js");
  const router = read("js/notification-router.js");
  const sendPush = read("supabase/functions/send-push/index.ts");
  const indexHtml = read("index.html");
  const css = read("css/style.css");
  const appJs = read("js/app.js");
  const pkg = JSON.parse(read("package.json"));

  // --- قاعدة البيانات: لا مسار إشعارات (v3.0) ---
  check("الهجرة لم تعد تُنشئ trigger على profiles",
    !/create trigger on_profile_created_notify_admins/.test(migration));
  check("الهجرة لم تعد تعرّف notify_admins_new_profile",
    !/create or replace function public\.notify_admins_new_profile/.test(migration));
  check("الهجرة لم تعد تستدعي push_call_edge",
    !/push_call_edge/.test(migration) && !/net\.http_post/.test(migration));
  check("الهجرة تُبقي دليل المستخدمين (admin_directory_search)",
    /create or replace function public\.admin_directory_search\(/.test(migration));
  check("schema.sql يحوي trigger المستخدم الجديد (on_profile_created_notify_admins)",
    /create trigger on_profile_created_notify_admins/.test(schema));
  check("schema.sql يحوي admin_directory_search",
    /create or replace function public\.admin_directory_search\(/.test(schema));
  check("schema.sql لا يحوي admin_recipient_ids (حُذفت مع مسار الإشعارات)",
    !/create or replace function public\.admin_recipient_ids\(\)/.test(schema));

  // --- قاعدة البيانات: دليل المستخدمين ---
  check("الهجرة تعرّف admin_directory_search", /create or replace function public\.admin_directory_search\(/.test(migration));
  check("الدالة SECURITY DEFINER + search_path", /security definer\s+set search_path = public/.test(migration));
  check("الدالة تتحقق من صلاحية المشرف", /if v_uid is null or not public\.is_admin_user\(v_uid\) then/.test(migration));
  check("الدالة تُرجع المجموع الكلي مع المستخدمين", /'total', coalesce\(v_total, 0\)/.test(migration) && /'users', coalesce\(v_rows, '\[\]'::jsonb\)/.test(migration));
  check("الدالة تُرفق conversation_id للمحادثة القائمة", /conv\.id as conversation_id/.test(migration) && /c\.user_id = pe\.id and c\.admin_id = v_uid/.test(migration));
  check("البحث يطابق الاسم والبريد والهاتف", /pe\.display_name ilike v_pattern/.test(migration) && /coalesce\(pe\.email, ''\) ilike v_pattern/.test(migration) && /pe\.phone_digits like '%' \|\| v_digits \|\| '%'/.test(migration));
  check("البحث مُهيَّأ لمحارف LIKE الخاصة", /replace\(replace\(replace\(v_query/.test(migration) && /'_', '\\_'\)/.test(migration) && /'%', '\\%'\)/.test(migration));
  check("فهارس البحث الثلاثية (pg_trgm) مُضافة بأمان", /idx_profiles_display_name_trgm/.test(migration) && /exception when others then\s+raise notice 'فهرس الثلاثيات/.test(migration));
  check("صلاحية تنفيذ الدالة للمستخدم المسجّل فقط", /grant execute on function public\.admin_directory_search\(text, integer, integer\) to authenticated/.test(migration));
  check("schema.sql يحوي أيضاً admin_directory_search", /create or replace function public\.admin_directory_search\(/.test(schema));
  check("التشخيص لم يعد يعتمد على trigger قاعدة بيانات", !/'trigger_new_user', v_admin_triggers/.test(migration));

  // --- Edge Function (المسار الوحيد) ---
  check("send-push يعالج نوع new_user القادم من الـ Webhook",
    /case "new_user"/.test(sendPush) && /async function handleNewUser/.test(sendPush));
  check("send-push يجلب كل المشرفين (is_admin أو is_super_admin)",
    /\.or\("is_admin\.eq\.true,is_super_admin\.eq\.true"\)/.test(sendPush));
  check("send-push يستثني الحساب الجديد نفسه من البث",
    /\.filter\(\(id\) => id !== userId\)/.test(sendPush));
  check("send-push يرسل لكل أجهزة المشرفين بطلب واحد",
    /loadDeviceTokensForUsers/.test(sendPush) && /\.in\("user_id", ids\)/.test(sendPush));
  check("send-push يبني عنواناً يحمل اسم المستخدم الجديد",
    /مستخدم جديد: \$\{name\}/.test(sendPush));
  check("send-push يمرّر userId للتوجيه عند النقر",
    /userId,\s*\n\s*title:/.test(sendPush));
  check("send-push يرسل بأولوية عالية",
    /priority: "high"/.test(sendPush));
  check("send-push يتخطّى بلا مشرف أو بلا توكن",
    /skipped: "no admins"/.test(sendPush) && /skipped: "no fcm token"/.test(sendPush));
  check("send-push موثّق لجدول profiles عبر تريگر القاعدة / Webhook",
    /profiles/.test(sendPush) && (/Database Webhook/i.test(sendPush) || /on_profile_created_notify_admins/.test(sendPush)));

  // --- Service Worker ---
  check("SW version مُحدَّث", /SW_BUILD = "2026-10-15\.2"/.test(sw));
  check("SW يميّز حدث المستخدم الجديد (identityKey)", /return `user:\$\{data\.userId \|\| data\.user_id\}`;/.test(sw));
  check("SW يعطي إشعار كل مستخدم جديد tag خاصاً", /new-user-\$\{payload\.data\.userId \|\| payload\.data\.user_id\}/.test(sw));
  check("SW يضيف ?user=<id> إلى رابط الفتح", /payload\.data\?\.userId \|\| payload\.data\?\.user_id\s*\?\s*\{ user: payload\.data\.userId \|\| payload\.data\.user_id \}/.test(sw));
  check("SW يمرّر userId في رسالة OPEN_CONVERSATION", /type: "OPEN_CONVERSATION",[\s\S]{0,220}userId,/.test(sw));

  // --- الموجّه ---
  check("الموجّه يقرأ ?user من الرابط", /const userId = url\.searchParams\.get\("user"\)/.test(router));
  check("الموجّه يقرأ userId من حمولة الإشعار", /const userId = String\(data\.userId \|\| data\.user_id \|\| ""\)\.trim\(\)/.test(router));
  check("user مضاف إلى مفاتيح الرابط المُنظَّفة", /URL_KEYS = \["conversation", "message", "answer_call", "decline_call", "user"\]/.test(router));
  check("الهدف بلا محادثة مقبول (فتح مستخدم)", /if \(!route \|\| \(!route\.conversationId && !route\.roomId && !route\.userId\)\) return false;/.test(router));

  // --- الواجهة ---
  check("index.html يحوي قسم الدليل", /id="directory-section"/.test(indexHtml) && /id="directory-heading"/.test(indexHtml));
  check("index.html يحوي زر عرض المزيد وزر الإغلاق", /id="directory-more"/.test(indexHtml) && /id="directory-close"/.test(indexHtml));
  check("نسخ الأصول مُحدَّثة (كسر الكاش)", /style\.css\?v=28/.test(indexHtml) && /app\.js\?v=28/.test(indexHtml));
  check("CSS يحوي أنماط الدليل", /\.directory-tag\{/.test(css) && /\.directory-footer\{/.test(css) && /\.global-toast\.toast-action\{/.test(css));
  check("app.js يفتح محادثة مع مستخدم بالمعرّف", /async function openConversationWithUser\(userId/.test(appJs));
  check("app.js يوجّه إشعار المستخدم الجديد إلى المحادثة", /route\.userId/.test(appJs) && /route:new-user/.test(appJs));
  check("app.js يشترك لقناة دليل المشرفين", /function subscribeAdminDirectory\(\)/.test(appJs) && /subscribeAdminDirectory\(\)/.test(appJs));
  check("app.js يبحث عن الكل عبر RPC مع مسار احتياطي", /admin_directory_search/.test(appJs) && /directory:table/.test(appJs));

  // --- الاختبارات مُدرجة في npm test ---
  check("npm test يشغّل اختبار ميزتي المشرفين", /tests\/admin-directory\.mjs/.test(pkg.scripts.test));

  console.log(fails ? `\n${fails} فحص فشل` : "\nكل الفحوصات الثابتة نجحت");
  process.exit(fails ? 1 : 0);
}

/* ------------------------------------------------------------------
 * بيئة jsdom + Supabase وهمي
 * ---------------------------------------------------------------- */
const DIRECTORY_USERS = [
  {
    id: "u1",
    display_name: "سارة العتيبي",
    phone: "+966501234567",
    email: null,
    created_at: new Date().toISOString(),
    conversation_id: "c9",
  },
  {
    id: "u2",
    display_name: "محمد الحربي",
    phone: "00966500000002",
    email: null,
    created_at: new Date(Date.now() - 86400000).toISOString(),
    conversation_id: null,
  },
  {
    id: "u3",
    display_name: "نورة القحطاني",
    phone: null,
    email: "noura@example.com",
    created_at: "2026-01-05T10:00:00Z",
    conversation_id: null,
  },
];

function createEnv({
  url = "http://localhost/index.html",
  isAdmin = true,
  rpcAvailable = true,
  storage = {},
} = {}) {
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

  const ME = {
    id: "me",
    display_name: isAdmin ? "المشرف الأول" : "مستخدم عادي",
    is_admin: isAdmin,
    is_super_admin: false,
    email: isAdmin ? "almgawell1@gmail.com" : null,
  };
  const OTHER_ADMIN = { id: "a2", display_name: "المشرف الثاني", is_admin: true, email: "almgawell2@gmail.com" };
  const CONVERSATIONS = [
    { id: "c9", user_id: "u1", admin_id: "me", last_message: "مرحباً", last_message_at: "2026-10-10T10:00:00Z", user: { id: "u1", display_name: "سارة العتيبي" } },
  ];

  const PROFILE_ROWS = [ME, OTHER_ADMIN, ...DIRECTORY_USERS];
  const addProfile = (row) => PROFILE_ROWS.push(row);

  const rpcCalls = [];
  const realtimeHandlers = [];
  const swMessageListeners = [];
  const insertedConversations = [];
  const tableQueries = [];

  const mkq = (table) => {
    const st = { table, filters: [], range: null };
    const q = {};
    ["select", "eq", "neq", "in", "or", "gt", "gte", "lt", "order", "limit", "range",
      "insert", "update", "upsert", "delete"].forEach((m) => {
      q[m] = (...args) => {
        st.filters.push([m, ...args]);
        if (m === "range") st.range = args;
        if (table === "conversations" && m === "insert") insertedConversations.push(args[0]);
        return q;
      };
    });

    // نتيجة صف واحد (.single / .maybeSingle) — تطابق سلوك Supabase الحقيقي
    const resolveSingle = () => {
      if (table === "conversations") {
        if (st.filters.some((f) => f[0] === "eq" && f[1] === "id")) {
          return { id: "c9", user_id: "u1", admin_id: "me" };
        }
        if (st.filters.some((f) => f[0] === "insert")) {
          const row = st.filters.find((f) => f[0] === "insert")[1] || {};
          return { id: `new-conv-${insertedConversations.length}`, ...row };
        }
        // البحث عن محادثة قائمة بين (user_id, admin_id)
        const pair = CONVERSATIONS.find(
          (c) =>
            st.filters.some((f) => f[0] === "eq" && f[1] === "user_id" && f[2] === c.user_id) &&
            st.filters.some((f) => f[0] === "eq" && f[1] === "admin_id" && f[2] === c.admin_id)
        );
        return pair || null;
      }
      if (table === "profiles") {
        const idFilter = st.filters.find((f) => f[0] === "eq" && f[1] === "id");
        if (idFilter) return PROFILE_ROWS.find((p) => p.id === idFilter[2]) || null;
        return ME;
      }
      return null;
    };

    const resolve = () => {
      tableQueries.push({ table, filters: st.filters });
      if (table === "profiles") {
        if (st.filters.some((f) => f[0] === "eq" && f[1] === "id")) return ME;
        if (st.filters.some((f) => f[0] === "in" && f[1] === "email")) return [OTHER_ADMIN];
        if (st.filters.some((f) => f[0] === "eq" && f[1] === "is_admin")) return [OTHER_ADMIN];
        if (st.filters.some((f) => f[0] === "or" && String(f[1]).includes("is_admin.eq.true"))) {
          // قائمة المشرفين المعروضة للمستخدم العادي: من علامات قاعدة البيانات
          return [OTHER_ADMIN];
        }
        if (st.filters.some((f) => f[0] === "or")) {
          // المسار الاحتياطي: استعلام مباشر على profiles
          const orClause = String(st.filters.find((f) => f[0] === "or")[1] || "");
          const term = (orClause.match(/\.ilike\.%([^%,]*)/) || [])[1] || "";
          const filtered = DIRECTORY_USERS.filter((u) =>
            [u.display_name, u.email, u.phone]
              .filter(Boolean)
              .some((v) => String(v).toLowerCase().includes(term.toLowerCase()))
          );
          return filtered;
        }
        return DIRECTORY_USERS;
      }
      if (table === "conversations") {
        if (st.filters.some((f) => f[0] === "insert")) return null;
        return CONVERSATIONS;
      }
      if (table === "messages") return [];
      return [];
    };

    q.maybeSingle = async () => ({ data: resolveSingle(), error: null });
    q.single = async () => ({ data: resolveSingle(), count: null, error: null });
    q.then = (res) => res({ data: resolve(), count: resolve()?.length ?? null, error: null });
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
      if (name === "admin_directory_search") {
        if (!rpcAvailable) {
          return { data: null, error: { code: "PGRST202", message: "function not found" } };
        }
        if (!isAdmin) {
          return { data: null, error: { code: "42501", message: "غير مصرّح" } };
        }
        const query = String(args?.p_query || "").toLowerCase().trim();
        const digits = query.replace(/\D/g, "");
        const matched = DIRECTORY_USERS.filter((u) => {
          if (!query) return true;
          const haystack = [u.display_name, u.email, u.phone].filter(Boolean).join(" ").toLowerCase();
          if (haystack.includes(query)) return true;
          return digits.length >= 3 && String(u.phone || "").replace(/\D/g, "").includes(digits);
        });
        const offset = Number(args?.p_offset || 0);
        const limit = Number(args?.p_limit || 60);
        return {
          data: { total: matched.length, limit, offset, users: matched.slice(offset, offset + limit) },
          error: null,
        };
      }
      if (name === "unread_counts") return { data: [], error: null };
      if (name === "mark_conversation_read") return { data: 0, error: null };
      if (name === "push_diagnostics") return { data: { ok: true }, error: null };
      if (name === "register_fcm_token") return { data: { action: "inserted" }, error: null };
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

  return {
    window,
    document: window.document,
    errors,
    addProfile,
    rpcCalls,
    realtimeHandlers,
    swMessageListeners,
    insertedConversations,
    tableQueries,
  };
}

const importApp = (tag) => {
  installTestEnv(globalThis.window);
  return import(`file://${path.join(ROOT, "js/app.js")}?scenario=${tag}`);
};

const searchInput = (doc) => doc.querySelector(".search-box input");
const directoryVisible = (doc) => !doc.querySelector("#directory-heading")?.classList.contains("hidden");
const directoryRows = (doc) => [...doc.querySelectorAll("#directory-section .contact-row")];

async function typeInSearch(window, value) {
  const input = searchInput(window.document);
  input.value = value;
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  // debounce = 220ms + زمن الشبكة الوهمية
  await wait(400);
}

/* ------------------------------------------------------------------
 * 1) الدليل: فتح + بحث حي + إنشاء محادثة بالنقر
 * ---------------------------------------------------------------- */
if (requested === "directory") {
  const env = createEnv();
  await importApp("directory");
  await wait(1500);

  const doc = env.document;
  check("التطبيق أقلع (شاشة القائمة ظاهرة)", !doc.querySelector("#app-shell").classList.contains("hidden"));
  check("الدليل مخفي قبل البحث", !directoryVisible(doc));

  // فتح الدليل (تركيز على مربع البحث)
  const input = searchInput(doc);
  input.dispatchEvent(new env.window.Event("focus"));
  await wait(500);

  check("تركيز البحث يفتح دليل المستخدمين", directoryVisible(doc));
  check(
    "يُستدعى admin_directory_search لجلب كل المسجّلين",
    env.rpcCalls.some((c) => c.name === "admin_directory_search" && c.args?.p_query === "")
  );
  check("يظهر كل المسجّلين (3)", directoryRows(doc).length === 3, String(directoryRows(doc).length));
  check("العدّاد الكلي معروض", doc.querySelector("#directory-count")?.textContent === "3", doc.querySelector("#directory-count")?.textContent);
  check("قوائم المحادثات مخفية أثناء فتح الدليل", doc.querySelector("#users-section").classList.contains("hidden") && doc.querySelector("#admins-section").classList.contains("hidden"));
  const subs = directoryRows(doc).map((r) => r.querySelector(".contact-sub")?.textContent?.trim() || "");
  check("الصف يحمل بيانات التواصل + تاريخ الانضمام", /\d/.test(subs[0]) && /انضم/.test(subs[0]), subs[0]);
  check("المستخدم ذو المحادثة القائمة عليه شارة", Boolean(directoryRows(doc).find((r) => r.dataset.directoryUser === "u1")?.querySelector(".directory-tag")));

  // بحث حي بالاسم
  await typeInSearch(env.window, "نورة");
  let rows = directoryRows(doc);
  check("البحث الحي بالاسم يُصفّي النتائج", rows.length === 1 && rows[0].dataset.directoryUser === "u3", String(rows.length));
  check("نتيجة البحث تُظهر البريد كبيانات تواصل", /noura@example\.com/.test(rows[0].querySelector(".contact-sub")?.textContent || ""));

  // بحث بالهاتف
  await typeInSearch(env.window, "500000002");
  rows = directoryRows(doc);
  check("البحث الحي بالهاتف يُصفّي النتائج", rows.length === 1 && rows[0].dataset.directoryUser === "u2", String(rows.length));

  // حالة عدم وجود نتائج
  await typeInSearch(env.window, "لا-يوجد-مستخدم-بهذا-الاسم");
  check("حالة (لا توجد نتائج) تظهر بوضوح", Boolean(doc.querySelector("#directory-empty")));

  // النقر على نتيجة مستخدم بلا محادثة سابقة ⇒ إنشاء محادثة فورية
  await typeInSearch(env.window, "محمد");
  rows = directoryRows(doc);
  check("النتيجة المطلوبة ظاهرة قبل النقر", rows.length === 1 && rows[0].dataset.directoryUser === "u2");
  rows[0].click();
  await wait(900);

  check("أُنشئت محادثة جديدة مع المستخدم", env.insertedConversations.length === 1, JSON.stringify(env.insertedConversations));
  check("المحادثة بين المستخدم والمشرف الحالي", env.insertedConversations[0]?.user_id === "u2" && env.insertedConversations[0]?.admin_id === "me");
  check("فُتحت شاشة الدردشة", doc.body.classList.contains("viewing-chat"));
  check("ترويسة الدردشة تعرض اسم المستخدم", doc.querySelector("#chat-header-name")?.textContent?.trim() === "محمد الحربي");
  check("مربع البحث فُرِّغ بعد الفتح", searchInput(doc).value === "");
  check("الدليل أُغلق بعد الفتح", !directoryVisible(doc));
  check("قوائم المحادثات عادت للظهور", !doc.querySelector("#users-section").classList.contains("hidden"));
  check("لا أخطاء تشغيل", env.errors.length === 0, env.errors.join(" | "));

  console.log(fails ? `\n${fails} FAILED (directory)` : "\nALL PASSED (directory)");
  process.exit(fails ? 1 : 0);
}

/* ------------------------------------------------------------------
 * 2) الترقيم: «عرض المزيد» يجلب بقية المسجّلين (أكثر من صفحة واحدة)
 * ---------------------------------------------------------------- */
if (requested === "pagination") {
  for (let i = 0; i < 61; i += 1) {
    DIRECTORY_USERS.push({
      id: `p${i}`,
      display_name: `مستخدم ${i}`,
      phone: `+96650001${String(i).padStart(4, "0")}`,
      email: null,
      created_at: new Date(Date.now() - (i + 3) * 86400000).toISOString(),
      conversation_id: null,
    });
  }

  const env = createEnv();
  await importApp("pagination");
  await wait(1500);

  const doc = env.document;
  searchInput(doc).dispatchEvent(new env.window.Event("focus"));
  await wait(600);

  check("الصفحة الأولى = 60 مستخدماً", directoryRows(doc).length === 60, String(directoryRows(doc).length));
  check("العدّاد الكلي يعرض 64 مسجّلاً", doc.querySelector("#directory-count")?.textContent === "64", doc.querySelector("#directory-count")?.textContent);
  check("زر «عرض المزيد» ظاهر عند وجود بقية", !doc.querySelector("#directory-footer").classList.contains("hidden"));
  check("الزر يعرض التقدّم (60/64)", /60\/64/.test(doc.querySelector("#directory-more")?.textContent || ""), doc.querySelector("#directory-more")?.textContent);

  doc.querySelector("#directory-more").click();
  await wait(700);

  check("بعد «عرض المزيد» تظهر كل النتائج", directoryRows(doc).length === 64, String(directoryRows(doc).length));
  check("زر «عرض المزيد» يختفي بعد استكمال القائمة", doc.querySelector("#directory-footer").classList.contains("hidden"));
  check("لا تكرار في الصفوف المضافة", new Set(directoryRows(doc).map((r) => r.dataset.directoryUser)).size === 64);
  check("لا أخطاء تشغيل", env.errors.length === 0, env.errors.join(" | "));

  console.log(fails ? `\n${fails} FAILED (pagination)` : "\nALL PASSED (pagination)");
  process.exit(fails ? 1 : 0);
}

/* ------------------------------------------------------------------
 * 2) المسار الاحتياطي: الدالة غير موجودة ⇒ استعلام مباشر على profiles
 * ---------------------------------------------------------------- */
if (requested === "fallback") {
  const env = createEnv({ rpcAvailable: false });
  await importApp("fallback");
  await wait(1500);

  const doc = env.document;
  searchInput(doc).dispatchEvent(new env.window.Event("focus"));
  await wait(700);

  check("الدليل يفتح رغم غياب الدالة (مسار احتياطي)", directoryVisible(doc));
  check("استعلام مباشر على profiles بترتيب تاريخ التسجيل", env.tableQueries.some((q) => q.table === "profiles" && q.filters.some((f) => f[0] === "order" && f[1] === "created_at")));
  check("يظهر المسجّلون من الاستعلام المباشر", directoryRows(doc).length === DIRECTORY_USERS.length, String(directoryRows(doc).length));

  await typeInSearch(env.window, "سارة");
  check("البحث في المسار الاحتياطي يستخدم or/ilike", env.tableQueries.some((q) => q.filters.some((f) => f[0] === "or" && String(f[1]).includes("ilike"))));
  check("تنقية النتائج تعمل في المسار الاحتياطي", directoryRows(doc).length === 1, String(directoryRows(doc).length));
  check("لا أخطاء تشغيل", env.errors.length === 0, env.errors.join(" | "));

  console.log(fails ? `\n${fails} FAILED (fallback)` : "\nALL PASSED (fallback)");
  process.exit(fails ? 1 : 0);
}

/* ------------------------------------------------------------------
 * 3) غير المشرف: لا دليل ولا استدعاء لدالة المشرفين
 * ---------------------------------------------------------------- */
if (requested === "non-admin") {
  const env = createEnv({ isAdmin: false });
  await importApp("non-admin");
  await wait(1500);

  const doc = env.document;
  const input = searchInput(doc);
  input.dispatchEvent(new env.window.Event("focus"));
  await typeInSearch(env.window, "سارة");

  check("المستخدم العادي: الدليل لا يُفتح", !directoryVisible(doc));
  check("المستخدم العادي: لا استدعاء لدالة دليل المشرفين", !env.rpcCalls.some((c) => c.name === "admin_directory_search"));
  check("تصفية المحادثات المحلية ما زالت تعمل", Boolean(doc.querySelector("#contact-list")));
  check("لا أخطاء تشغيل", env.errors.length === 0, env.errors.join(" | "));

  console.log(fails ? `\n${fails} FAILED (non-admin)` : "\nALL PASSED (non-admin)");
  process.exit(fails ? 1 : 0);
}

/* ------------------------------------------------------------------
 * 4) إشعار «مستخدم جديد»: ?user=<id> + رسالة SW ⇒ محادثة فورية
 * ---------------------------------------------------------------- */
if (requested === "new-user-route") {
  const env = createEnv({ url: "http://localhost/index.html?user=u2" });
  await importApp("new-user-route");
  await wait(1800);

  const doc = env.document;
  check("الرابط ?user فتح شاشة الدردشة", doc.body.classList.contains("viewing-chat"));
  check("الترويسة تعرض المستخدم الجديد", doc.querySelector("#chat-header-name")?.textContent?.trim() === "محمد الحربي");
  check("أُنشئت محادثة مع المستخدم الجديد", env.insertedConversations.some((c) => c.user_id === "u2" && c.admin_id === "me"));
  check("تم تنظيف وسائط الرابط", !env.window.location.search.includes("user="));

  // رسالة SW (النقر على إشعار والمحادثة غير موجودة) ⇒ فتح/إنشاء محادثة
  const before = env.insertedConversations.length;
  const listener = env.swMessageListeners[0];
  check("مستمع رسائل Service Worker مسجَّل", typeof listener === "function");
  listener?.({
    data: { type: "OPEN_CONVERSATION", userId: "u3", notificationType: "new_user", action: "open" },
  });
  await wait(900);

  check("نقر إشعار المستخدم الجديد أنشأ محادثة ثانية", env.insertedConversations.length === before + 1, String(env.insertedConversations.length));
  check("المحادثة الجديدة مع المستخدم الصحيح", env.insertedConversations.at(-1)?.user_id === "u3");
  check("الترويسة تحدّثت للمستخدم الجديد", doc.querySelector("#chat-header-name")?.textContent?.trim() === "نورة القحطاني");
  check("لا أخطاء تشغيل", env.errors.length === 0, env.errors.join(" | "));

  console.log(fails ? `\n${fails} FAILED (new-user-route)` : "\nALL PASSED (new-user-route)");
  process.exit(fails ? 1 : 0);
}

/* ------------------------------------------------------------------
 * 5) Realtime: تسجيل مستخدم جديد ⇒ تحديث الدليل لحظياً + تنبيه قابل للنقر
 * ---------------------------------------------------------------- */
if (requested === "realtime") {
  const env = createEnv();
  await importApp("realtime");
  await wait(1500);

  const doc = env.document;
  check("قناة دليل المشرفين مشتركة", env.realtimeHandlers.some((h) => h.opts?.table === "profiles" && h.opts?.event === "INSERT"));

  // افتح الدليل أولاً ثم سجّل مستخدماً جديداً عبر Realtime
  searchInput(doc).dispatchEvent(new env.window.Event("focus"));
  await wait(500);
  check("الدليل مفتوح قبل الحدث", directoryRows(doc).length === 3, String(directoryRows(doc).length));

  const handler = env.realtimeHandlers.find((h) => h.opts?.table === "profiles" && h.opts?.event === "INSERT");
  const newUser = { id: "u9", display_name: "خالد الجديد", phone: "+966500000009", created_at: new Date().toISOString(), is_admin: false, conversation_id: null };
  env.addProfile(newUser);
  DIRECTORY_USERS.push(newUser);
  handler.cb({ new: { id: "u9", display_name: "خالد الجديد", created_at: new Date().toISOString(), is_admin: false } });
  await wait(600);

  check("الدليل تحدّث لحظياً بالمستخدم الجديد", directoryRows(doc).length === 4, String(directoryRows(doc).length));
  check("المستخدم الجديد يظهر في الدليل", Boolean(doc.querySelector('[data-directory-user="u9"]')));

  const toast = doc.querySelector("#global-toast");
  check("تنبيه المستخدم الجديد يظهر", !toast.classList.contains("hidden") && /خالد الجديد/.test(toast.textContent), toast.textContent);
  check("التنبيه قابل للنقر (toast-action)", toast.classList.contains("toast-action"));

  toast.click();
  await wait(900);
  check("النقر على التنبيه يفتح محادثة مع المستخدم الجديد", doc.body.classList.contains("viewing-chat"));
  check("أُنشئت محادثة معه", env.insertedConversations.some((c) => c.user_id === "u9"));
  check("لا أخطاء تشغيل", env.errors.length === 0, env.errors.join(" | "));

  console.log(fails ? `\n${fails} FAILED (realtime)` : "\nALL PASSED (realtime)");
  process.exit(fails ? 1 : 0);
}
