/*
 * تحقّق فعلي من هجرة v2.8 على PostgreSQL حقيقي (41 فحصاً) — PGlite/WASM
 * -------------------------------------------------------------
 * يشغّل ملف الهجرة كما هو على محرّك PostgreSQL حقيقي ويتحقق من:
 *   • دليل المستخدمين (البحث بالاسم/الهاتف/البريد، الترقيم، الصلاحيات، تهريب LIKE)
 *   • أن الهجرة لم تعد تحمل أي مسار إشعارات (v3.0: Database Webhooks فقط)
 *   • إعادة تنفيذ الهجرة بأمان (idempotent)
 *
 * التشغيل:
 *   npm i --no-save @electric-sql/pglite && node tests/sql-v28-postgres.mjs
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
const MIGRATION = fs.readFileSync(
  path.join(ROOT, "sql/migrations/2026-10-13_v2_8_admin_new_user_alerts_directory.sql"),
  "utf8",
);

const db = new PGlite();

let fails = 0;
const check = (name, ok, extra = "") => {
  console.log(ok ? "✅" : "❌", name, extra);
  if (!ok) fails += 1;
};

// ---------- بيئة مصغّرة تحاكي Supabase ----------
await db.exec(`
  create schema if not exists auth;
  create schema if not exists vault;
  create schema if not exists net;
  create schema if not exists extensions;

  create or replace function auth.uid() returns uuid
  language sql stable as $$
    select nullif(current_setting('test.uid', true), '')::uuid;
  $$;

  create or replace function auth.role() returns text
  language sql stable as $$
    select coalesce(nullif(current_setting('test.role', true), ''), 'authenticated');
  $$;

  create table auth.users (id uuid primary key, email text);
  create table public.storage_dummy (id int);

  create table public.profiles (
    id uuid primary key,
    email text,
    phone text,
    display_name text,
    avatar_url text,
    is_admin boolean not null default false,
    is_super_admin boolean not null default false,
    is_blocked boolean not null default false,
    is_online boolean not null default false,
    last_seen timestamptz default now(),
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

  create table public.push_delivery_log (
    id bigserial primary key,
    kind text not null,
    ref_id uuid,
    recipient_id uuid,
    request_id bigint,
    note text,
    created_at timestamptz not null default now()
  );

  create table public.fcm_tokens (id uuid primary key default gen_random_uuid(), user_id uuid, token text);

  -- نسخة مطابقة لدالة is_admin_user في schema.sql (v2.2)
  create or replace function public.is_admin_user(p_user_id uuid default auth.uid())
  returns boolean language sql stable security definer set search_path = public as $$
    select exists (
      select 1 from public.profiles
      where id = p_user_id and (is_admin = true or is_super_admin = true) and is_blocked = false
    );
  $$;
`);

// أدوار Supabase (authenticated / anon / service_role)
await db.exec(`
  do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
  do $$ begin create role anon; exception when duplicate_object then null; end $$;
  do $$ begin create role service_role; exception when duplicate_object then null; end $$;
`);

// pg_trgm (إن توفّر في PGlite) — الهجرة تتعامل مع غيابه بأمان
try {
  await db.exec("create extension if not exists pg_trgm;");
  console.log("ℹ️  pg_trgm متاح");
} catch (e) {
  console.log("ℹ️  pg_trgm غير متاح (الهجرة يجب أن تتخطّاه بأمان)");
}

// ---------- تشغيل الهجرة ----------
await db.exec(MIGRATION);
check("الهجرة تُنفَّذ بلا أخطاء", true);

// إعادة التنفيذ (idempotent)
await db.exec(MIGRATION);
check("إعادة تنفيذ الهجرة بأمان (idempotent)", true);

// ---------- (أ) لا مسار إشعارات في الهجرة (v3.0) ----------
const migrationCode = MIGRATION.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
check("الهجرة لا تُنشئ trigger إشعار للمستخدم الجديد",
  !/create trigger on_profile_created_notify_admins/.test(migrationCode));
check("الهجرة لا تعرّف notify_admins_new_profile",
  !/create or replace function public\.notify_admins_new_profile/.test(migrationCode));
check("الهجرة لا تستدعي push_call_edge أو net.http_post",
  !/push_call_edge|net\.http_post/.test(migrationCode));
check("الهجرة لا تقرأ من Vault", !/vault\./.test(migrationCode));
check("لا دوال إشعارات في القاعدة بعد الهجرة",
  (await db.query(`select count(*)::int n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
    where ns.nspname='public' and (p.proname like 'push_%' or p.proname like 'notify_%')`)).rows[0].n === 0);

// بيانات المستخدمين (كما في سيناريو الدليل)
const insertProfile = async (id, name, { admin = false, phone = null, email = null, blocked = false } = {}) =>
  db.query(
    `insert into public.profiles (id, display_name, phone, email, is_admin, is_blocked, created_at)
     values ($1,$2,$3,$4,$5,$6, now())`,
    [id, name, phone, email, admin, blocked],
  );

await insertProfile("00000000-0000-4000-8000-000000000001", "أول مستخدم");
await insertProfile("11111111-0000-4000-8000-000000000001", "المشرف الأول", { admin: true, email: "admin1@example.com" });
await insertProfile("11111111-0000-4000-8000-000000000002", "المشرف العام", { admin: true, email: "almgawell17@gmail.com" });
await db.query("update public.profiles set is_super_admin = true where id = '11111111-0000-4000-8000-000000000002'");
await insertProfile("11111111-0000-4000-8000-000000000003", "مشرف محظور", { admin: true, blocked: true });
await insertProfile("00000000-0000-4000-8000-000000000002", "سارة العتيبي", { phone: "+966501234567" });
await insertProfile("00000000-0000-4000-8000-000000000003", "مستخدم هاتف", {
  phone: "0500000000",
  email: "phone.966500000000@users.local",
});
await insertProfile("11111111-0000-4000-8000-000000000004", "مشرف جديد", { admin: true, email: "new-admin@example.com" });
await insertProfile("00000000-0000-4000-8000-000000000004", "مستخدم رابع");

// ---------- (ب) دليل المستخدمين ----------
const asUser = async (uid) => db.exec(`set test.uid = '${uid}'`);
await asUser("11111111-0000-4000-8000-000000000001");

// محادثة قائمة بين المشرف u-0002
const conv = await db.query(
  `insert into public.conversations (user_id, admin_id, last_message, last_message_at)
   values ('00000000-0000-4000-8000-000000000002','11111111-0000-4000-8000-000000000001','مرحباً', now())
   returning id`,
);

let dir = await db.query("select public.admin_directory_search('', 60, 0) as r");
let res = dir.rows[0].r;
const names = res.users.map((u) => u.display_name);
check("الدليل يرجع كل المسجّلين (بلا البحث)", res.users.length === 7, `count=${res.users.length} total=${res.total} names=${names.join("|")}`);
check("الدليل يستثني المشرف المستدعي نفسه", !res.users.some((u) => u.id === "11111111-0000-4000-8000-000000000001"));
check("الأحدث تسجيلاً أولاً في القائمة الكاملة", res.users[0].id === "00000000-0000-4000-8000-000000000004", res.users[0].display_name);
check("الدليل يرجّع conversation_id للمحادثة القائمة", res.users.find((u) => u.id === "00000000-0000-4000-8000-000000000002")?.conversation_id === conv.rows[0].id);
check("لا محادثة لمستخدم جديد (conversation_id = null)", res.users.find((u) => u.id === "00000000-0000-4000-8000-000000000003")?.conversation_id === null);
check("البريد الداخلي مستثنى من نتائج الدليل", res.users.find((u) => u.id === "00000000-0000-4000-8000-000000000003")?.email === null);

// بحث بالاسم (عربي)
res = (await db.query("select public.admin_directory_search('سارة', 60, 0) as r")).rows[0].r;
check("البحث بالاسم العربي يطابق", res.users.length === 1 && res.users[0].id === "00000000-0000-4000-8000-000000000002", `total=${res.total}`);
check("العدّاد الكلي مع البحث صحيح", res.total === 1);

// بحث بالهاتف (صيغة مختلفة + أرقام عربية)
res = (await db.query("select public.admin_directory_search('501234567', 60, 0) as r")).rows[0].r;
check("البحث بالهاتف الجزئي يطابق", res.users.length === 1, `total=${res.total}`);
res = (await db.query("select public.admin_directory_search('+966501234567', 60, 0) as r")).rows[0].r;
check("البحث برمز الدولة يطابق رغم اختلاف الصيغة", res.users.length === 1, `total=${res.total}`);
res = (await db.query("select public.admin_directory_search('٥٠١٢٣٤٥٦٧', 60, 0) as r")).rows[0].r;
check("البحث بالأرقام العربية الهندية يطابق", res.users.length === 1, `total=${res.total}`);

// بحث بالبريد
res = (await db.query("select public.admin_directory_search('ALMGAWELL17@', 60, 0) as r")).rows[0].r;
check("البحث بالبريد غير حسّاس لحالة الأحرف", res.users.length === 1 && res.users[0].id === "11111111-0000-4000-8000-000000000002", `total=${res.total}`);

// محارف LIKE الخاصة
res = (await db.query("select public.admin_directory_search('%', 60, 0) as r")).rows[0].r;
check("محرف % لا يُفسَّر كنمط مفتوح", res.users.length === 0, `total=${res.total}`);
res = (await db.query("select public.admin_directory_search('_', 60, 0) as r")).rows[0].r;
check("محرف _ لا يُفسَّر كنمط مفتوح", res.users.length === 0, `total=${res.total}`);

// الترقيم (pagination)
res = (await db.query("select public.admin_directory_search('', 2, 0) as r")).rows[0].r;
const firstPage = res.users.map((u) => u.id);
res = (await db.query("select public.admin_directory_search('', 2, 2) as r")).rows[0].r;
const secondPage = res.users.map((u) => u.id);
check("الترقيم: limit يحترم الحد", firstPage.length === 2 && secondPage.length === 2);
check("الترقيم: الصفحة الثانية لا تكرّر الأولى", !firstPage.some((id) => secondPage.includes(id)));
check("الترقيم: العدّاد الكلي لا يتأثّر بالحد", res.total === 7, `total=${res.total}`);

// الحدّ الأقصى للنتائج (200)
res = (await db.query("select public.admin_directory_search('', 5000, 0) as r")).rows[0].r;
check("الحد الأقصى للنتائج 200", res.limit === 200, String(res.limit));

// غير المشرف: مرفوض
await asUser("00000000-0000-4000-8000-000000000002");
let denied = false;
let deniedCode = "";
try {
  await db.query("select public.admin_directory_search('', 60, 0)");
} catch (e) {
  denied = true;
  deniedCode = e?.code || "";
}
check("غير المشرف لا يستطيع استدعاء دليل المستخدمين", denied && deniedCode === "42501", deniedCode);

// مستخدم محظور (مشرف محظور) مرفوض أيضاً
await asUser("11111111-0000-4000-8000-000000000003");
denied = false;
try {
  await db.query("select public.admin_directory_search('', 60, 0)");
} catch {
  denied = true;
}
check("المشرف المحظور لا يستطيع استدعاء الدليل", denied);

// بلا جلسة
await db.exec("set test.uid = ''");
denied = false;
try {
  await db.query("select public.admin_directory_search('', 60, 0)");
} catch {
  denied = true;
}
check("بلا مصادقة: مرفوض", denied);

// ---------- (ج) صلاحيات دوال الإشعارات الغائبة ----------
check("admin_recipient_ids أُزيلت من القاعدة",
  (await db.query(`select to_regprocedure('public.admin_recipient_ids()') is null as gone`)).rows[0].gone === true);
check("push_diagnostics أُزيلت من القاعدة",
  (await db.query(`select to_regprocedure('public.push_diagnostics()') is null as gone`)).rows[0].gone === true);

console.log(fails ? `\n${fails} فحص فشل` : "\nكل فحوصات هجرة v2.8 نجحت");
process.exit(fails ? 1 : 0);
