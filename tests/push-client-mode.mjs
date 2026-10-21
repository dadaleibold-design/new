/**
 * tests/push-client-mode.mjs — بنية «وضع العميل» (v2.19)
 * ============================================================================
 * الهدف: إثبات أن مسار الإشعارات انتقل بالكامل إلى الواجهة:
 *   ① القاعدة **لا** تُجري أي طلب شبكة في وضع العميل (لا net.calls إطلاقاً).
 *   ② التبديل إلى 'db' يعيد السلوك القديم (للتراجع) — بلا هجرة جديدة.
 *   ③ جداول البيانات وسياسات RLS لم تُمَسّ.
 *   ④ دالة send-push تقبل مسارات client_* بمصادقة رمز المستخدم (JWT)
 *      ولا تقبلsender_id من العميل.
 *   ⑤ الواجهة تطلق الإرسال من Realtime وتتحقق من اتصال العميل لا من القاعدة.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8")
  .replace(/create extension if not exists pg_net;/g, "-- [pglite] pg_net mocked");

let fails = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "✅" : "❌"} ${name}${cond ? "" : " — " + detail}`);
  if (!cond) fails += 1;
};

const MIGRATION = read("sql/migrations/2026-10-25_v2_19_client_side_push_mode.sql");
const SCHEMA = read("sql/schema.sql");
const FN = read("supabase/functions/send-push/index.ts");
const APP = read("js/app.js");
const CLIENT_PUSH = read("js/clientPush.js");

// ── فحوص ثابتة على الكود ──
check("v2.19: هجرة الوضع موجودة وتُعرّف push_mode",
  /create or replace function public\.push_mode\(\)/.test(MIGRATION)
  && /create or replace function public\.push_set_mode\(p_mode text\)/.test(MIGRATION));
check("v2.19: الوضع الافتراضي = client",
  /push_mode text not null default 'client'/.test(MIGRATION));
check("v2.19: تبديل الوضع مقصور على service_role",
  /revoke all on function public\.push_set_mode\(text\) from public, anon, authenticated/.test(MIGRATION)
  && /grant execute on function public\.push_set_mode\(text\) to service_role/.test(MIGRATION));
check("v2.19: التريغر لا يتصل بالشبكة في وضع العميل",
  /if v_mode = 'client' then[\s\S]{0,600}return;/.test(MIGRATION)
  && /CLIENT-MODE/.test(MIGRATION));
check("v2.19: net.http_post ما زال موجوداً (وضع التراجع db)",
  /net\.http_post/.test(MIGRATION));
check("v2.19: push_diagnostics يعلن الوضع",
  /'push_mode', v_mode/.test(MIGRATION) && /'db_push_enabled', v_mode = 'db'/.test(MIGRATION));
check("v2.19: push_path_verdict يتخطّى فحص الشبكة في وضع العميل",
  /if v_mode = 'client' then/.test(MIGRATION));
check("v2.19: صفر مراجع Vault في كود الهجرة",
  !/vault\.(decrypted_secrets|secrets|create_secret)/.test(
    MIGRATION.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n")));
check("v2.19: القسم مضاف إلى schema.sql (§25)",
  SCHEMA.includes("25. الإصدار v2.19 (2026-10-25)")
  && SCHEMA.includes("create or replace function public.push_mode()"));

// ── دالة send-push: مسارات العميل ──
check("send-push: مسار العميل بمصادقة رمز المستخدم",
  /client_/.test(FN) && /supabase\.auth\.getUser\(tokenVal\)/.test(FN));
check("send-push: client_probe موجود (فحص من المتصفح)",
  /input\.type === "client_probe"/.test(FN));
check("send-push: المُرسِل يُثبَّت من الرمز (لا من العميل)",
  /if \(clientUser && String\(msg\.sender_id\) !== clientUser\.id\)/.test(FN)
  && /sender_id: senderId/.test(FN));
check("send-push: المتصل يُثبَّت من الرمز للمكالمات",
  /if \(clientUser && String\(room\.caller_id\) !== clientUser\.id\)/.test(FN)
  && /caller_id: callerId/.test(FN));
check("send-push: إشعار المستخدم الجديد للمشرفين فقط",
  /forbidden: admins only/.test(FN));
check("send-push: مسار العميل لا يحتاج السرّ المشترك (رمز المستخدم يكفي)",
  /if \(!clientUser && !isAuthorized\(req\)\)/.test(FN));
check("send-push: مسارات client_* تقبل السرّ المشترك بديلاً عن الرمز",
  /clientViaSecret/.test(FN)
  && /if \(!clientUser && isAuthorized\(req\)\) clientViaSecret = true;/.test(FN)
  && /Unauthorized: يلزم رمز مستخدم صالح أو x-send-push-secret/.test(FN));
check("send-push: بالسرّ المشترك يبقى المُرسِل من سجلّ القاعدة (لا انتحال)",
  /const senderId = clientUser \? clientUser\.id : String\(msg\.sender_id\);/.test(FN)
  && /const callerId = clientUser \? clientUser\.id : String\(room\.caller_id\);/.test(FN));
check("send-push: فحص المشرف يمرّ مع الرمز فقط (السرّ مسار خادم)",
  /if \(clientUser\) \{[\s\S]{0,320}forbidden: admins only/.test(FN));
check("send-push: منع الإرسال المكرر (عدة أجهزة للمرسل)",
  /isDuplicatePush\(messageId\)/.test(FN) && /markPushSent\(messageId\)/.test(FN) && /_pushSeen/.test(FN));
check("send-push: يُسجَّل التكرار بعد نجاح الإرسال فقط (لا تُضيع إعادة المحاولة)",
  FN.indexOf("markPushSent(messageId)") > FN.indexOf("sendToAllDevices(tokens, fcmData, { priority: \"high\", ttlSeconds: 86400 })"));
check("send-push: لا يُقرأ sender_id من جسم الطلب في مسار العميل",
  !/input\.sender_id/.test(FN.split('if (input.type === "client_message")')[0] || ""));

// ── الواجهة ──
check("clientPush.js: يستخدم رمز الجلسة دائماً",
  /supabase\.auth\.getSession\(\)/.test(CLIENT_PUSH)
  && /Authorization/.test(CLIENT_PUSH));
check("clientPush.js: لا يحتوي السرّ مُضمَّناً (يأتي من البيئة فقط)",
  !/my_send_push_19921121_almgawell_19921121/.test(CLIENT_PUSH));
check("clientPush.js: يرسل ترويسة x-send-push-secret إن كان مُهيّأً",
  /x-send-push-secret/.test(CLIENT_PUSH) && /SEND_PUSH_SECRET/.test(CLIENT_PUSH));
check("clientPush.js: يرسل رمز المستخدم دائماً (Authorization)",
  /Authorization: `Bearer \$\{token\}`/.test(CLIENT_PUSH));
const ENV_SRC = read("js/env.js");
const requiredBlock = (ENV_SRC.split("export const REQUIRED_ENV_KEYS")[1] || "").split("]);")[0];
check("env.js: مفتاح السرّ اختياري (ليس ضمن المطلوب)",
  /VITE_SEND_PUSH_SECRET/.test(ENV_SRC) && !/VITE_SEND_PUSH_SECRET/.test(requiredBlock));
check("config.js: يعيد تصدير السرّ",
  /SEND_PUSH_SECRET/.test(read("js/config.js")));
check("clientPush.js: يوفّر message/call/new_user/probe",
  /clientPushMessage/.test(CLIENT_PUSH) && /clientPushCall/.test(CLIENT_PUSH)
  && /clientPushNewUser/.test(CLIENT_PUSH) && /clientPushProbe/.test(CLIENT_PUSH));
check("app.js: يستورد وحدة الإرسال من العميل",
  /from "\.\/clientPush\.js"/.test(APP));
check("app.js: يطلق الإشعار من حدث Realtime (رسالة جديدة)",
  /notifyRecipientByClient\(msg\)/.test(APP) && /clientPushMessage\(/.test(APP));
check("app.js: يطلق إشعار المكالمة من Realtime",
  /clientPushCall\(/.test(APP));
check("app.js: يطلق إشعار المستخدم الجديد من Realtime",
  /clientPushNewUser\(/.test(APP));
check("app.js: التشخيص يفحص اتصال العميل لا شبكة القاعدة",
  /clientPushProbe\(\)/.test(APP)
  && !/push_egress_check/.test(APP));
check("app.js: التشخيص يعلن وضع القاعدة",
  /push_mode/.test(APP));

// ── اختبار سلوكي على القاعدة (PGlite) ──
const db = new PGlite();
const q = async (sql, params) => (await db.query(sql, params)).rows;

await db.exec(`
  do $$ begin if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if; end $$;
  do $$ begin if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if; end $$;
  do $$ begin if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if; end $$;
  create schema if not exists auth; create schema if not exists storage; create schema if not exists vault;
  create schema if not exists net; create schema if not exists extensions;
  create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
  create table if not exists auth.users (id uuid primary key default gen_random_uuid(), email text unique, phone text, raw_user_meta_data jsonb default '{}'::jsonb, created_at timestamptz default now());
  create table if not exists storage.buckets (id text primary key, name text unique not null, owner uuid, public boolean default false, created_at timestamptz default now(), updated_at timestamptz default now());
  create table if not exists storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid, created_at timestamptz default now(), updated_at timestamptz default now());
  create or replace function storage.foldername(name text) returns text[] language plpgsql immutable as $$ declare _p text[]; begin select string_to_array(name, '/') into _p; return case when array_length(_p,1)>1 then _p[1:array_length(_p,1)-1] else '{}'::text[] end; end $$;
  create or replace function storage.extension(name text) returns text language sql immutable as $$ select substring(name from '\\.[^.]+$') $$;
  do $$ begin if not exists (select 1 from pg_publication where pubname='supabase_realtime') then create publication supabase_realtime; end if; end $$;
  create or replace function auth.role() returns text language sql stable as $$ select nullif(current_setting('request.jwt.claim.role', true), '') $$;
  create or replace function auth.email() returns text language sql stable as $$ select nullif(current_setting('request.jwt.claim.email', true), '') $$;
  create or replace function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $$;
  create or replace function public.uuid_generate_v4() returns uuid language sql volatile as $$ select gen_random_uuid() $$;
  create table if not exists auth.roles (id text primary key);
  insert into auth.roles (id) values ('anon'),('authenticated'),('service_role') on conflict do nothing;
  create table if not exists vault.decrypted_secrets (name text primary key, decrypted_secret text not null);
  create table if not exists net.calls (id bigserial primary key, request_id bigint, url text, headers jsonb, body jsonb, timeout_milliseconds int, created_at timestamptz default now());
  create table if not exists net._http_response (id bigint primary key, status_code int, content jsonb, error_msg text);
  create sequence if not exists net_request_seq as bigint start 900;
  create or replace function net.http_post(url text, headers jsonb default '{}'::jsonb, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb, timeout_milliseconds int default 8000) returns bigint language plpgsql as $$
  declare v_req bigint; begin select nextval('net_request_seq') into v_req;
    insert into net.calls (request_id, url, headers, body, timeout_milliseconds) values (v_req, url, coalesce(headers,'{}'::jsonb), coalesce(body,'{}'::jsonb), timeout_milliseconds);
    return v_req; end $$;
`);

try {
  await db.exec(read("sql/schema.sql"));
  for (const f of [
    "sql/migrations/2026-10-21_v2_15_hardcoded_send_push_endpoint.sql",
    "sql/migrations/2026-10-22_v2_16_send_push_live_state.sql",
    "sql/migrations/2026-10-23_v2_17_push_delivery_endpoint_and_net_diagnostics.sql",
    "sql/migrations/2026-10-24_v2_18_push_path_verdict_and_self_healing.sql",
    "sql/migrations/2026-10-25_v2_19_client_side_push_mode.sql",
  ]) {
    try { await db.exec(read(f)); } catch (e) { console.log("   ⏭", path.basename(f), String(e.message).split("\n")[0].slice(0, 80)); }
  }

  const USER = "00000000-0000-4000-8000-0000000000a1";
  const ADMIN = "00000000-0000-4000-8000-0000000000b1";
  await db.query("insert into auth.users (id, email, raw_user_meta_data) values ($1,$2,'{}'::jsonb),($3,$4,'{}'::jsonb) on conflict do nothing",
    [USER, "u1@x.test", ADMIN, "a1@x.test"]);
  const conv = (await db.query("insert into public.conversations (user_id, admin_id) values ($1,$2) returning id", [USER, ADMIN])).rows[0].id;

  // ① الوضع الافتراضي = client
  const mode = (await q("select public.push_mode() m"))[0]?.m;
  check("القاعدة: الوضع الافتراضي = client", mode === "client", String(mode));

  // ② رسالة ⇒ لا طلب شبكة إطلاقاً
  await db.exec("delete from net.calls; delete from public.push_delivery_log");
  await db.query("insert into public.messages (conversation_id, sender_id, content, message_type) values ($1,$2,$3,'text')", [conv, USER, "بدون شبكة"]);
  const calls = await q("select count(*)::int c from net.calls");
  check("القاعدة: وضع العميل ⇒ صفر طلب شبكة (لا net.http_post)", calls[0]?.c === 0, `calls=${calls[0]?.c}`);
  const logRows = await q("select note from public.push_delivery_log order by id desc limit 1");
  check("القاعدة: يسجّل النيّة فقط (CLIENT-MODE)",
    /CLIENT-MODE/.test(logRows[0]?.note || ""), JSON.stringify(logRows[0] || {}));

  // ③ التبديل إلى db ⇒ يعود الطلب
  await q("select public.push_set_mode('db')");
  await db.exec("delete from net.calls; delete from public.push_delivery_log");
  await db.query("insert into public.messages (conversation_id, sender_id, content, message_type) values ($1,$2,$3,'text')", [conv, USER, "مع الشبكة"]);
  const callsDb = await q("select count(*)::int c from net.calls");
  check("القاعدة: التبديل إلى 'db' يعيد مسار pg_net (تراجع)", callsDb[0]?.c >= 1, `calls=${callsDb[0]?.c}`);

  // ④ العودة إلى client
  await q("select public.push_set_mode('client')");
  const mode2 = (await q("select public.push_mode() m"))[0]?.m;
  check("القاعدة: العودة إلى 'client'", mode2 === "client", String(mode2));

  // ⑤ التشخيص يعلن الوضع
  const diag = (await q("select public.push_diagnostics() d"))[0]?.d;
  check("القاعدة: push_diagnostics يعلن push_mode = client",
    diag?.push_mode === "client" && diag?.db_push_enabled === false, JSON.stringify({ m: diag?.push_mode, e: diag?.db_push_enabled }));
  const verdict = (await q("select public.push_path_verdict(false) v"))[0]?.v;
  check("القاعدة: push_path_verdict في وضع العميل لا يُطلق مسبرات",
    verdict?.mode === "client" && (verdict?.candidates || []).length === 0, JSON.stringify(verdict?.mode));

  // ⑥ الجداول والسياسات سليمة
  const pol = await q("select count(*)::int c from pg_policies where schemaname = 'public' and tablename = 'messages'");
  check("البيانات: سياسات RLS على messages سليمة", pol[0]?.c >= 3, `policies=${pol[0]?.c}`);
  const tbl = await q("select relname from pg_class where relname in ('messages','conversations','fcm_tokens','push_delivery_log') and relnamespace = 'public'::regnamespace");
  check("البيانات: الجداول الأساسية قائمة", tbl.length === 4, tbl.map((t) => t.relname).join(", "));
} finally {
  await db.close();
}

console.log(fails ? `\n❌ FAILED ${fails} check(s)` : "\n✅ PASSED push-client-mode (بنية وضع العميل)");
process.exit(fails ? 1 : 0);
