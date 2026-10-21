/*
 * تحقّق شامل: تطبيق سلسلة الهجرات كاملةً على PostgreSQL حقيقي (PGlite)
 * والتأكد أن مسار التريگرات يعمل بالرابط والسرّ المُضمَّنين (بلا Vault).
 *
 * التشغيل: node tests/tmp-apply-all.mjs
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
check("trigger_send_push_notification يضمّن الرابط المُضمَّن", tsDef.includes(URL));
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

await db.close();
console.log(fails ? `\n❌ FAILED ${fails} check(s)` : "\n✅ PASSED push-migration-chain (schema + سلسلة الهجرات بلا Vault)");
process.exit(fails ? 1 : 0);
