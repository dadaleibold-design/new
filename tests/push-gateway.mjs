/*
 * Push delivery checks: direct FCM HTTP v1, hardcoded trigger endpoint (v2.15), API-key compat, and safe SW.
 * Run with: node tests/push-gateway.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const SEND_PUSH = read("supabase/functions/send-push/index.ts");
const SW = read("firebase-messaging-sw.js");
const ENV = read(".env.example");
const MIGRATION_V215 = read("sql/migrations/2026-10-21_v2_15_hardcoded_send_push_endpoint.sql");
const SCHEMA = read("sql/schema.sql");
const CONFIG = read("supabase/config.toml");

// الرابط والسر المُضمَّنان في مسار التريگرات (v2.15) — يُستخرجان من نص الهجرة
// حتى يبقى الاختبار متوافقاً مع أي تعديل لاحق على القيمتين.
const HARDCODED_URL = MIGRATION_V215.match(/v_url text := '([^']+)'/)?.[1] ?? "";
const HARDCODED_SECRET = MIGRATION_V215.match(/v_secret text := '([^']+)'/)?.[1] ?? "";

let fails = 0;
const check = (name, ok, extra = "") => {
  console.log(ok ? "✅" : "❌", name, extra ? `— ${extra}` : "");
  if (!ok) fails += 1;
};

check("send-push يرسل مباشرة إلى FCM HTTP v1 بلا Worker", /fcm\.googleapis\.com\/v1\/projects/.test(SEND_PUSH) && !/workers\.dev|PUSH_GATEWAY_URL/.test(SEND_PUSH));
check("OAuth2 service-account JWT موقّع ومحدّد بنطاق FCM", /RSASSA-PKCS1-v1_5/.test(SEND_PUSH) && /firebase\.messaging/.test(SEND_PUSH) && /oauth2\.googleapis\.com\/token/.test(SEND_PUSH));
check("مفتاح خدمة Firebase يقرأ من أسرار Edge Function لا من العميل", /FIREBASE_SERVICE_ACCOUNT/.test(SEND_PUSH) && /FIREBASE_PRIVATE_KEY/.test(ENV) && !/VITE_FIREBASE_PRIVATE_KEY/.test(ENV));
check("المهلة والـ retry للأخطاء العابرة محفوظان", /AbortSignal\.timeout\(10_000\)/.test(SEND_PUSH) && /429, 500, 502, 503, 504/.test(SEND_PUSH));
check("FCM يرسل data-only مع Android priority وTTL وWebPush Urgency/TTL", /data: fittedData/.test(SEND_PUSH) && /priority: priority === "high" \? "HIGH"/.test(SEND_PUSH) && /Urgency: priority/.test(SEND_PUSH) && /TTL: String\(ttlSeconds\)/.test(SEND_PUSH));
check("رمز UNREGISTERED فقط يحذف توكن FCM؛ لا حذف بسبب 404 عشوائي", /UNREGISTERED\|registration-token-not-registered/.test(SEND_PUSH) && !/status === 404\) return true/.test(SEND_PUSH));
check("Service Worker يعرض data-only من push الخام حتى مع تعذّر تحميل env.js", /importScripts\("\.\/env\.js"\)/.test(SW) && /addEventListener\("push"/.test(SW) && /raw push handler will render/.test(SW));

// --- v2.15: مسار التريگرات برابط وسرّ مُضمَّنين — بلا Vault ---
check("v2.15: رابط send-push مُضمَّن مباشرة في trigger_send_push_notification",
  HARDCODED_URL === "https://gqocavvhkfzgxzscrjms.supabase.co/functions/v1/send-push", HARDCODED_URL);
check("v2.15: السر المشترك مُضمَّن ويُرسل في x-send-push-secret",
  HARDCODED_SECRET.length > 0 && /'x-send-push-secret', v_secret/.test(MIGRATION_V215));
// نصوص SQL بلا تعليقات: فحص «بلا Vault» يستهدف مراجع الكائنات لا الكلمة في الشروح
const v215Code = MIGRATION_V215
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");
const VAULT_REF = /vault\.(decrypted_secrets|secrets|create_secret)/;

check("v2.15: مسار التريگرات لا يقرأ من vault.secrets ولا vault.decrypted_secrets",
  !VAULT_REF.test(v215Code));
check("v2.15: push_call_edge تفوّض إلى trigger_send_push_notification",
  /perform public\.trigger_send_push_notification\(p_kind, p_ref, p_recipient, p_body\)/.test(MIGRATION_V215));
check("v2.15: net.http_post غير متزامن داخل مسار التريگر",
  /select net\.http_post\(url := v_url, headers := v_headers, body := p_body, timeout_milliseconds := 8000\)/.test(MIGRATION_V215));
check("v2.15: التشخيص يعلن الرابط المُضمَّن وحالة بلا Vault",
  /'edge_function_url', 'https:\/\/gqocavvhkfzgxzscrjms/.test(MIGRATION_V215) && /'vault_dependency', false/.test(MIGRATION_V215));
check("v2.15: القسم مضاف إلى schema.sql", SCHEMA.includes("21. الإصدار v2.15 (2026-10-21)") && SCHEMA.includes("create or replace function public.trigger_send_push_notification("));
check("migration v2.14 موجودة في schema.sql", SCHEMA.includes("20. الإصدار v2.14 (2026-10-18)") && SCHEMA.includes("sb_(publishable|secret)_"));
check("send-push يبقى متاحاً لنداءات pg_net بدون JWT عند وجود السر", /verify_jwt = false/.test(CONFIG));

let PGlite;
try {
  ({ PGlite } = await import("@electric-sql/pglite"));
} catch {
  console.log("⏭ التنفيذ على PGlite متخطّى (npm ci لتثبيت devDependencies)");
  process.exit(fails ? 1 : 0);
}

const db = new PGlite();
await db.exec(`
  do $$ begin if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if; end $$;
  create schema vault;
  create table vault.decrypted_secrets (name text primary key, decrypted_secret text not null);
  create schema net;
  create table net.calls (url text, headers jsonb, body jsonb);
  create table net._http_response (id bigint, status_code int, content jsonb, error_msg text);
  create table public.push_delivery_log (id bigserial primary key, kind text, ref_id uuid, recipient_id uuid, request_id bigint, note text, created_at timestamptz default now());
  create or replace function public.push_recipient_allowed(text, uuid, uuid, jsonb) returns boolean language sql as $$ select true $$;
  create or replace function public.push_skip_note(text, uuid) returns text language sql as $$ select 'skip' $$;
  create or replace function net.http_post(url text, headers jsonb, body jsonb, timeout_milliseconds int default 8000) returns bigint language plpgsql as $$ begin insert into net.calls values (url, headers, body); return 123; end $$;
`);
await db.exec(MIGRATION_V215);
const setSecret = async (name, value) => {
  await db.query("delete from vault.decrypted_secrets where name=$1", [name]);
  if (value !== null) await db.query("insert into vault.decrypted_secrets values ($1,$2)", [name, value]);
};
const callEdge = async () => db.query("select public.push_call_edge('probe', gen_random_uuid(), gen_random_uuid(), '{}'::jsonb)");
const lastCall = async () => (await db.query("select url, headers, body from net.calls order by ctid desc limit 1")).rows[0];

// ① Vault فارغ تماماً: المسار يعمل برابط وسرّ مُضمَّنين (إصلاح "Couldn't resolve host name")
await db.exec("delete from net.calls; delete from public.push_delivery_log; delete from vault.decrypted_secrets");
await callEdge();
let call = await lastCall();
check("Vault فارغ: الطلب يُرسل بالرابط المُضمَّن", call?.url === HARDCODED_URL, String(call?.url));
check("Vault فارغ: ترويسة x-send-push-secret = السر المُضمَّن", call?.headers?.["x-send-push-secret"] === HARDCODED_SECRET);
check("Vault فارغ: الترويسات = Content-Type + x-send-push-secret فقط (بلا apikey/Authorization)",
  JSON.stringify(Object.keys(call?.headers ?? {})) === JSON.stringify(["Content-Type", "x-send-push-secret"]), JSON.stringify(Object.keys(call?.headers ?? {})));

// ② قيم Vault (ولو خاطئة/مشفّرة) لا تؤثر: الرابط والسرّ يُقرآن من الكود مباشرة
await db.exec("delete from net.calls; delete from public.push_delivery_log");
await setSecret("SEND_PUSH_URL", "https://bogus.invalid/wrong-endpoint");
await setSecret("SEND_PUSH_SECRET", "wrong-secret-from-vault");
await callEdge();
call = await lastCall();
check("Vault يحمل رابطاً خاطئاً: المسار يستخدم الرابط المُضمَّن لا قيمة Vault", call?.url === HARDCODED_URL, String(call?.url));
check("Vault يحمل سراً خاطئاً: يُستخدم السر المُضمَّن لا قيمة Vault", call?.headers?.["x-send-push-secret"] === HARDCODED_SECRET);

// ③ صفر قراءات Vault في مسار التريگر: جدول فارغ ⇒ نداء واحد فقط بلا أي مساس بـ Vault
await db.exec("delete from net.calls; delete from public.push_delivery_log; delete from vault.decrypted_secrets");
await callEdge();
const vaultRows = (await db.query("select count(*)::int n from vault.decrypted_secrets")).rows[0].n;
const netCalls = (await db.query("select count(*)::int n from net.calls")).rows[0].n;
check("مسار التريگرات لا يكتب ولا يقرأ Vault إطلاقاً", vaultRows === 0 && netCalls === 1, `vault_rows=${vaultRows} net_calls=${netCalls}`);
const tsDef = (await db.query("select pg_get_functiondef('public.trigger_send_push_notification(text,uuid,uuid,jsonb)'::regprocedure) d")).rows[0].d;
check("تعريف trigger_send_push_notification لا يذكر Vault", !VAULT_REF.test(tsDef));

// ④ البوابة المركزية قبل أي طلب شبكة (عزل v2.9 محفوظ)
await db.exec("delete from net.calls; delete from public.push_delivery_log");
await db.query("create or replace function public.push_recipient_allowed(text, uuid, uuid, jsonb) returns boolean language sql as $$ select false $$");
await callEdge();
check("البوابة ترفض ⇒ لا نداء شبكة + سبب مُسجَّل في push_delivery_log",
  (await db.query("select count(*)::int n from net.calls")).rows[0].n === 0 &&
  /skip/.test((await db.query("select note from public.push_delivery_log order by id desc limit 1")).rows[0]?.note ?? ""));

// ⑤ التشخيص: القيم مُضمَّنة ولا كشف لأسرار
await db.query("create or replace function public.push_recipient_allowed(text, uuid, uuid, jsonb) returns boolean language sql as $$ select true $$");
const diag = (await db.query("select public.push_gateway_check() as result")).rows[0]?.result;
check("push_gateway_check: url_ok والمصدر مُضمَّن بلا Vault",
  diag?.url === HARDCODED_URL && diag?.url_ok === true && diag?.vault_dependency === false && diag?.url_hardcoded === true);

console.log(fails ? `\n❌ PUSH TESTS FAILED: ${fails}` : "\nPUSH TESTS PASSED");
await db.close();
process.exit(fails ? 1 : 0);
