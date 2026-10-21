/*
 * تدقيق العزل وRLS وصلاحيات الدوال على PostgreSQL حقيقي (PGlite/WASM)
 * -------------------------------------------------------------------
 * يشغّل sql/schema.sql ثم هجرة v2.11 (مرتين: إعادة التنفيذ آمنة) فوق بيئة
 * تحاكي Supabase (auth.uid / roles / storage / vault / net)، ويتحقق سلوكياً من:
 *   • عزل المستخدم: لا قراءة لرسائل/توكنات/مرفقات الآخرين، ولا تعديل لصلاحياته
 *   • المشرف العام: كتابة كاملة على المحادثات/الرسائل/الكتابة/التفاعلات (v2.13)،
 *     المكالمات وإدارة المستخدمين (حظر/حذف) تبقى قراءة فقط
 *   • المشرف العادي يحظر ويفتح محادثاته فقط
 *   • الزائر (anon) لا يصل لأي بيانات ولا ينفّذ دوال داخلية
 *   • لا مفتاح JWT ثابت في ملفات SQL
 * التشغيل: npm i --no-save @electric-sql/pglite && node tests/rls-hardening-postgres.mjs
 * (يتخطّى بلا فشل إن لم تكن الحزمة مثبّتة.)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let PGlite;
try {
  ({ PGlite } = await import("@electric-sql/pglite"));
} catch {
  console.log("⏭  اختبار RLS (PGlite) متخطّى — ثبّت الحزمة بـ: npm i --no-save @electric-sql/pglite");
  process.exit(0);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

const STUB = `
create schema if not exists auth; create schema if not exists vault; create schema if not exists net;
create schema if not exists extensions; create schema if not exists storage; create schema if not exists realtime;
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
end $$;
grant usage on schema public, auth, storage, net, vault, extensions to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create or replace function auth.role() returns text language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon') $$;
create or replace function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
create table if not exists auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb, phone text);
create table if not exists vault.decrypted_secrets (name text, decrypted_secret text);
create table if not exists net._http_response (id bigint, status_code int, content jsonb, error_msg text, created timestamptz default now());
create or replace function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb, headers jsonb default '{}'::jsonb, timeout_milliseconds int default 2000) returns bigint language sql as $$ select 1::bigint $$;
create table if not exists storage.buckets (id text primary key, name text, public boolean default false);
create table if not exists storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid, metadata jsonb);
alter table storage.objects enable row level security;
create or replace function storage.foldername(name text) returns text[] language sql as $$ select string_to_array(name, '/') $$;
create or replace function public.uuid_generate_v4() returns uuid language sql as $$ select gen_random_uuid() $$;
create publication supabase_realtime;
`;

// إزالة أوامر الإضافات (غير متوفرة في PGlite) — لا تُغيّر منطق الدوال
const stripExt = (sql) => sql.replace(/create extension if not exists \w+;/g, "-- ext");

const db = new PGlite();
let fails = 0;
const check = (name, ok, extra = "") => {
  console.log(ok ? "✅" : "❌", name, extra);
  if (!ok) fails += 1;
};

await db.exec(STUB);
try {
  await db.exec(stripExt(read("sql/schema.sql")));
  check("schema.sql يُنفَّذ بلا أخطاء على PostgreSQL", true);
} catch (e) {
  check("schema.sql يُنفَّذ بلا أخطاء على PostgreSQL", false, String(e.message).slice(0, 200));
  process.exit(1);
}
const MIG = read("sql/migrations/2026-10-14_v2_11_security_hardening.sql");
try {
  await db.exec(MIG);
  await db.exec(MIG); // إعادة التنفيذ
  check("هجرة v2.11 تُنفَّذ فوق المخطط ثم تُعاد بأمان (idempotent)", true);
} catch (e) {
  check("هجرة v2.11 تُنفَّذ فوق المخطط ثم تُعاد بأمان (idempotent)", false, String(e.message).slice(0, 200));
}
// v2.15 هي آخر هجرة في المسار (تُطبَّق فوق v2.11 كما في الإنتاج): تضمين رابط/سرّ
// send-push في trigger_send_push_notification بلا Vault.
const MIG_V215 = read("sql/migrations/2026-10-21_v2_15_hardcoded_send_push_endpoint.sql");
try {
  await db.exec(MIG_V215);
  await db.exec(MIG_V215); // إعادة التنفيذ
  check("هجرة v2.15 تُنفَّذ فوق v2.11 ثم تُعاد بأمان (idempotent)", true);
} catch (e) {
  check("هجرة v2.15 تُنفَّذ فوق v2.11 ثم تُعاد بأمان (idempotent)", false, String(e.message).slice(0, 200));
}

// ---------- بيانات اختبار (بصلاحية المالك، أي بلا RLS) ----------
const S = "00000000-0000-4000-8000-00000000000a"; // مشرف عام
const A = "00000000-0000-4000-8000-00000000000b"; // مشرف عادي
const U1 = "00000000-0000-4000-8000-000000000001";
const U2 = "00000000-0000-4000-8000-000000000002";
const C1 = "00000000-0000-4000-8000-0000000000c1"; // U1 ⇄ A
const C2 = "00000000-0000-4000-8000-0000000000c2"; // U2 ⇄ A
const M1 = "00000000-0000-4000-8000-0000000000d1";
const M2 = "00000000-0000-4000-8000-0000000000d2";
await db.exec(`
  insert into auth.users (id, email) values
    ('${S}','super@example.test'),('${A}','admin@example.test'),
    ('${U1}','u1@example.test'),('${U2}','u2@example.test');
  -- الإعداد بدور service_role (كما في Supabase): يتجاوز حراسة الأعمدة
  select set_config('request.jwt.claim.role', 'service_role', false);
  insert into public.profiles (id, email, phone, display_name, is_admin, is_super_admin, is_blocked)
  values
    ('${S}','super@example.test','+0000000001','Super',true,true,false),
    ('${A}','admin@example.test','+0000000002','Admin',true,false,false),
    ('${U1}','u1@example.test','+0000000003','U1',false,false,false),
    ('${U2}','u2@example.test','+0000000004','U2',false,false,false)
  on conflict (id) do update set email = excluded.email, phone = excluded.phone,
    display_name = excluded.display_name, is_admin = excluded.is_admin,
    is_super_admin = excluded.is_super_admin, is_blocked = false;
  insert into public.conversations (id, user_id, admin_id) values
    ('${C1}','${U1}','${A}'), ('${C2}','${U2}','${A}');
  insert into public.messages (id, conversation_id, sender_id, content) values
    ('${M1}','${C1}','${U1}','secret-of-u1'), ('${M2}','${C2}','${U2}','secret-of-u2');
  insert into public.fcm_tokens (user_id, token, platform, device_id) values ('${U2}','tok-u2','web','dev-u2');
  insert into storage.objects (bucket_id, name, owner) values ('attachments','${U2}/photo.jpg','${U2}');
`);

// ينفّذ استعلاماً بدور معيّن (داخل معاملة تُلغى دائماً)
async function as({ role = "authenticated", uid = null }, sql, params = []) {
  const claims = uid ? JSON.stringify({ sub: uid, role }) : JSON.stringify({ role });
  await db.exec("begin");
  try {
    await db.query(`set local role ${role}`);
    await db.query("select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claim.role', $2, true), set_config('request.jwt.claims', $3, true)", [uid ?? "", role, claims]);
    const r = await db.query(sql, params);
    return { ok: true, rows: r.rows, affected: r.affectedRows ?? r.rows.length };
  } catch (e) {
    return { ok: false, error: String(e.message || e), code: e.code };
  } finally {
    await db.exec("rollback");
  }
}
const count = async (who, sql, params) => {
  const r = await as(who, `select count(*)::int as n from (${sql}) q`, params);
  return r.ok ? r.rows[0].n : `ERR:${r.error}`;
};
const writeCount = async (who, sql, params) => {
  const r = await as(who, sql, params);
  return r.ok ? r.affected : `ERR:${r.error}`;
};

// ---------- 1) RLS لتسجيل توكنات FCM (جلسة المستخدم فقط) ----------
const ownTokenInsert = await as(
  { uid: U1 },
  `insert into public.fcm_tokens (user_id, token, platform) values ('${U1}', 'rls-own-token', 'web')`,
);
check("RLS: المستخدم يستطيع تسجيل توكنه الخاص", ownTokenInsert.ok, ownTokenInsert.error ?? "");
const crossTokenInsert = await as(
  { uid: U1 },
  `insert into public.fcm_tokens (user_id, token, platform) values ('${U2}', 'rls-other-token', 'web')`,
);
check("RLS: المستخدم لا يستطيع تسجيل توكن تحت حساب آخر", !crossTokenInsert.ok && /row-level security|policy/i.test(crossTokenInsert.error), crossTokenInsert.error ?? "");
const tokenRpc = await as(
  { uid: U1 },
  `select public.register_fcm_token('rls-rpc-token', 'web', 'device-u1', '{}'::jsonb) as result`,
);
check(
  "RLS: register_fcm_token يسجّل للجلسة الحالية عبر RPC المصرّح بها",
  tokenRpc.ok && tokenRpc.rows[0]?.result?.action === "inserted",
  tokenRpc.error ?? JSON.stringify(tokenRpc.rows?.[0]?.result ?? null),
);

// ---------- 2) الزائر (anon) ----------
check("زائر: لا يرى أي ملف شخصي", (await count({ role: "anon" }, "select id from public.profiles")) === 0);
check("زائر: لا يرى أي رسالة", (await count({ role: "anon" }, "select id from public.messages")) === 0);
check("زائر: لا يرى توكنات FCM", (await count({ role: "anon" }, "select id from public.fcm_tokens")) === 0);
const anonObj = await count({ role: "anon" }, "select id from storage.objects");
check("زائر: لا يسرد مرفقات التخزين (0 صفوف أو مرفوض)", anonObj === 0 || /permission denied/i.test(String(anonObj)), String(anonObj));
const anonRpc = await as({ role: "anon" }, "select public.expire_stale_calls()");
check("زائر: لا ينفّذ expire_stale_calls (تنظيف عام للمكالمات)", !anonRpc.ok && /permission denied/i.test(anonRpc.error), anonRpc.error ?? "");
const anonPush = await as({ role: "anon" }, `select public.push_call_edge('probe', gen_random_uuid(), '${U1}', '{}'::jsonb)`);
check("زائر: لا ينفّذ push_call_edge مباشرة", !anonPush.ok && /permission denied/i.test(anonPush.error), anonPush.error ?? "");
const anonAdm = await as({ role: "anon" }, "select public.admin_recipient_ids()");
check("زائر: لا يرى قائمة المشرفين عبر admin_recipient_ids", !anonAdm.ok, anonAdm.error ?? "");
const anonDir = await as({ role: "anon" }, "select public.admin_directory_search('a', 10, 0)");
check("زائر: لا يستخدم دليل المستخدمين", !anonDir.ok, anonDir.error ?? "");

// ---------- 2) عزل المستخدم العادي U1 ----------
check("U1 يرى رسالته فقط", (await count({ uid: U1 }, `select id from public.messages`)) === 1);
check("U1 لا يرى رسالة U2", (await count({ uid: U1 }, `select id from public.messages where id='${M2}'`)) === 0);
check("U1 لا يرى توكن FCM للآخرين", (await count({ uid: U1 }, `select id from public.fcm_tokens where user_id='${U2}'`)) === 0);
check("U1 لا يرى محادثة U2", (await count({ uid: U1 }, `select id from public.conversations where id='${C2}'`)) === 0);
const u1Obj = await count({ uid: U1 }, `select id from storage.objects where name like '${U2}/%'`);
check("U1 لا يسرد مرفقات U2 (0 صفوف أو مرفوض)", u1Obj === 0 || /permission denied/i.test(String(u1Obj)), String(u1Obj));
const selPol = await as({}, `select count(*)::int n from pg_policies where schemaname='storage' and tablename='objects' and cmd in ('SELECT','ALL')`);
check("لا سياسة SELECT عامة على التخزين (منع السرد/التعداد)", selPol.rows?.[0]?.n === 0, String(selPol.rows?.[0]?.n));
const injectMsg = await writeCount({ uid: U1 }, `insert into public.messages (conversation_id, sender_id, content) values ('${C2}','${U1}','x')`);
check("U1 لا يُدرج رسالة في محادثة U2 (RLS)", typeof injectMsg === "string" && /row-level security|policy/i.test(injectMsg), String(injectMsg));
const spoof = await writeCount({ uid: U1 }, `insert into public.messages (conversation_id, sender_id, content) values ('${C1}','${U2}','x')`);
check("U1 لا ينتحل هوية مرسل آخر", typeof spoof === "string", String(spoof));
const promote = await writeCount({ uid: U1 }, `update public.profiles set is_admin=true, is_super_admin=true where id='${U1}'`);
const promoted = await as({}, `select is_admin, is_super_admin from public.profiles where id='${U1}'`);
check("U1 لا يرفع صلاحياته لنفسه (trigger يُرجع is_admin)", promoted.rows?.[0]?.is_admin === false && promoted.rows?.[0]?.is_super_admin === false, String(promote));
const mail = await writeCount({ uid: U1 }, `update public.profiles set email='x@evil.test' where id='${U1}'`);
const after = await as({}, `select email from public.profiles where id='${U1}'`);
check("U1 لا يغيّر بريده (هوية الدخول)", after.rows?.[0]?.email === "u1@example.test", String(mail));
check("U1 لا يعدّل ملف U2", (await writeCount({ uid: U1 }, `update public.profiles set display_name='hacked' where id='${U2}'`)) === 0);
check("U1 لا يحظر نفسه/غيره عبر admin_set_user_blocked", await (async () => {
  const r = await as({ uid: U1 }, `select public.admin_set_user_blocked('${U2}', true)`);
  return !r.ok && /غير مصرّح|42501|permission denied/i.test(r.error);
})());

// ---------- 3) المشرف العام S: كتابة كاملة على المحادثات/الرسائل (v2.13) ----------
check("S يرى كل الرسائل (مراقبة)", (await count({ uid: S }, `select id from public.messages`)) === 2);
check("S يرى كل المحادثات (مراقبة)", (await count({ uid: S }, `select id from public.conversations`)) === 2);
// v2.13: الرد في محادثة المستخدم مع مشرف آخر أصبح مسموحاً (بلا 403)
const sReply = await writeCount({ uid: S }, `insert into public.messages (conversation_id, sender_id, content) values ('${C1}','${S}','رد المشرف العام')`);
check("S يردّ في محادثة ليس طرفاً فيها (v2.13: كتابة كاملة)", sReply === 1, String(sReply));
// صف رسالة مثبّت (فوق RLS — إدراج as() يُلف بمعاملة تُلغى) ليختبر الحذف بجلسة S
await db.query(`insert into public.messages (id, conversation_id, sender_id, content) values ('00000000-0000-4000-8000-0000000000d9','${C1}','${S}','رد قابل للحذف')`);
const sReplyId = "00000000-0000-4000-8000-0000000000d9";
const sTyping = await as({ uid: S }, `insert into public.typing_status (conversation_id, user_id, is_typing) values ('${C1}','${S}',true)
  on conflict (conversation_id, user_id) do update set is_typing = true, updated_at = now()`);
check("S يرسل «يكتب الآن» في أي محادثة يردّ فيها (v2.13)", sTyping.ok, sTyping.error ?? "");
const sReact = await as({ uid: S }, `insert into public.message_reactions (message_id, user_id, emoji) values ('${M1}','${S}','👍') on conflict do nothing`);
check("S يتفاعل مع رسائل أي محادثة (v2.13)", sReact.ok, sReact.error ?? "");
// صلاحية التحديث تشمل الصف، لكن حماية العبث (trigger) تمنع تغيير محتوى رسالة غيره
const sEdit = await writeCount({ uid: S }, `update public.messages set content='tampered' where id='${M1}'`);
check("S يستطيع تحديث صف رسالة (كتابة كاملة v2.13)", sEdit === 1, String(sEdit));
const contentAfter = await as({ uid: S }, `select content from public.messages where id='${M1}'`);
check("حماية العبث باقية: محتوى رسالة الآخرين لا يتغير حتى مع صلاحية التحديث", contentAfter.rows?.[0]?.content === "secret-of-u1", String(contentAfter.rows?.[0]?.content));
// الحذف متاح لكتابة كاملة — نحذف ردّه هو فقط (لا نمسّ بيانات بقية الاختبار)
const sDelOwn = await writeCount({ uid: S }, `delete from public.messages where id='${sReplyId}'`);
check("S يحذف رسالة (كتابة كاملة v2.13 — حذف ردّه هو)", sDelOwn === 1, String(sDelOwn));
// محادثة مؤقتة لحذفها: تُنشأ فوق RLS (بصلاحية المالك — ككتلة البيانات الأولى)
// زوج جديد (U2 ⇄ S) تفادياً لقيد الفريد user_id+admin_id مع C2 (U2 ⇄ A)
await db.query(`insert into public.conversations (id, user_id, admin_id) values ('00000000-0000-4000-8000-0000000000c3','${U2}','${S}')`);
const sDelConv = await writeCount({ uid: S }, `delete from public.conversations where id='00000000-0000-4000-8000-0000000000c3'`);
check("S يحذف محادثة (كتابة كاملة v2.13)", sDelConv === 1, String(sDelConv));
check("S لا يعدّل غرف المكالمات (خارج نطاق v2.13: قراءة فقط تبقى)", (await writeCount({ uid: S }, `update public.call_rooms set status='ended'`)) === 0);
const sBlock = await as({ uid: S }, `select public.admin_set_user_blocked('${U1}', true)`);
check("S لا يحظر مستخدماً (إدارة المستخدمين قراءة فقط)", !sBlock.ok && /للقراءة فقط/.test(sBlock.error), sBlock.error ?? "");
const sDel = await as({ uid: S }, `select public.admin_delete_user('${U1}')`);
check("S لا يحذف مستخدماً (إدارة المستخدمين قراءة فقط)", !sDel.ok && /للقراءة فقط/.test(sDel.error), sDel.error ?? "");
const stillThere = await as({}, `select count(*)::int n from public.profiles where id='${U1}' and is_blocked=false`);
check("بقاء U1 غير متأثر بمحاولات S", stillThere.rows?.[0]?.n === 1);
// v2.13: توجيه إشعار ردّ S ⇒ المستخدم صاحب المحادثة (وليس المشرف المالك).
// الدالتان داخليتان (REVOKEd من الأدوار عمداً — مسار Triggers) ⇒ تُستدعيان فوق RLS.
const directRecipient = async (conv, sender) =>
  (await db.query(`select public.conversation_direct_recipient('${conv}','${sender}') r`)).rows?.[0]?.r;
const pushAllowed = async (recipient, sender, conv) =>
  (await db.query(`select public.push_recipient_allowed('new_message','${M1}','${recipient}', jsonb_build_object('sender_id','${sender}','conversation_id','${conv}')) ok`)).rows?.[0]?.ok;

check("conversation_direct_recipient: ردّ S ⇒ المستخدم صاحب المحادثة", (await directRecipient(C1, S)) === U1, String(await directRecipient(C1, S)));
check("conversation_direct_recipient: ردّ المستخدم ⇒ المشرف المالك (كما هو)", (await directRecipient(C1, U1)) === A);
check("conversation_direct_recipient: مرسل غريب ليس طرفاً ولا مشرفاً عاماً ⇒ null", (await directRecipient(C1, U2)) === null);
check("push_recipient_allowed: يسمح بردّ S إلى صاحب المحادثة", (await pushAllowed(U1, S, C1)) === true);
check("push_recipient_allowed: يرفض توجيه ردّ S للمشرف المالك (المستخدم حصراً)", (await pushAllowed(A, S, C1)) === false);
check("push_recipient_allowed: يرفض مرسلاً غريباً (كما في v2.9)", (await pushAllowed(U1, U2, C1)) === false);

// ---------- 4) المشرف العادي A: صلاحياته الفعلية ----------
const aBlock = await as({ uid: A }, `select public.admin_set_user_blocked('${U1}', true)`);
check("A يحظر مستخدماً", aBlock.ok, aBlock.error ?? "");
const aUnblock = await as({ uid: A }, `select public.admin_set_user_blocked('${U1}', false)`);
check("A يلغي الحظر", aUnblock.ok, aUnblock.error ?? "");
const aSuperBlock = await as({ uid: A }, `select public.admin_set_user_blocked('${S}', true)`);
check("A لا يحظر مشرفاً (القاعدة القديمة)", !aSuperBlock.ok);

const aDelOwn = await writeCount({ uid: A }, `delete from public.messages where id='${M1}'`);
check("A يحذف رسالة داخل محادثته (ميزة الحذف للمشرف العادي باقية)", aDelOwn === 1, String(aDelOwn));
const aDelOther = await writeCount({ uid: A }, `delete from public.conversations where id='${C2}' and admin_id='${S}'`);
check("A لا يحذف محادثة ليس طرفاً فيها", aDelOther === 0, String(aDelOther));

// ---------- 5) صلاحيات الدوال للمُصادَق ----------
const uExpire = await as({ uid: U1 }, "select public.expire_stale_calls()");
check("U1 لا ينفّذ expire_stale_calls", !uExpire.ok && /permission denied/i.test(uExpire.error), uExpire.error ?? "");
const uPush = await as({ uid: U1 }, `select public.push_call_edge('probe', gen_random_uuid(), '${U2}', '{}'::jsonb)`);
check("U1 لا ينفّذ push_call_edge مباشرة (لا إرسال لمستخدم آخر)", !uPush.ok && /permission denied/i.test(uPush.error), uPush.error ?? "");
const uProbe = await as({ uid: U1 }, "select public.push_probe()");
check("U1 ينفّذ push_probe (ميزة تشخيص لحسابه)", uProbe.ok, uProbe.error ?? "");
const uUnread = await as({ uid: U1 }, `select public.unread_counts(array['${C1}']::uuid[])`);
check("U1 ينفّذ unread_counts (ميزة الواجهة)", uUnread.ok, uUnread.error ?? "");
const uRing = await as({ uid: U1 }, `select public.call_room_is_ringing(gen_random_uuid())`);
check("U1 ينفّذ call_room_is_ringing (ميزة الواجهة)", uRing.ok, uRing.error ?? "");

// ---------- 6) مقاييس الصلاحيات المباشرة ----------
const priv = await as({}, `select
  has_function_privilege('anon','public.push_call_edge(text,uuid,uuid,jsonb)','EXECUTE') as anon_push,
  has_function_privilege('authenticated','public.push_call_edge(text,uuid,uuid,jsonb)','EXECUTE') as auth_push,
  has_function_privilege('anon','public.expire_stale_calls()','EXECUTE') as anon_exp,
  has_function_privilege('authenticated','public.register_fcm_token(text,text,text,jsonb)','EXECUTE') as auth_fcm`);
const p = priv.rows?.[0] ?? {};
check("لا EXECUTE لـ anon على push_call_edge", p.anon_push === false);
check("لا EXECUTE لـ authenticated على push_call_edge", p.auth_push === false);
check("لا EXECUTE لـ anon على expire_stale_calls", p.anon_exp === false);
check("EXECUTE لـ authenticated على register_fcm_token (ميزة الواجهة)", p.auth_fcm === true);

// ---------- 6b) Realtime: الجداول التي تشترك فيها الواجهة منشورة ----------
const pub = await as({}, `select tablename from pg_publication_tables where pubname='supabase_realtime'`);
const published = new Set((pub.rows || []).map((r) => r.tablename));
for (const t of ["messages", "typing_status", "message_reactions", "profiles", "conversations", "call_rooms"]) {
  // الجداول تُضاف للنشر في schema.sql؛ الاختبار هنا يتحقق من المنشور فعلاً
  const ok = published.has(t) || (await db.query(`select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename=$1`, [t])).rows.length > 0;
  check(`Realtime: ${t} منشور لبث التغييرات`, ok);
}

// ---------- 7) لا مفاتيح JWT ثابتة في SQL ----------
const SQL_FILES = ["sql/schema.sql", ...fs.readdirSync(path.join(ROOT, "sql/migrations")).map((f) => "sql/migrations/" + f)];
const leaks = SQL_FILES.filter((f) => /eyJhbGciOiJIUzI1NiIs/.test(read(f)));
check("لا JWT ثابت في أي ملف SQL", leaks.length === 0, leaks.join(", "));
const pcDef = (await db.query("select pg_get_functiondef('public.push_call_edge(text,uuid,uuid,jsonb)'::regprocedure) d")).rows[0].d;
const tsDef = (await db.query("select pg_get_functiondef('public.trigger_send_push_notification(text,uuid,uuid,jsonb)'::regprocedure) d")).rows[0].d;
check("push_call_edge تفوّض إلى trigger_send_push_notification", /public\.trigger_send_push_notification\(p_kind, p_ref, p_recipient, p_body\)/.test(pcDef));
check("trigger_send_push_notification يضمّن رابط send-push مباشرة", /https:\/\/gqocavvhkfzgxzscrjms\.supabase\.co\/functions\/v1\/send-push/.test(tsDef));
check("trigger_send_push_notification لا يقرأ من Vault إطلاقاً", !/vault\.(decrypted_secrets|secrets|create_secret)/.test(tsDef));
check("trigger_send_push_notification يُرسل ترويسة x-send-push-secret", /'x-send-push-secret', v_secret/.test(tsDef));
check("trigger_send_push_notification يضمّن السرّ المعتمد", tsDef.includes("my_send_push_19921121_almgawell_19921121"));
check("تعريف push_call_edge/trigger_send_push_notification بلا أي مرجع Vault",
  !/vault\./.test(pcDef) && !/vault\./.test(tsDef));

// ---------- v2.16: التشخيص يفحص الجسم الحيّ بدل الثوابت ----------
const MIGRATION_V216 = read("sql/migrations/2026-10-22_v2_16_send_push_live_state.sql");
const v216Code = MIGRATION_V216.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
check("v2.16: ملف الهجرة موجود", MIGRATION_V216.length > 0);
check("v2.16: هجرة بلا مراجع Vault", !/vault\.(decrypted_secrets|secrets|create_secret)/.test(v216Code));
check("v2.16: push_diagnostics يفحص pg_proc.prosrc (الحالة الحيّة)",
  /pg_proc/.test(MIGRATION_V216) && /live_path_stale/.test(MIGRATION_V216));
check("v2.16: push_egress_check معرَّف", /create or replace function public\.push_egress_check\(\)/.test(MIGRATION_V216));
const SCHEMA_V216 = read("sql/schema.sql");
check("v2.16: مذكور في schema.sql", SCHEMA_V216.includes("22. الإصدار v2.16 (2026-10-22)")
  && SCHEMA_V216.includes("push_egress_check"));

// لا ملف SQL في المستودع يقرأ SEND_PUSH_URL/SEND_PUSH_SECRET من Vault
const SQL_PUSH_FILES = [
  "sql/schema.sql",
  ...fs.readdirSync(path.join(ROOT, "sql/migrations")).map((f) => "sql/migrations/" + f),
];
const vaultPushRefs = SQL_PUSH_FILES.filter((f) => {
  const code = read(f).split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
  return /vault\.(decrypted_secrets|secrets)/.test(code);
});
check("لا ملف SQL يقرأ أسرار send-push من Vault (المسار مُضمَّن بالكامل)", vaultPushRefs.length === 0, vaultPushRefs.join(", "));

if (fails) {
  console.log(`\nFAILED ${fails} check(s)`);
  process.exit(1);
}
console.log("\nPASSED rls-hardening-postgres");
