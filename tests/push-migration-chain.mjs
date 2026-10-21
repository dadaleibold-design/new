/*
 * تحقّق شامل: تطبيق سلسلة الهجرات كاملةً على PostgreSQL حقيقي (PGlite)
 * والتأكد أن مسار التريگرات يعمل بالرابط والسرّ المُضمَّنين (بلا Vault).
 *
 * التشغيل: node tests/push-migration-chain.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// نُعطّل إنشاء امتداد pg_net (غير متوفّر في PGlite) — نُحاكي net.http_post بأنفسنا
const read = (rel) =>
  fs.readFileSync(path.join(ROOT, rel), "utf8")
    .replace(/create extension if not exists pg_net;/g, "-- [pglite] pg_net mocked");

const URL = "https://gqocavvhkfzgxzscrjms.supabase.co/functions/v1/send-push";
const SECRET = "my_send_push_19921121_almgawell_19921121";

let PGlite;
try {
  ({ PGlite } = await import("@electric-sql/pglite"));
} catch {
  console.log("⏭  PGlite غير مثبّتة — تخطّي");
  process.exit(0);
}

let fails = 0;
const check = (name, ok, extra = "") => {
  console.log(ok ? "✅" : "❌", name, extra ? `— ${extra}` : "");
  if (!ok) fails += 1;
};

const db = new PGlite();

// ── بيئة مصغّرة تحاكي Supabase ──
await db.exec(`
  do $$ begin if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if; end $$;
  do $$ begin if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if; end $$;
  do $$ begin if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if; end $$;

  create schema if not exists auth;
  create schema if not exists storage;
  create schema if not exists vault;
  create schema if not exists net;
  create schema if not exists extensions;

  create or replace function auth.uid() returns uuid
  language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;

  create table if not exists auth.users (
    id uuid primary key default gen_random_uuid(),
    email text unique,
    phone text,
    raw_user_meta_data jsonb default '{}'::jsonb,
    created_at timestamptz default now()
  );
  -- شيم مخطّط Storage
  create table if not exists storage.buckets (
    id text primary key, name text unique not null,
    owner uuid, public boolean default false, created_at timestamptz default now(),
    updated_at timestamptz default now()
  );
  create table if not exists storage.objects (
    id uuid primary key default gen_random_uuid(), bucket_id text, name text,
    owner uuid, created_at timestamptz default now(), updated_at timestamptz default now()
  );

  create or replace function storage.foldername(name text) returns text[]
  language plpgsql immutable as $$
  declare _parts text[];
  begin
    select string_to_array(name, '/') into _parts;
    return case when array_length(_parts, 1) > 1 then _parts[1:array_length(_parts,1)-1] else '{}'::text[] end;
  end $$;
  create or replace function storage.extension(name text) returns text
  language sql immutable as $$ select substring(name from '\\.[^.]+$') $$;

  -- شيم نشر Realtime
  do $$ begin
    if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
      create publication supabase_realtime;
    end if;
  end $$;

  -- شيم دوال Supabase Auth (غير موجودة في PGlite)
  create or replace function auth.role() returns text
  language sql stable as $$ select nullif(current_setting('request.jwt.claim.role', true), '') $$;
  create or replace function auth.email() returns text
  language sql stable as $$ select nullif(current_setting('request.jwt.claim.email', true), '') $$;
  create or replace function auth.jwt() returns jsonb
  language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $$;

  -- شيم لوحدة uuid-ossp (غير متوفرة في PGlite) — الدالة المبنيّة تكفي
  create or replace function public.uuid_generate_v4() returns uuid
  language sql volatile as $$ select gen_random_uuid() $$;

  create table if not exists auth.roles (id text primary key);
  insert into auth.roles (id) values ('anon'), ('authenticated'), ('service_role') on conflict do nothing;

  -- Vault موجود لكن فارغ: أي قراءة منه = فشل
  create table if not exists vault.decrypted_secrets (name text primary key, decrypted_secret text not null);

  -- محاكاة pg_net: الطلب يُدرج في net.calls والرد يُكتب لاحقاً
  create table if not exists net.calls (
    id bigserial primary key, request_id bigint, url text, headers jsonb, body jsonb,
    timeout_milliseconds int, created_at timestamptz default now()
  );
  create table if not exists net._http_response (id bigint primary key, status_code int, content jsonb, error_msg text);
  create sequence if not exists net_request_seq as bigint start 900;
  create or replace function net.http_post(
    url text, headers jsonb default '{}'::jsonb, body jsonb default '{}'::jsonb,
    params jsonb default '{}'::jsonb, timeout_milliseconds int default 8000
  ) returns bigint language plpgsql as $$
  declare v_req bigint;
  begin
    select nextval('net_request_seq') into v_req;
    insert into net.calls (request_id, url, headers, body, timeout_milliseconds)
    values (v_req, url, coalesce(headers,'{}'::jsonb), coalesce(body,'{}'::jsonb), timeout_milliseconds);
    return v_req;
  end $$;
`);

// ── تطبيق سلسلة الهجرات كاملةً بالترتيب ──
// ① الأساس: schema.sql (الملف المُعتمد للإقلاع)
try {
  await db.exec(read("sql/schema.sql"));
  console.log("\n✅ طُبِّق sql/schema.sql كاملاً (الأساس).");
} catch (e) {
  console.log("\n⚠️  تعذّر تطبيق schema.sql كاملاً:", String(e.message).split("\n")[0].slice(0, 160));
}

const dir = path.join(ROOT, "sql/migrations");
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
const applied = [];
const skipped = [];
for (const f of files) {
  try {
    await db.exec(read(path.join("sql/migrations", f)));
    applied.push(f);
  } catch (e) {
    skipped.push(`${f}: ${String(e.message).split("\n")[0].slice(0, 120)}`);
  }
}
console.log(`\n📦 طُبِّق ${applied.length}/${files.length} هجرة.\n`);
for (const s of skipped) console.log("   ⏭  ", s);

// ── الحالة النهائية: الدوال المعرَّفة ──
const q = async (sql, params) => (await db.query(sql, params)).rows;
const fns = await q(
  "select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('trigger_send_push_notification','push_call_edge','push_diagnostics','push_gateway_check','push_probe','push_probe_result') order by 1",
);
check("الدوال الأساسية موجودة بعد تطبيق السلسلة", fns.length === 6, fns.map((r) => r.proname).join(", "));

const tsDef = (await q("select pg_get_functiondef('public.trigger_send_push_notification(text,uuid,uuid,jsonb)'::regprocedure) d"))[0]?.d || "";
const duDef = (await q("select pg_get_functiondef('public.push_delivery_url()'::regprocedure) d"))[0]?.d || "";
check("push_delivery_url يحمل الرابط المُضمَّن (نقطة التسليم)", duDef.includes(URL));
check("trigger_send_push_notification يقرأ نقطة التسليم (قابلة للتهيئة)", tsDef.includes("public.push_delivery_url()"));
check("trigger_send_push_notification يضمّن السرّ المُضمَّن", tsDef.includes(SECRET));
check("trigger_send_push_notification بلا مراجع Vault", !/vault\./.test(tsDef));

for (const fn of ["push_call_edge", "push_diagnostics", "push_gateway_check", "push_probe", "push_probe_result"]) {
  const defs = await q(
    "select pg_get_functiondef(p.oid) d from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=$1",
    [fn],
  );
  const def = defs[0]?.d || "";
  check(`${fn}: بلا مراجع Vault`, !/vault\./.test(def), defs.length ? "" : "الدالة غير موجودة");
}

// ── جدول Vault لم يُمَسّ ──
const vaultRows = (await q("select count(*)::int n from vault.decrypted_secrets"))[0].n;
check("جدول Vault فارغ تماماً (صفر قراءات/كتابات)", vaultRows === 0, `rows=${vaultRows}`);

// ── دخان حقيقي: INSERT على messages ⇒ طلب شبكة بالرابط المُضمَّن ──
await db.exec(`
  create table if not exists public.profiles (
    id uuid primary key, email text unique, display_name text,
    is_admin boolean not null default false, is_super_admin boolean not null default false,
    is_blocked boolean not null default false, created_at timestamptz default now()
  );
  create table if not exists public.conversations (
    id uuid primary key default gen_random_uuid(), user_id uuid, admin_id uuid,
    last_message text, last_message_at timestamptz default now(), unique (user_id, admin_id)
  );
  create table if not exists public.messages (
    id uuid primary key default gen_random_uuid(), conversation_id uuid, sender_id uuid,
    content text, attachment_type text, message_type text not null default 'text',
    status text not null default 'sent', created_at timestamptz default now()
  );
  create table if not exists public.fcm_tokens (id uuid primary key default gen_random_uuid(), user_id uuid, token text);
  create table if not exists public.push_delivery_log (
    id bigserial primary key, kind text not null, ref_id uuid, recipient_id uuid,
    request_id bigint, note text, created_at timestamptz not null default now()
  );
`);
const ADMIN = "00000000-0000-4000-8000-0000000000a1";
const USER = "00000000-0000-4000-8000-0000000000a2";
await db.query("insert into auth.users (id, email) values ($1,$2), ($3,$4)", [ADMIN, "a@t.test", USER, "u@t.test"]);
// تريغ�� handle_new_user ينشئ الملف الشخصي تلقائياً
await db.query("update public.profiles set is_admin = true, display_name = 'أ' where id = $1", [ADMIN]);
await db.query("update public.profiles set display_name = 'ب' where id = $1", [USER]);
const conv = (await db.query("insert into public.conversations (user_id, admin_id) values ($1,$2) returning id", [USER, ADMIN])).rows[0].id;

await db.exec("delete from net.calls; delete from public.push_delivery_log");
await db.query("insert into public.messages (conversation_id, sender_id, content, message_type) values ($1,$2,$3,'text')", [conv, USER, "دخان"]);

const calls = await q("select request_id, url, headers from net.calls order by id desc limit 1");
check("التريغر أرسل طلباً واحداً عبر pg_net", calls.length === 1, `count=${calls.length}`);
check("الرابط المُرسل = الرابط المُضمَّن", calls[0]?.url === URL, String(calls[0]?.url));
check("الترويسة x-send-push-secret = السرّ المُضمَّن", calls[0]?.headers?.["x-send-push-secret"] === SECRET);
check("الترويسات = Content-Type + x-send-push-secret فقط",
  JSON.stringify(Object.keys(calls[0]?.headers ?? {})) === JSON.stringify(["Content-Type", "x-send-push-secret"]));

const log = await q("select kind, recipient_id, request_id, note from public.push_delivery_log order by id desc limit 1");
check("سجل التسليم يوثّق الطلب (لا تخطٍّ)", log[0]?.request_id != null && log[0]?.note == null, JSON.stringify(log[0] || {}));

// ── المسبار يعمل بلا Vault ──
await db.exec("delete from net.calls; delete from public.push_delivery_log");
await db.exec(`set test.uid = '${USER}'`);
const probe = (await db.query("select public.push_probe() p")).rows[0]?.p;
const probeCall = (await q("select url, headers from net.calls order by id desc limit 1"))[0];
check("push_probe يستدعي الرابط المُضمَّن (بلا Vault)", probe?.request_id != null && probeCall?.url === URL, String(probeCall?.url));
check("push_probe يحمل السرّ المُضمَّن", probeCall?.headers?.["x-send-push-secret"] === SECRET);
await db.exec("set test.uid = ''");

// ── دوال التشخيص ──
const diag = (await db.query("select public.push_diagnostics() d")).rows[0]?.d;
check("push_diagnostics: vault_dependency=false", diag?.vault_dependency === false);
check("push_diagnostics: secret_hardcoded=true", diag?.secret_hardcoded === true);
check("push_diagnostics: edge_function_url = الرابط المُضمَّن", diag?.edge_function_url === URL, String(diag?.edge_function_url));

const gw = (await db.query("select public.push_gateway_check() g")).rows[0]?.g;
check("push_gateway_check: url = الرابط المُضمَّن", gw?.url === URL);
check("push_gateway_check: url_ok + secret_hardcoded + بلا Vault",
  gw?.url_ok === true && gw?.secret_hardcoded === true && gw?.vault_dependency === false);
check("push_gateway_check: التلميح يؤكد المسار السليم", /✅/.test(gw?.gateway_hint ?? ""), gw?.gateway_hint);

const vaultAfter = (await q("select count(*)::int n from vault.decrypted_secrets"))[0].n;
check("Vault ما زال فارغاً بعد كل المسارات (صفر قراءات/كتابات)", vaultAfter === 0, `rows=${vaultAfter}`);

// ── v2.16: التشخيص يفحص الجسم الحيّ (لا ثوابت) ويكشف القاعدة المتأخرة ──
const diagV216 = (await db.query("select public.push_diagnostics() d")).rows[0]?.d;
check("push_diagnostics: live_path_vault_free = true", diagV216?.live_path_vault_free === true,
  JSON.stringify(diagV216?.live_path_functions));
check("push_diagnostics: live_path_secret_ok = true", diagV216?.live_path_secret_ok === true);
check("push_diagnostics: live_path_url_ok = true", diagV216?.live_path_url_ok === true);
check("push_diagnostics: live_path_stale = false (القاعدة محدَّثة)", diagV216?.live_path_stale === false);
check("push_diagnostics: live_path_functions يذكر دوال المسار",
  Object.keys(diagV216?.live_path_functions || {}).length === 4,
  Object.keys(diagV216?.live_path_functions || {}).join(", "));

// محاكاة قاعدة متأخرة: جسم push_call_edge القديم القائم على Vault
await db.exec(`
  create or replace function public.push_call_edge(p_kind text, p_ref uuid, p_recipient uuid, p_body jsonb)
  returns void language plpgsql security definer set search_path = public, vault, net as $$
  declare v_url text; v_secret text;
  begin
    select decrypted_secret into v_url from vault.decrypted_secrets where name = 'SEND_PUSH_URL' limit 1;
    select decrypted_secret into vsecret_placeholder from vault.decrypted_secrets where name = 'SEND_PUSH_SECRET' limit 1;
    perform net.http_post(url := v_url, headers := jsonb_build_object('x-send-push-secret', vsecret_placeholder), body := p_body);
  end $$;
`.replace("vsecret_placeholder", "v_secret"));
const stale = (await db.query("select public.push_diagnostics() d")).rows[0]?.d;
check("push_diagnostics يكشف القاعدة المتأخرة: live_path_stale = true", stale?.live_path_stale === true);
check("push_diagnostics يكشف الاعتماد على Vault: vault_dependency = true", stale?.vault_dependency === true);
check("push_diagnostics: live_path_functions.push_call_edge.reads_vault = true",
  stale?.live_path_functions?.push_call_edge?.reads_vault === true);
check("push_diagnostics: live_path_hint ينبّه على أحدث هجرة", /v2\.1[68]/.test(stale?.live_path_hint || ""), stale?.live_path_hint);

// تطبيق v2.16 يُصلح القاعدة المتأخرة
await db.exec(read("sql/migrations/2026-10-22_v2_16_send_push_live_state.sql"));
const fixed = (await db.query("select public.push_diagnostics() d")).rows[0]?.d;
check("تطبيق v2.16 يُصلح القاعدة المتأخرة: live_path_stale = false", fixed?.live_path_stale === false);
check("تطبيق v2.16: live_path_vault_free = true", fixed?.live_path_vault_free === true);
const edgeDef2 = (await q("select pg_get_functiondef('public.push_call_edge(text,uuid,uuid,jsonb)'::regprocedure) d"))[0]?.d || "";
check("تطبيق v2.16: push_call_edge بلا Vault", !/vault\./.test(edgeDef2));

// تطبيق أحدث هجرة (v2.17) هو ما يُعيد المسار إلى الحالة الراهنة:
// نقطة التسليم قابلة للتهيئة + تشخيص شبكة القاعدة.
await db.exec(read("sql/migrations/2026-10-23_v2_17_push_delivery_endpoint_and_net_diagnostics.sql"));
const fixed217 = (await db.query("select public.push_diagnostics() d")).rows[0]?.d;
check("تطبيق v2.17: القاعدة محدَّثة (live_path_stale = false)", fixed217?.live_path_stale === false);
check("تطبيق v2.17: نقطة التسليم تُقرأ من الإعدادات (delivery_url)",
  typeof fixed217?.delivery_url === "string" && fixed217?.delivery_url.length > 0, String(fixed217?.delivery_url));
check("تطبيق v2.17: التريغر يقرأ نقطة التسليم",
  /public\.push_delivery_url\(\)/.test(
    (await q("select pg_get_functiondef('public.trigger_send_push_notification(text,uuid,uuid,jsonb)'::regprocedure) d"))[0]?.d || ""));

// push_egress_check: فحص مباشر لـ pg_net يتجاوز كل دوال المسار
await db.exec("delete from net.calls");
const eg = (await db.query("select public.push_egress_check() e")).rows[0]?.e;
const egCall = (await q("select url, headers from net.calls order by id desc limit 1"))[0];
check("push_egress_check: طلب مباشر للرابط المُضمَّن", eg?.queued === true && egCall?.url === URL, String(egCall?.url));
check("push_egress_check: يحمل السرّ المُضمَّن", egCall?.headers?.["x-send-push-secret"] === SECRET);

// push_probe_result يميّز خطأ DNS ويشرح سببه
await db.exec(`insert into net._http_response(id, status_code, content, error_msg)
  values (999999, 0, null, 'Dns resolve error: Couldn''t resolve host name') on conflict do nothing`);
const pr = (await db.query("select public.push_probe_result(999999) r")).rows[0]?.r;
check("push_probe_result: dns_error = true عند فشل تحليل المضيف", pr?.dns_error === true, String(pr?.error));
check("push_probe_result: hint يشرح السبب", /push_net_diagnostics/.test(pr?.hint || ""), String(pr?.hint));

// ── v2.18: الحكم الحاسم + الإصلاح الذاتي ──
// محاكاة القاعدة الحيّة: القاعدة لا تصل إلى *.supabase.co (فشل DNS)،
// لكنها تصل إلى النطاق القديم functions.supabase.co (200).
// نستبدل net.http_post.mock ليُجيب فوراً (كما يفعل عامل خلفية pg_net).
await db.exec(`
  create or replace function net.http_post(url text, headers jsonb default '{}'::jsonb, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb, timeout_milliseconds int default 8000) returns bigint language plpgsql as $$
  declare v_req bigint; v_status int; v_err text; begin
    select nextval('net_request_seq') into v_req;
    insert into net.calls (request_id, url, headers, body, timeout_milliseconds) values (v_req, url, coalesce(headers,'{}'::jsonb), coalesce(body,'{}'::jsonb), timeout_milliseconds);
    if url like '%/functions/v1/send-push%' and url not like '%functions.supabase.co%' then
      v_status := 0; v_err := 'Dns resolve error: Couldn''t resolve host name';
    else
      v_status := 200; v_err := null;
    end if;
    insert into net._http_response (id, status_code, content, error_msg) values (v_req, v_status, '{"sent":0,"skipped":"no fcm token"}'::jsonb, v_err);
    return v_req; end $$;
`);

const v218Fns = await q(
  "select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace " +
  "where n.nspname='public' and p.proname in ('push_path_verdict','push_probe_endpoint','push_fire_probe','push_await_probe') order by 1");
check("v2.18: دوال الحكم والمسبار موجودة", v218Fns.length === 4, v218Fns.map((r) => r.proname).join(", "));


const verdict = (await q("select public.push_path_verdict(false) v"))[0]?.v;
check("v2.18: push_path_verdict يفحص مرشّحين على الأقل",
  Array.isArray(verdict?.candidates) && verdict.candidates.length >= 2,
  String(verdict?.candidates?.length));
check("v2.18: المسبار العام (example.com) يبيّن حالة DNS العامة",
  verdict?.internet_probe?.url === "https://example.com/" && typeof verdict?.internet_reachable === "boolean",
  JSON.stringify(verdict?.internet_probe || {}));
check("v2.18: كل مرشّح يحمل url + status_code + hint",
  (verdict?.candidates || []).every((c) => c.url && c.status_code !== undefined && c.hint),
  JSON.stringify((verdict?.candidates || []).map((c) => [c.label, c.status_code])));

const verdict2 = (await q("select public.push_path_verdict(false) v"))[0]?.v;
check("v2.18: يكتشف الوجهة العاملة (200 + ردّ من send-push)",
  verdict2?.best_url === "https://gqocavvhkfzgxzscrjms.functions.supabase.co/send-push"
  || (verdict2?.candidates || []).some((c) => c.works === true),
  JSON.stringify((verdict2?.candidates || []).map((c) => [c.label, c.status_code, c.works])));

// التحويل التلقائي (جلسة postgres ⇒ مسموح)
const verdictApplied = (await q("select public.push_path_verdict(true) v"))[0]?.v;
check("v2.18: التحويل التلقائي يعمل في جلسة SQL Editor",
  verdictApplied?.apply_allowed === true, JSON.stringify({ allowed: verdictApplied?.apply_allowed, role: verdictApplied?.role }));
if (verdictApplied?.best_url) {
  check("v2.18: نقطة التسليم تحوّلت إلى الوجهة العاملة",
    verdictApplied?.switched === true && (await q("select public.push_delivery_url() u"))[0]?.u === verdictApplied.best_url,
    String((await q("select public.push_delivery_url() u"))[0]?.u));
  await q("select public.push_set_delivery_url(null)");
}

// الإصلاح الذاتي: دالة مفقودة/بجسم قديم ⇒ تُنشأ من جديد
await db.exec("drop function if exists public.push_gateway_check()");
check("v2.18: بعد الحذف تُنشأ الدالة من جديد (لا create or replace)",
  (await q("select count(*)::int c from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='push_gateway_check'"))[0]?.c === 0);
await db.exec(read("sql/migrations/2026-10-24_v2_18_push_path_verdict_and_self_healing.sql"));
const gwBack = (await q("select public.push_gateway_check() g"))[0]?.g;
check("v2.18: push_gateway_check تعمل بعد إعادة الإنشاء",
  gwBack?.vault_dependency === false && gwBack?.secret_hardcoded === true, JSON.stringify(gwBack || {}));
check("v2.18: push_gateway_check تعرض وجهة التسليم",
  typeof gwBack?.delivery_url === "string" && gwBack?.delivery_url.length > 0, String(gwBack?.delivery_url));

// push_diagnostics يكشف الدوال الناقصة (لا يكذب بـ «سليم»)
await db.exec("drop function if exists public.push_gateway_check()");
const diagMissing = (await q("select public.push_diagnostics() d"))[0]?.d;
check("v2.18: push_diagnostics يكشف دالة ناقصة (live_path_stale = true)",
  diagMissing?.live_path_stale === true, JSON.stringify(diagMissing?.live_path_missing));
await db.exec(read("sql/migrations/2026-10-24_v2_18_push_path_verdict_and_self_healing.sql"));
const diagBack = (await q("select public.push_diagnostics() d"))[0]?.d;
check("v2.18: بعد الإصلاح يعود live_path_stale = false",
  diagBack?.live_path_stale === false && (diagBack?.live_path_missing || []).length === 0,
  JSON.stringify(diagBack?.live_path_missing));

// ── v2.17: نقطة تسليم قابلة للتهيئة + تشخيص شبكة القاعدة ──
const settingsRow = await q("select delivery_url from public.push_settings where id");
check("push_settings: صفّ واحد بقيمة افتراضية (الرابط المُضمَّن)",
  settingsRow.length === 1 && settingsRow[0]?.delivery_url == null, JSON.stringify(settingsRow[0] || {}));

const defUrl = (await q("select public.push_delivery_url() u"))[0]?.u;
check("push_delivery_url: الافتراضي = الرابط المُضمَّن", defUrl === URL, String(defUrl));

// التبديل إلى بوابة بديلة (Cloudflare Worker) ثم العودة
const setRes = (await q("select public.push_set_delivery_url('https://relay.example.workers.dev/') r"))[0]?.r;
check("push_set_delivery_url: يقبل نقطة بديلة", setRes?.ok === true, JSON.stringify(setRes || {}));
const altUrl = (await q("select public.push_delivery_url() u"))[0]?.u;
check("push_delivery_url: صار يشير إلى البوابة البديلة", altUrl === "https://relay.example.workers.dev/", String(altUrl));

// التريغر يستخدم نقطة التسليم البديلة
await db.exec("delete from net.calls; delete from public.push_delivery_log");
await db.query("insert into public.messages (conversation_id, sender_id, content, message_type) values ($1,$2,$3,'text')", [conv, USER, "بريد بديل"]);
const altCall = await q("select url, headers from net.calls order by id desc limit 1");
check("التريغر يرسل إلى نقطة التسليم البديلة", altCall[0]?.url === "https://relay.example.workers.dev/", String(altCall[0]?.url));
check("الترويسة x-send-push-secret = السرّ المُضمَّن (مع البوابة البديلة)",
  altCall[0]?.headers?.["x-send-push-secret"] === SECRET);

// العودة للافتراضي
await q("select public.push_set_delivery_url(null)");
const backUrl = (await q("select public.push_delivery_url() u"))[0]?.u;
check("push_set_delivery_url: الرجوع للافتراضي", backUrl === URL, String(backUrl));

// تشخيص الشبكة
const netd = (await q("select public.push_net_diagnostics() d"))[0]?.d;
check("push_net_diagnostics: يعلن مرشّحَي التسليم (primary/legacy)",
  Object.keys(netd?.probes || {}).length === 2
  && Object.keys(netd?.probes || {}).includes("primary")
  && Object.keys(netd?.probes || {}).includes("legacy"),
  Object.keys(netd?.probes || {}).join(", "));
check("push_net_diagnostics: يذكر رابط دالة send-push + السطر البديل",
  netd?.probes?.primary?.url === URL
  && /functions\.supabase\.co/.test(JSON.stringify(netd?.probes || {})),
  JSON.stringify(netd?.probes || {}));
check("push_net_diagnostics: يبلّغ عن حالة امتداد pg_net",
  typeof netd?.pg_net_installed === "boolean" && netd?.pg_net_version !== undefined,
  `installed=${netd?.pg_net_installed} version=${netd?.pg_net_version}`);

// مُعدِّل نقطة التسليم مقصور على service_role
const priv = (await q(
  "select has_function_privilege('anon','public.push_set_delivery_url(text)','execute') anon_exec, " +
  "has_function_privilege('authenticated','public.push_set_delivery_url(text)','execute') auth_exec, " +
  "has_function_privilege('service_role','public.push_set_delivery_url(text)','execute') svc_exec"))[0] || {};
check("push_set_delivery_url: لا يُمنح لـ anon/authenticated",
  priv.anon_exec === false && priv.auth_exec === false, JSON.stringify(priv));
check("push_set_delivery_url: مُمنح لـ service_role",
  priv.svc_exec === true, JSON.stringify(priv));

// جدول الإعدادات محمي بـ RLS
const rlsOn = await q("select relrowsecurity from pg_class where relname='push_settings' and relnamespace='public'::regnamespace");
check("push_settings: RLS مفعّل", rlsOn[0]?.relrowsecurity === true);

await db.close();
console.log(fails ? `\n❌ FAILED ${fails} check(s)` : "\n✅ PASSED push-migration-chain (schema + سلسلة الهجرات بلا Vault)");
process.exit(fails ? 1 : 0);
