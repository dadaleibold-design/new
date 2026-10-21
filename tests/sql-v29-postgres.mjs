/*
 * تحقّق فعلي من عزل الإشعارات على PostgreSQL حقيقي (PGlite/WASM)
 * -------------------------------------------------------------
 * تاريخياً كان هذا الاختبار يشغّل هجرة v2.9 (دوال push_recipient_allowed /
 * conversation_direct_recipient + تريگرات net.http_post). في v3.0 انتقلت
 * قواعد العزل إلى supabase/functions/send-push/recipients.ts وأُزيلت كل
 * طبقات الإرسال من القاعدة، فأصبح هذا الملف يتحقق من:
 *   • قواعد المستلم (رسالة/مكالمة/مستخدم جديد) في الوحدة النقية الجديدة
 *   • أن القاعدة خالية تماماً من pg_net / Vault / تريگرات إشعارات
 *   • سجل التسليم push_delivery_log: الشكل الجديد + RLS + لا كتابة للعملاء
 *   • سياسات المشرف العام (المراقبة) باقية كما في v2.9
 *   • هجرة v3.0 idempotent على مخطط كامل
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
const SCHEMA = read("sql/schema.sql");
const MIGRATION = read("sql/migrations/2026-10-26_v3_0_database_webhooks_only.sql");

const { messageRecipient, callRecipient, callPartiesBelongToConversation } = await import(
  "../supabase/functions/send-push/recipients.ts"
);

let fails = 0;
const check = (name, ok, extra = "") => {
  console.log(ok ? "✅" : "❌", name, extra);
  if (!ok) fails += 1;
};

/* ============================================================
 * ① قواعد المستلم (الوحدة النقية)
 * ============================================================ */
const USER_A = "00000000-0000-4000-8000-000000000010";
const USER_B = "00000000-0000-4000-8000-000000000011";
const ADMIN = "11111111-0000-4000-8000-000000000001";
const SUPER = "11111111-0000-4000-8000-000000000002";
const CONV_A = { id: "00000000-0000-4000-8000-0000000000a1", user_id: USER_A, admin_id: ADMIN };

check("المستلم المباشر: المرسل user_id ⇒ admin_id", messageRecipient(CONV_A, USER_A).recipientId === ADMIN);
check("المستلم المباشر: المرسل admin_id ⇒ user_id", messageRecipient(CONV_A, ADMIN).recipientId === USER_A);
check("المستلم المباشر: مرسل خارج الأطراف ⇒ مرفوض",
  messageRecipient(CONV_A, SUPER).allowed === false);
check("المستلم المباشر: محادثة غير موجودة ⇒ مرفوض", messageRecipient(null, USER_A).allowed === false);
check("المستلم المباشر: رسالة بلا مرسل ⇒ مرفوض", messageRecipient(CONV_A, "").allowed === false);
check("البوابة: المشرف العام الذي يردّ وهو ليس طرفاً ⇒ صاحب المحادثة",
  messageRecipient(CONV_A, SUPER, true).recipientId === USER_A);
check("البوابة: المشرف العام لا يمكن أن يستلم بدل العميل", messageRecipient(CONV_A, SUPER, true).recipientId !== SUPER);

const NOW = Date.parse("2026-10-26T12:00:00Z");
const ROOM = {
  id: "00000000-0000-4000-8000-0000000000aa",
  conversation_id: CONV_A.id,
  caller_id: USER_A,
  callee_id: ADMIN,
  status: "ringing",
  started_at: "2026-10-26T11:59:30Z",
};
check("المكالمة: المستلم = callee_id حصراً", callRecipient("incoming_call", ROOM, NOW).recipientId === ADMIN);
check("المكالمة: لا رنين لغرفة ليست ringing",
  callRecipient("incoming_call", { ...ROOM, status: "active" }, NOW).allowed === false);
check("المكالمة: لا رنين بعد انتهاء النافذة (دقيقتان)",
  callRecipient("incoming_call", { ...ROOM, started_at: "2026-10-26T11:50:00Z" }, NOW).allowed === false);
check("المكالمة: callee_id = caller_id ⇒ مرفوض",
  callRecipient("incoming_call", { ...ROOM, callee_id: USER_A }, NOW).allowed === false);
check("المكالمة: انتهاء بنتيجة missed ⇒ إشعار للـ callee",
  callRecipient("call_ended", { ...ROOM, status: "missed" }, NOW).recipientId === ADMIN);
check("المكالمة: الحالة active ليست نهائية ⇒ بلا إشعار",
  callRecipient("call_ended", { ...ROOM, status: "active" }, NOW).allowed === false);
check("المكالمة: طرفا الغرفة يجب أن يكونا طرفي المحادثة",
  callPartiesBelongToConversation(CONV_A, USER_A, ADMIN) === true &&
    callPartiesBelongToConversation(CONV_A, USER_A, USER_B) === false);

/* ============================================================
 * ② قاعدة البيانات: صفر مسار إشعارات
 * ============================================================ */
const stripSql = (sql) => String(sql).replace(/--[^\n]*/g, " ");
const MIGRATIONS = fs.readdirSync(path.join(ROOT, "sql/migrations")).map((f) => ({
  file: f,
  code: stripSql(read(`sql/migrations/${f}`)),
}));
const ALL_CODE = stripSql(SCHEMA) + "\n" + MIGRATIONS.map((m) => m.code).join("\n");

check("لا create extension pg_net في أي ملف SQL", !/create extension[^;]*pg_net/i.test(ALL_CODE));
check("لا net.http_post في أي ملف SQL", !/net\.http_post/.test(ALL_CODE));
check("لا قراءة من Vault في أي ملف SQL", !/vault\.(decrypted_secrets|secrets)/.test(ALL_CODE));
const LEGACY = [
  "push_call_edge", "trigger_send_push_notification", "push_probe",
  "push_gateway_check", "push_egress_check", "push_net_diagnostics",
  "push_path_verdict", "push_delivery_url", "push_set_delivery_url",
  "push_mode", "push_set_mode", "push_recipient_allowed", "push_skip_note",
  "conversation_direct_recipient", "admin_recipient_ids", "push_diagnostics",
  "notify_new_message", "notify_call_room", "notify_admins_new_profile",
];
const defRe = (fn) => new RegExp(`create (or replace )?function public\\.${fn}\\s*\\(`);
const defined = LEGACY.filter((fn) => defRe(fn).test(ALL_CODE));
check("لا تعريف لأي دالة إشعارات قديمة في SQL", defined.length === 0, defined.join(","));
check("لا تريگرات إشعارات في SQL",
  !/create trigger (on_message_inserted|on_call_room_notify|on_profile_created_notify_admins)/.test(ALL_CODE));

/* ============================================================
 * ③ هجرة v3.0 على مخطط كامل (PGlite)
 * ============================================================ */
const STUB = `
create schema if not exists auth; create schema if not exists extensions;
create schema if not exists storage; create schema if not exists realtime;
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
end $$;
grant usage on schema public, auth, storage, extensions to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create or replace function auth.role() returns text language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon') $$;
create or replace function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
create table if not exists auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb, phone text);
create table if not exists storage.buckets (id text primary key, name text, public boolean default false);
create table if not exists storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid, metadata jsonb);
alter table storage.objects enable row level security;
create or replace function storage.foldername(name text) returns text[] language sql as $$ select string_to_array(name, '/') $$;
create or replace function public.uuid_generate_v4() returns uuid language sql as $$ select gen_random_uuid() $$;
create publication supabase_realtime;
`;

const db = new PGlite();
await db.exec(STUB);
try {
  await db.exec(SCHEMA.replace(/create extension if not exists \w+;/g, "-- ext"));
  check("schema.sql يُنفَّذ على PostgreSQL بلا أخطاء", true);
} catch (e) {
  check("schema.sql يُنفَّذ على PostgreSQL بلا أخطاء", false, String(e.message).slice(0, 300));
  process.exit(1);
}

const noPushFns = async (client) =>
  (
    await client.query(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname='public' and (p.proname like 'push_%' or p.proname like 'notify_%')`)
  ).rows.map((r) => r.proname);
check("schema.sql لا يُنشئ أي دالة push_*/notify_*",
  (await noPushFns(db)).length === 0, (await noPushFns(db)).join(","));

try {
  await db.exec(MIGRATION);
  await db.exec(MIGRATION);
  check("هجرة v3.0 تُنفَّذ مرتين بأمان (idempotent)", true);
} catch (e) {
  check("هجرة v3.0 تُنفَّذ مرتين بأمان (idempotent)", false, String(e.message).slice(0, 300));
}

check("لا دوال إشعارات بعد الهجرة", (await noPushFns(db)).length === 0);

/* ---------- سجل التسليم ---------- */
const cols = (
  await db.query(`select column_name, is_nullable, data_type from information_schema.columns
    where table_schema='public' and table_name='push_delivery_log' order by ordinal_position`)
).rows;
const names = cols.map((c) => c.column_name);
check("push_delivery_log: الأعمدة v3.0 (kind/ref_id/recipient_id/source/sent/total/skipped/detail)",
  ["kind", "ref_id", "recipient_id", "source", "sent", "total", "skipped", "detail"].every((c) => names.includes(c)),
  names.join(","));
check("push_delivery_log: source افتراضيه webhook",
  (await db.query(`select column_default from information_schema.columns
    where table_name='push_delivery_log' and column_name='source'`)).rows[0]?.column_default?.includes("webhook"));
const rls = await db.query(
  `select relrowsecurity from pg_class where relname='push_delivery_log' and relnamespace='public'::regnamespace`,
);
check("push_delivery_log: RLS مُفعَّل", rls.rows[0]?.relrowsecurity === true);
const pol = await db.query(
  `select cmd, qual from pg_policies where schemaname='public' and tablename='push_delivery_log'`,
);
check("push_delivery_log: سياسة قراءة واحدة فقط (SELECT)",
  pol.rows.length === 1 && pol.rows[0].cmd === "SELECT", JSON.stringify(pol.rows.map((r) => r.cmd)));
check("push_delivery_log: لا سياسة كتابة للعملاء",
  !pol.rows.some((r) => ["INSERT", "UPDATE", "DELETE", "ALL"].includes(r.cmd)));
check("v3.0: لا منح كتابة صريح على push_delivery_log في الهجرة",
  !/grant\s+(insert|update|delete|all)[^;]*on\s+(table\s+)?public\.push_delivery_log/i.test(stripSql(MIGRATION)));
check("v3.0: الهجرة تُلغي سياسات السجل القديمة قبل إنشاء الجديدة",
  /drop policy if exists "push log superadmin read"/.test(MIGRATION));
// سلوكياً: السياسة الوحيدة SELECT ⇒ أي كتابة من عميل مرفوضة (RLS بلا سياسة كتابة)
check("push_delivery_log: لا سياسة INSERT/UPDATE/DELETE (الحماية عبر RLS)",
  (await db.query(`select count(*)::int n from pg_policies
    where schemaname='public' and tablename='push_delivery_log'
      and cmd in ('INSERT','UPDATE','DELETE','ALL')`)).rows[0].n === 0);

/* ---------- سياسات المشرف العام (v2.9) ---------- */
const superPolicies = (
  await db.query(`select policyname from pg_policies where schemaname='public' and policyname like '%superadmin%'`)
).rows.map((r) => r.policyname);
for (const name of [
  "conversations read superadmin",
  "messages read superadmin",
  "call rooms read superadmin",
  "call logs superadmin",
  "call history hidden superadmin read",
]) {
  check(`سياسة المراقبة باقية: ${name}`, superPolicies.includes(name));
}
check("لا سياسة ALL للمشرف العام على المكالمات",
  !superPolicies.some((n) => /call/.test(n) && n.includes("write")));

/* ---------- دالة التقليم ---------- */
const prune = await db.query(`select to_regprocedure('public.prune_push_delivery_log(integer)') is not null as ok`);
check("دالة prune_push_delivery_log موجودة", prune.rows[0].ok === true);
const prunePriv = await db.query(`select
  has_function_privilege('anon','public.prune_push_delivery_log(integer)','EXECUTE') as anon_ok,
  has_function_privilege('authenticated','public.prune_push_delivery_log(integer)','EXECUTE') as auth_ok`);
check("prune_push_delivery_log ممنوعة على anon/authenticated",
  prunePriv.rows[0].anon_ok === false && prunePriv.rows[0].auth_ok === false);

/* ---------- لا مسار HTTP من القاعدة ---------- */
const trigs = (
  await db.query(`select tgname from pg_trigger t join pg_class c on c.oid=t.tgrelid
    join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal`)
).rows.map((r) => r.tgname);
check("لا تريگر إشعارات على messages/call_rooms/profiles",
  !trigs.some((t) => ["on_message_inserted", "on_call_room_notify", "on_profile_created_notify_admins"].includes(t)),
  trigs.join(","));
check("تريگرات المحادثة/الطوابع الزمنية غير المتعلقة بالإشعارات باقية",
  trigs.includes("on_message_hook") || trigs.length > 0);

console.log(fails ? `\n${fails} فحص فشل` : "\nكل فحوصات عزل الإشعارات (v3.0) نجحت");
process.exit(fails ? 1 : 0);
