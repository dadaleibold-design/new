/*
 * تحقّق فعلي من هجرة v2.9 على PostgreSQL حقيقي (PGlite/WASM)
 * -------------------------------------------------------------
 * يشغّل هجرة v2.8 ثم هجرة v2.9 كما هي على محرّك PostgreSQL حقيقي مع بيئة
 * مصغّرة تحاكي Supabase (auth.uid / vault.decrypted_secrets / net.http_post /
 * push_delivery_log) ويتحقق من:
 *   • المستلم المباشر للمحادثة (user_id ⇄ admin_id) وحده يستلم إشعار الرسالة
 *   • المرسل خارج أطراف المحادثة (مراقبة المشرف العام) ⇒ لا إشعار لأي جهة
 *   • إشعار المكالمة (incoming_call / call_ended) = callee_id حصراً
 *   • رفض أي محاولة لتمرير سوبر أدمن أو طرف ثالث كمستلم (البوابة المركزية)
 *   • إشعار المستخدم الجديد = الإشعار الجماعي الوحيد (new_user بمستلم null)
 *   • سياسات RLS للمشرف العام (مراقبة كاملة) + مؤشرات push_diagnostics
 *   • وضع المراقبة للقراءة فقط: القراءة/التسليم لأطراف المحادثة حصراً
 *   • إعادة تنفيذ الهجرة بأمان (idempotent)
 *
 * التشغيل:
 *   npm i --no-save @electric-sql/pglite && node tests/sql-v29-postgres.mjs
 * (يتخطّى نفسه بلا فشل إن لم تكن الحزمة مثبّتة.)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let PGlite;
try {
  ({ PGlite } = await import("@electric-sql/pglite"));
} catch {
  console.log("⏭  اختبار PostgreSQL (PGlite) متخطّى — ثبّت الحزمة بـ: npm i --no-save @electric-sql/pglite");
  process.exit(0);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const MIGRATION_V28 = read("sql/migrations/2026-10-13_v2_8_admin_new_user_alerts_directory.sql");
const MIGRATION_V29 = read("sql/migrations/2026-10-13_v2_9_notification_recipient_isolation.sql");

const db = new PGlite();

let fails = 0;
const check = (name, ok, extra = "") => {
  console.log(ok ? "✅" : "❌", name, extra);
  if (!ok) fails += 1;
};

const U = (n) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
const ADMIN = "11111111-0000-4000-8000-000000000001";
const SUPER = "11111111-0000-4000-8000-000000000002";
const ADMIN_B = "11111111-0000-4000-8000-000000000003";
const USER_A = U(10);
const USER_B = U(11);
const USER_C = U(12);

/* ---------- بيئة مصغّرة تحاكي Supabase ---------- */
await db.exec(`
  create schema if not exists auth;
  create schema if not exists vault;
  create schema if not exists net;
  create schema if not exists storage;

  create or replace function auth.uid() returns uuid
  language sql stable as $$
    select nullif(current_setting('test.uid', true), '')::uuid;
  $$;

  create or replace function auth.role() returns text
  language sql stable as $$
    select coalesce(nullif(current_setting('test.role', true), ''), 'authenticated');
  $$;

  create table auth.users (id uuid primary key, email text);

  create table public.profiles (
    id uuid primary key,
    email text unique,
    phone text,
    display_name text,
    avatar_url text,
    is_admin boolean not null default false,
    is_super_admin boolean not null default false,
    is_blocked boolean not null default false,
    created_at timestamptz default now()
  );

  create table public.conversations (
    id uuid primary key default gen_random_uuid(),
    user_id uuid references public.profiles(id) on delete cascade,
    admin_id uuid references public.profiles(id) on delete cascade,
    last_message text,
    last_message_at timestamptz default now(),
    unique (user_id, admin_id)
  );

  create table public.messages (
    id uuid primary key default gen_random_uuid(),
    conversation_id uuid not null references public.conversations(id) on delete cascade,
    sender_id uuid not null references public.profiles(id) on delete cascade,
    content text,
    attachment_type text,
    message_type text not null default 'text',
    status text not null default 'sent',
    created_at timestamptz default now()
  );

  create table public.call_rooms (
    id uuid primary key default gen_random_uuid(),
    conversation_id uuid not null references public.conversations(id) on delete cascade,
    channel_name text,
    call_type text not null default 'audio',
    caller_id uuid not null references public.profiles(id) on delete cascade,
    callee_id uuid not null references public.profiles(id) on delete cascade,
    status text not null default 'ringing',
    started_at timestamptz not null default now(),
    answered_at timestamptz,
    ended_at timestamptz,
    created_at timestamptz not null default now()
  );

  create table public.call_logs (
    id uuid primary key default gen_random_uuid(),
    room_id uuid references public.call_rooms(id) on delete cascade,
    user_id uuid references public.profiles(id) on delete cascade,
    event text not null,
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
  );

  create table public.call_history_hidden (
    user_id uuid references public.profiles(id) on delete cascade,
    room_id uuid references public.call_rooms(id) on delete cascade,
    created_at timestamptz not null default now(),
    primary key (user_id, room_id)
  );

  create table public.fcm_tokens (id uuid primary key default gen_random_uuid(), user_id uuid, token text);

  create table public.push_delivery_log (
    id bigserial primary key,
    kind text not null,
    ref_id uuid,
    recipient_id uuid,
    request_id bigint,
    note text,
    created_at timestamptz not null default now()
  );

  create table vault.decrypted_secrets (name text, decrypted_secret text);
  create table net._http_response (id bigint, status_code int, content jsonb, error_msg text);

  -- كل نداء شبكة يُسجَّل بدل إرسال طلب حقيقي (شبيه بـ pg_net.http_post)
  create table public.test_http_posts (
    id bigserial primary key,
    url text,
    headers jsonb,
    body jsonb
  );

  create or replace function net.http_post(url text, headers jsonb, body jsonb, timeout_milliseconds int default 5000)
  returns bigint language plpgsql as $$
  declare v bigint;
  begin
    insert into public.test_http_posts(url, headers, body) values (url, headers, body) returning id into v;
    return v;
  end;
  $$;

  -- نسخة مطابقة لدالة is_admin_user في schema.sql (v2.2)
  create or replace function public.is_admin_user(p_user_id uuid default auth.uid())
  returns boolean language sql stable security definer set search_path = public as $$
    select exists (
      select 1 from public.profiles
      where id = p_user_id and (is_admin = true or is_super_admin = true) and is_blocked = false
    );
  $$;
`);

for (const t of [
  "profiles", "conversations", "messages", "call_rooms", "call_logs",
  "call_history_hidden", "fcm_tokens", "push_delivery_log",
]) {
  await db.exec(`alter table public.${t} enable row level security;`);
}

// أدوار Supabase + الأسرار (Vault) — بدونهما لن يخرج أي طلب شبكة
await db.exec(`
  do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
  do $$ begin create role anon; exception when duplicate_object then null; end $$;
  do $$ begin create role service_role; exception when duplicate_object then null; end $$;

  -- قيم متعمَّدة في Vault: يجب أن يتجاهلها المسار تماماً (v2.15 — بلا Vault)
  insert into vault.decrypted_secrets (name, decrypted_secret) values
    ('SEND_PUSH_URL', 'https://decoy.invalid/functions/v1/send-push'),
    ('SEND_PUSH_SECRET', 'decoy-secret-must-not-be-used'),
    ('SUPABASE_ANON_KEY', 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.signature');
`);

/* ---------- تشغيل الهجرتين (سلسلة حقيقية v2.8 → v2.9) ---------- */
try {
  await db.exec(MIGRATION_V28);
  await db.exec(MIGRATION_V29);
  check("هجرة v2.9 تُنفَّذ فوق v2.8 بلا أخطاء", true);
} catch (error) {
  check("هجرة v2.9 تُنفَّذ فوق v2.8 بلا أخطاء", false, String(error?.message || error));
  process.exit(1);
}

try {
  await db.exec(MIGRATION_V29);
  check("إعادة تنفيذ هجرة v2.9 بأمان (idempotent)", true);
} catch (error) {
  check("إعادة تنفيذ هجرة v2.9 بأمان (idempotent)", false, String(error?.message || error));
}

/* ---------- بيانات أساسية ---------- */
const insertProfile = (id, name, { admin = false, sup = false, blocked = false, email = null, phone = null } = {}) =>
  db.query(
    `insert into public.profiles (id, display_name, email, phone, is_admin, is_super_admin, is_blocked)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [id, name, email, phone, admin, sup, blocked],
  );

await insertProfile(ADMIN, "المشرف الأول", { admin: true, email: "admin1@example.com" });
await insertProfile(SUPER, "المشرف العام", { admin: true, sup: true, email: "almgawell17@gmail.com" });
await insertProfile(ADMIN_B, "مشرف آخر", { admin: true, email: "admin2@example.com" });
await insertProfile(USER_A, "سارة", { phone: "+966501234567" });
await insertProfile(USER_B, "خالد", { phone: "+966505550000" });
await insertProfile(USER_C, "هند", { phone: "+966507770000" });

// محادثة سارة ↔ المشرف الأول (المشرف العام ليس طرفاً فيها)
const convA = (await db.query(
  `insert into public.conversations (user_id, admin_id, last_message) values ($1,$2,'') returning id`,
  [USER_A, ADMIN],
)).rows[0].id;

// محادثة خالد ↔ المشرف العام (المشرف العام طرف مباشر)
const convSuper = (await db.query(
  `insert into public.conversations (user_id, admin_id, last_message) values ($1,$2,'') returning id`,
  [USER_B, SUPER],
)).rows[0].id;

// محادثة مشرف↔مشرف (بين المشرفين) — للتأكد من عدم تداخل الإشعارات
const convB = (await db.query(
  `insert into public.conversations (user_id, admin_id, last_message) values ($1,$2,'') returning id`,
  [USER_C, ADMIN_B],
)).rows[0].id;

// كل صف "أُرسل فعلاً" (request_id != null) يُحفظ هنا — للتحقق اللاحق من ثبات القاعدة
const allSent = [];
const seenKinds = new Set();
const logs = async (where = "", params = []) => {
  const rows = (await db.query(`select * from public.push_delivery_log ${where} order by id`, params)).rows;
  rows.forEach((row) => {
    if (row.request_id === null) return;
    seenKinds.add(row.kind);
    if (!allSent.some((r) => r.id === row.id)) allSent.push(row);
  });
  return rows;
};
const reset = async () => db.exec("delete from public.push_delivery_log; delete from public.test_http_posts;");

/* ============================================================
 * ① دوال الحراسة موجودة وصحيحة
 * ============================================================ */
const fnExists = async (name) =>
  (await db.query(`select count(*)::int n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                   where ns.nspname = 'public' and p.proname = $1`, [name])).rows[0].n > 0;

for (const fn of ["push_recipient_allowed", "push_skip_note", "conversation_direct_recipient", "is_super_admin_user"]) {
  check(`دالة الحراسة ${fn} موجودة`, await fnExists(fn));
}

const recipientOf = async (convId, sender) =>
  (await db.query("select public.conversation_direct_recipient($1,$2) as r", [convId, sender])).rows[0].r;

check("المستلم المباشر: المرسل user_id ⇒ admin_id", (await recipientOf(convA, USER_A)) === ADMIN);
check("المستلم المباشر: المرسل admin_id ⇒ user_id", (await recipientOf(convA, ADMIN)) === USER_A);
check("المستلم المباشر: مرسل خارج الأطراف ⇒ null", (await recipientOf(convA, SUPER)) === null);
check("المستلم المباشر: محادثة غير موجودة ⇒ null", (await recipientOf("99999999-0000-4000-8000-000000000099", USER_A)) === null);

const allowed = async (kind, ref, recipient, body = {}) =>
  (await db.query("select public.push_recipient_allowed($1,$2,$3,$4::jsonb) as r", [kind, ref, recipient, JSON.stringify(body)])).rows[0].r;

check("البوابة: رسالة من سارة إلى مشرفها ⇒ مسموحة",
  await allowed("new_message", null, ADMIN, { sender_id: USER_A, conversation_id: convA }));
check("البوابة: رسالة مستلمها المشرف العام (ليس طرفاً) ⇒ مرفوضة",
  !(await allowed("new_message", null, SUPER, { sender_id: USER_A, conversation_id: convA })));
check("البوابة: رسالة مستلمها مشرف آخر (ليس طرفاً) ⇒ مرفوضة",
  !(await allowed("new_message", null, ADMIN_B, { sender_id: USER_A, conversation_id: convA })));
check("البوابة: رسالة بلا محادثة ⇒ مرفوضة",
  !(await allowed("new_message", null, ADMIN, { sender_id: USER_A })));
check("البوابة: رسالة بمعرّف محادثة غير صالح ⇒ مرفوضة (بلا استثناء)",
  !(await allowed("new_message", null, ADMIN, { sender_id: USER_A, conversation_id: "not-a-uuid" })));
check("البوابة: new_user بمستلم فردي ⇒ مرفوضة (البث الجماعي وحده)",
  !(await allowed("new_user", null, SUPER, { type: "new_user" })));
check("البوابة: new_user بلا مستلم ⇒ مسموحة (بث للمشرفين)",
  await allowed("new_user", null, null, { type: "new_user" }));
check("البوابة: مكالمة بمستلم ليس callee ⇒ مرفوضة",
  !(await allowed("incoming_call", "00000000-0000-4000-8000-0000000000aa", SUPER, {})));

/* ============================================================
 * ② إشعار الرسائل: الطرف الآخر فقط
 * ============================================================ */
await reset();
await db.query(`insert into public.messages (conversation_id, sender_id, content) values ($1,$2,'مرحبا')`, [convA, USER_A]);

let rows = await logs();
check("رسالة سارة ⇒ إشعار واحد", rows.length === 1, `count=${rows.length}`);
check("رسالة سارة ⇒ المستلم هو المشرف المخصص لمحادثتها حصراً",
  rows[0]?.kind === "new_message" && rows[0]?.recipient_id === ADMIN, JSON.stringify(rows[0] || {}));
check("رسالة سارة ⇒ لا طلب شبكة إلا لجهة واحدة",
  (await db.query("select count(*)::int n from public.test_http_posts")).rows[0].n === 1);
const pushUrl = (await db.query("select url from public.test_http_posts order by id desc limit 1")).rows[0]?.url || "";
const pushHeaders = (await db.query("select headers from public.test_http_posts order by id desc limit 1")).rows[0]?.headers || {};
check("طلب الشبكة يستخدم الرابط المُضمَّن (لا قيمة Vault)",
  pushUrl === "https://gqocavvhkfzgxzscrjms.supabase.co/functions/v1/send-push", pushUrl);
check("طلب الشبكة يحمل السرّ المُضمَّن (لا قيمة Vault)",
  pushHeaders["x-send-push-secret"] === "my_send_push_19921121_almgawell_19921121", String(pushHeaders["x-send-push-secret"]));

await reset();
await db.query(`insert into public.messages (conversation_id, sender_id, content) values ($1,$2,'رد المشرف')`, [convA, ADMIN]);
rows = await logs();
check("رد المشرف ⇒ المستلم سارة (العكس صحيح)", rows.length === 1 && rows[0]?.recipient_id === USER_A, JSON.stringify(rows[0] || {}));

await reset();
await db.query(`insert into public.messages (conversation_id, sender_id, content) values ($1,$2,'مراقبة')`, [convA, SUPER]);
rows = await logs();
check("المشرف العام يكتب في محادثة ليست له ⇒ صفر إشعارات",
  rows.length === 1 && rows[0]?.recipient_id === null && /SKIPPED/.test(rows[0]?.note || ""), JSON.stringify(rows));
check("المشرف العام يكتب في محادثة ليست له ⇒ صفر طلبات شبكة",
  (await db.query("select count(*)::int n from public.test_http_posts")).rows[0].n === 0);

await reset();
await db.query(`insert into public.messages (conversation_id, sender_id, message_type, content) values ($1,$2,'call','📞 مكالمة')`, [convA, USER_A]);
check("بطاقة المكالمة داخل الرسائل لا تُنتج إشعار رسالة (لمسار المكالمات إشعاره)",
  (await db.query("select count(*)::int n from public.push_delivery_log")).rows[0].n === 0);

/* ============================================================
 * ③ إشعار المكالمات: callee_id حصراً
 * ============================================================ */
await reset();
const roomA = (await db.query(
  `insert into public.call_rooms (conversation_id, caller_id, callee_id, status) values ($1,$2,$3,'ringing') returning id`,
  [convA, USER_A, ADMIN],
)).rows[0].id;

rows = await logs();
check("مكالمة واردة ⇒ إشعار واحد فقط", rows.length === 1, `count=${rows.length}`);
check("مكالمة واردة ⇒ الرنين لـ callee_id حصراً",
  rows[0]?.kind === "incoming_call" && rows[0]?.recipient_id === ADMIN, JSON.stringify(rows[0] || {}));
check("مكالمة واردة ⇒ لا إشعار لأي حساب آخر (ومنهم المشرف العام)",
  !rows.some((r) => r.recipient_id === SUPER || r.recipient_id === ADMIN_B || r.recipient_id === USER_A));
const pushBody = (await db.query("select body from public.test_http_posts order by id desc limit 1")).rows[0]?.body || {};
check("حمولة المكالمة تُصرّح بالمستلم (recipient_id) وبـ callee_id",
  pushBody.callee_id === ADMIN && pushBody.recipient_id === ADMIN, JSON.stringify(pushBody));

await db.query(`update public.call_rooms set status = 'missed', ended_at = now() where id = $1`, [roomA]);
rows = await logs();
const ended = rows.filter((r) => r.kind === "call_ended");
check("انتهاء/فوات المكالمة ⇒ إشعار واحد إلى callee_id فقط",
  ended.length === 1 && ended[0]?.recipient_id === ADMIN, JSON.stringify(ended));
check("انتهاء المكالمة ⇒ لا إشعار للمشرف العام",
  !rows.some((r) => r.recipient_id === SUPER));

// المشرف العام طرف مباشر في مكالمته ⇒ يستقبل الرنين كأي مستخدم
await reset();
const roomSuper = (await db.query(
  `insert into public.call_rooms (conversation_id, caller_id, callee_id, status) values ($1,$2,$3,'ringing') returning id`,
  [convSuper, USER_B, SUPER],
)).rows[0].id;
rows = await logs();
check("المشرف العام كطرف مباشر (callee) ⇒ يستقبل رنين مكالمته هو",
  rows.length === 1 && rows[0].recipient_id === SUPER, JSON.stringify(rows));
await db.query(`update public.call_rooms set status = 'ended', ended_at = now() where id = $1`, [roomSuper]);

// محاولة توجيه رنين إلى المشرف العام في مكالمة ليست له (تجاوز مفترض)
await reset();
const roomB = (await db.query(
  `insert into public.call_rooms (conversation_id, caller_id, callee_id, status) values ($1,$2,$3,'ringing') returning id`,
  [convA, USER_A, ADMIN],
)).rows[0].id;
await reset();
await db.query(`select public.push_call_edge('incoming_call', $1, $2, $3::jsonb)`,
  [roomB, SUPER, JSON.stringify({ type: "incoming_call", room_id: roomB, callee_id: ADMIN })]);
rows = await logs();
check("محاولة رنين المشرف العام في مكالمة ليست له ⇒ مرفوضة تماماً",
  rows.length === 1 && /SKIPPED/.test(rows[0]?.note || "") && rows[0]?.request_id === null, JSON.stringify(rows));
check("محاولة الرنين المرفوضة ⇒ لا طلب شبكة", (await db.query("select count(*)::int n from public.test_http_posts")).rows[0].n === 0);
check("سبب الرفض يذكر الوضع الصامت للمشرف العام", /مشرف عام/.test(rows[0]?.note || ""), rows[0]?.note);

// محاولة إرسال إشعار رسالة إلى المشرف العام في محادثة غيره
await reset();
const msgId = (await db.query(
  `insert into public.messages (conversation_id, sender_id, content) values ($1,$2,'سرّي') returning id`,
  [convA, USER_A],
)).rows[0].id;
await reset();
await db.query(`select public.push_call_edge('new_message', $1, $2, $3::jsonb)`,
  [msgId, SUPER, JSON.stringify({ message_id: msgId, conversation_id: convA, sender_id: USER_A })]);
rows = await logs();
check("محاولة إرسال رسالة إلى المشرف العام (ليس طرفاً) ⇒ مرفوضة",
  rows.length === 1 && /SKIPPED/.test(rows[0]?.note || "") && rows[0]?.request_id === null, JSON.stringify(rows));

/* ============================================================
 * ④ إشعار المستخدم الجديد: البث الجماعي الوحيد
 * ============================================================ */
await reset();
await insertProfile(U(20), "مستخدم جديد", { phone: "0500000009", email: "phone.966500000009@users.local" });
rows = await logs("where kind = 'new_user'");
check("تسجيل مستخدم جديد ⇒ إشعار جماعي واحد (new_user)",
  rows.length === 1 && rows[0]?.recipient_id === null && rows[0]?.request_id !== null, JSON.stringify(rows[0] || {}));
check("إشعار المستخدم الجديد يحمل وسم admin_broadcast (لا يُفسَّر كرسالة/مكالمة)",
  (await db.query("select body from public.test_http_posts order by id desc limit 1")).rows[0]?.body?.category === "admin_broadcast");
check("إشعار المستخدم الجديد لا يحمل أي معرّف مكالمة",
  !("room_id" in ((await db.query("select body from public.test_http_posts order by id desc limit 1")).rows[0]?.body || {})));

const notifTypes = (await logs("where request_id is not null")).map((r) => r.kind);
check("الأنواع المرسلة فعلاً بعد كل الفحوص = الرسائل/المكالمات/المستخدم الجديد فقط",
  notifTypes.every((k) => ["new_message", "incoming_call", "call_ended", "new_user"].includes(k)), notifTypes.join(","));

/* ============================================================
 * ⑤ RLS: مراقبة كاملة للمشرف العام (سياسات موجودة)
 * ============================================================ */
const policyExists = async (table, policy) =>
  (await db.query(
    "select count(*)::int n from pg_policies where schemaname='public' and tablename=$1 and policyname=$2",
    [table, policy],
  )).rows[0].n > 0;

check("RLS: محادثات المشرف العام (قراءة فقط v2.11)", await policyExists("conversations", "conversations read superadmin"));
check("RLS: رسائل المشرف العام (قراءة فقط v2.11)", await policyExists("messages", "messages read superadmin"));
check("RLS: غرف المكالمات للمشرف العام (قراءة فقط v2.11)", await policyExists("call_rooms", "call rooms read superadmin"));
check("RLS: سجلات المكالمات للمشرف العام", await policyExists("call_logs", "call logs superadmin"));
check("RLS: سجل الإشعارات للمشرف العام", await policyExists("push_delivery_log", "push log superadmin read"));
check("RLS: سجل المكالمات المخفي مرئي للمشرف العام", await policyExists("call_history_hidden", "call history hidden superadmin read"));

// السياسات مقيّدة بالمشرف العام فعلاً (ليست مفتوحة للجميع)
const policyDefs = (await db.query(
  `select policyname, qual from pg_policies where schemaname='public' and policyname like '%superadmin%'`,
)).rows;
check("كل سياسات المشرف العام تستند إلى is_super_admin",
  policyDefs.length >= 5 && policyDefs.every((p) => /is_super_admin/.test(p.qual || "")), JSON.stringify(policyDefs.map((p) => p.policyname)));

/* ============================================================
 * ⑥ ثبات القاعدة: كل ما أُرسل فعلاً مطابق لقواعد العزل
 * ============================================================ */
let violations = 0;
for (const row of allSent) {
  if (row.kind === "new_user") {
    if (row.recipient_id !== null) violations += 1;
    continue;
  }
  if (row.kind === "new_message") {
    const source = (await db.query(
      "select sender_id, conversation_id from public.messages where id = $1", [row.ref_id],
    )).rows[0];
    if (!source) { violations += 1; continue; }
    const ok = await allowed("new_message", row.ref_id, row.recipient_id, {
      sender_id: source.sender_id,
      conversation_id: source.conversation_id,
    });
    if (!ok) violations += 1;
    continue;
  }
  if (!(await allowed(row.kind, row.ref_id, row.recipient_id, {}))) violations += 1;
}
check("كل الإشعارات المُرسلة فعلاً مطابقة لقواعد العزل (بلا استثناء واحد)",
  violations === 0, `rows=${allSent.length} violations=${violations}`);
check("الأنواع المُرسلة فعلاً تشمل الرسائل والمكالمات والمستخدم الجديد",
  ["new_message", "incoming_call", "call_ended", "new_user"].every((k) => seenKinds.has(k)),
  [...seenKinds].join(","));

/* ============================================================
 * ⑦ التشخيص
 * ============================================================ */
// محاولات مرفوضة إضافية (كي تُحسب مؤشرات التخطي/الوضع الصامت)
await db.query("select public.push_call_edge('incoming_call', $1, $2, '{}'::jsonb)", [roomB, SUPER]);
await db.query("select public.push_call_edge('new_message', $1, $2, $3::jsonb)",
  [msgId, SUPER, JSON.stringify({ message_id: msgId, conversation_id: convA, sender_id: USER_A })]);

await db.exec("set test.uid = ''");
const diag = (await db.query("select public.push_diagnostics() as d")).rows[0].d;
check("push_diagnostics يُبلّغ عن إصدار العزل", diag.isolation_version === "v2.9", String(diag.isolation_version));
check("push_diagnostics يُبلّغ وجود بوابة العزل", diag.isolation_gate === true);
check("push_diagnostics يعلن الوضع الصامت للمشرف العام", diag.recipient_isolation?.super_admin_silent === true);
check("push_diagnostics يحصي حالات التخطي", Number(diag.skipped_total) >= 1, String(diag.skipped_total));
check("push_diagnostics يحصي الإشعارات المُكتَمة عن المشرف العام", Number(diag.super_admin_silenced) >= 1, String(diag.super_admin_silenced));

/* ============================================================
 * ⑧ وضع المراقبة للقراءة فقط: القراءة/التسليم لأطراف المحادثة حصراً
 *    (المشرف العام يرى كل شيء، لكن اطلاعه لا يغيّر حالة أصحابها)
 * ============================================================ */
const setUid = (id) => db.exec(`set test.uid = '${id || ""}'`);
const statusesOf = async (convId) =>
  (await db.query(
    "select status from public.messages where conversation_id = $1 order by created_at, content",
    [convId],
  )).rows.map((r) => r.status);

// رسائل بحالة معروفة داخل محادثة المشرف العام ليس طرفاً فيها
await db.query("delete from public.messages where conversation_id = $1", [convA]);
await db.query(
  "insert into public.messages (conversation_id, sender_id, content, status) values ($1,$2,'أ','sent'), ($1,$3,'ب','sent')",
  [convA, USER_A, ADMIN],
);

await setUid(SUPER);
const readByObserver = (await db.query("select public.mark_conversation_read($1) as n", [convA])).rows[0].n;
check("مراقب (ليس طرفاً): mark_conversation_read ⇒ 0 بلا أي تعديل", readByObserver === 0, String(readByObserver));
check("مراقب: حالات الرسائل لم تتغيّر بعد محاولة القراءة",
  (await statusesOf(convA)).every((st) => st === "sent"), (await statusesOf(convA)).join(","));

const deliveredByObserver = (await db.query("select public.mark_messages_delivered($1) as n", [convA])).rows[0].n;
check("مراقب (ليس طرفاً): mark_messages_delivered ⇒ 0 بلا أي تعديل", deliveredByObserver === 0, String(deliveredByObserver));
check("مراقب: حالات الرسائل لم تتغيّر بعد محاولة التسليم",
  (await statusesOf(convA)).every((st) => st === "sent"), (await statusesOf(convA)).join(","));

await setUid(USER_A);
// رسالة الطرف الآخر وحدها هي المرشّحة للتسليم/القراءة (رسالتي أنا لا تُلمس)
const deliveredByParty = (await db.query("select public.mark_messages_delivered($1) as n", [convA])).rows[0].n;
check("طرف مباشر: mark_messages_delivered يعمل (✓✓ للمرسل)", deliveredByParty === 1, String(deliveredByParty));
const readByParty = (await db.query("select public.mark_conversation_read($1) as n", [convA])).rows[0].n;
check("طرف مباشر: mark_conversation_read يعمل (تصفير العدّاد)", readByParty === 1, String(readByParty));

const statusOf = async (sender) =>
  (await db.query(
    "select status from public.messages where conversation_id = $1 and sender_id = $2",
    [convA, sender],
  )).rows[0]?.status;
check("طرف مباشر: رسالة الطرف الآخر صارت read", (await statusOf(ADMIN)) === "read", String(await statusOf(ADMIN)));
check("طرف مباشر: رسالته هو لا تُلمس (تبقى كما هي)", (await statusOf(USER_A)) === "sent", String(await statusOf(USER_A)));

// المشرف العام في محادثته الشخصية طرفٌ مباشر ⇒ يعمل كالمعتاد بلا أي تعطيل
await setUid(SUPER);
await db.query(
  "insert into public.messages (conversation_id, sender_id, content, status) values ($1,$2,'ج','sent')",
  [convSuper, USER_B],
);
const readSuperOwn = (await db.query("select public.mark_conversation_read($1) as n", [convSuper])).rows[0].n;
check("المشرف العام في محادثته الشخصية: القراءة تعمل كالمعتاد", readSuperOwn === 1, String(readSuperOwn));

await setUid("");

/* ============================================================
 * ⑨ الهجرة على قاعدة ناقصة (بلا v2.8): تدهور آمن بلا أخطاء
 * ============================================================ */
{
  const bare = new PGlite();
  await bare.exec(`
    create schema if not exists auth;
    create schema if not exists vault;
    create schema if not exists net;
    create or replace function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('test.uid', true), '')::uuid; $$;
    create table public.profiles (
      id uuid primary key, display_name text, email text, phone text,
      is_admin boolean not null default false, is_super_admin boolean not null default false,
      is_blocked boolean not null default false, created_at timestamptz default now()
    );
    create table public.conversations (
      id uuid primary key default gen_random_uuid(),
      user_id uuid references public.profiles(id) on delete cascade,
      admin_id uuid references public.profiles(id) on delete cascade, last_message text
    );
    create table public.messages (
      id uuid primary key default gen_random_uuid(),
      conversation_id uuid references public.conversations(id) on delete cascade,
      sender_id uuid references public.profiles(id) on delete cascade,
      content text, attachment_type text, message_type text not null default 'text',
      status text not null default 'sent', created_at timestamptz default now()
    );
    create table public.call_rooms (
      id uuid primary key default gen_random_uuid(),
      conversation_id uuid, channel_name text, call_type text default 'audio',
      caller_id uuid, callee_id uuid, status text default 'ringing', created_at timestamptz default now()
    );
    create table public.push_delivery_log (
      id bigserial primary key, kind text not null, ref_id uuid, recipient_id uuid,
      request_id bigint, note text, created_at timestamptz default now()
    );
    create table public.fcm_tokens (id uuid primary key default gen_random_uuid(), user_id uuid, token text);
    create table public.test_http_posts (id bigserial primary key, url text, headers jsonb, body jsonb);
    create table vault.decrypted_secrets (name text, decrypted_secret text);
    create table net._http_response (id bigint, status_code int, content jsonb, error_msg text);
    create or replace function net.http_post(url text, headers jsonb, body jsonb, timeout_milliseconds int default 5000)
    returns bigint language plpgsql as $$
    declare v bigint; begin
      insert into public.test_http_posts(url, headers, body) values (url, headers, body) returning id into v;
      return v;
    end; $$;
    create or replace function public.is_admin_user(p_user_id uuid default auth.uid())
    returns boolean language sql stable security definer set search_path = public as $$
      select exists (select 1 from public.profiles where id = p_user_id and (is_admin or is_super_admin));
    $$;
    insert into vault.decrypted_secrets (name, decrypted_secret) values
      ('SEND_PUSH_URL', 'https://decoy.invalid/functions/v1/send-push'),
      ('SEND_PUSH_SECRET', 'decoy-secret-must-not-be-used'),
      ('SUPABASE_ANON_KEY', 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.signature');
  `);

  let bareError = null;
  try {
    await bare.exec(MIGRATION_V29);
  } catch (error) {
    bareError = String(error?.message || error);
  }
  check("الهجرة تعمل على قاعدة بلا v2.8 (دوال admin_recipient_ids غير موجودة)", bareError === null, bareError || "");

  const diagBare = await bare.query("select public.push_diagnostics() as d");
  check("push_diagnostics لا ينكسر بغياب v2.8 (admins_count = 0)",
    diagBare.rows[0]?.d?.admins_count === 0, JSON.stringify(diagBare.rows[0]?.d?.admins_count));

  await bare.query(`insert into public.profiles (id, display_name, is_admin) values ($1,'مشرف',true)`, [ADMIN]);
  await bare.query(`insert into public.profiles (id, display_name) values ($1,'مستخدم')`, [USER_A]);
  const bareConv = (await bare.query(
    `insert into public.conversations (user_id, admin_id) values ($1,$2) returning id`, [USER_A, ADMIN],
  )).rows[0].id;
  await bare.query(`insert into public.messages (conversation_id, sender_id, content) values ($1,$2,'مرحبا')`, [bareConv, USER_A]);
  const bareLog = (await bare.query(
    "select kind, recipient_id, note, request_id from public.push_delivery_log order by id desc limit 1",
  )).rows[0];
  check("مسار الرسائل يعمل كاملاً على القاعدة الناقصة",
    bareLog?.kind === "new_message" && bareLog?.recipient_id === ADMIN && bareLog?.request_id !== null, JSON.stringify(bareLog));
}

console.log(fails ? `\n❌ فحوصات فاشلة: ${fails}` : "\nكل فحوصات هجرة v2.9 نجحت");
process.exit(fails ? 1 : 0);
