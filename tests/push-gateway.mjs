/*
 * Push delivery checks: direct FCM HTTP v1, API-key compatibility, and safe SW.
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
const MIGRATION = read("sql/migrations/2026-10-18_v2_14_push_auth_key_compat.sql");
const SCHEMA = read("sql/schema.sql");
const CONFIG = read("supabase/config.toml");

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
check("JWT القديم والمفتاح sb_publishable_/sb_secret_ مدعومان ببوابة قاعدة البيانات", /sb_\(publishable\|secret\)_/.test(MIGRATION) && /Authorization', 'Bearer '/.test(MIGRATION) && /apikey/.test(MIGRATION));
check("المفتاح الحديث لا يُرسل كـ Bearer، والـ secret المشترك مطلوب", /if v_is_jwt then/.test(MIGRATION) && /x-send-push-secret/.test(MIGRATION) && /not \(\s*v_is_jwt or v_api_key/.test(MIGRATION));
check("التشخيص الحالي يقبل صيغة المفتاح الحديث ويشير إلى FCM المباشر", /sb_\(publishable\|secret\)_/.test(MIGRATION) && /FCM HTTP v1 مباشرة/.test(MIGRATION));
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
  create table net.calls (headers jsonb, body jsonb);
  create table public.push_delivery_log (kind text, ref_id uuid, recipient_id uuid, request_id bigint, note text);
  create or replace function public.push_recipient_allowed(text, uuid, uuid, jsonb) returns boolean language sql as $$ select true $$;
  create or replace function public.push_skip_note(text, uuid) returns text language sql as $$ select 'skip' $$;
  create or replace function net.http_post(url text, headers jsonb, body jsonb, timeout_milliseconds int default 8000) returns bigint language plpgsql as $$ begin insert into net.calls values (headers, body); return 123; end $$;
`);
await db.exec(MIGRATION);
const setSecret = async (name, value) => {
  await db.query("delete from vault.decrypted_secrets where name=$1", [name]);
  if (value !== null) await db.query("insert into vault.decrypted_secrets values ($1,$2)", [name, value]);
};
const callEdge = async () => db.query("select public.push_call_edge('probe', gen_random_uuid(), gen_random_uuid(), '{}'::jsonb)");
const headers = async () => (await db.query("select headers from net.calls order by ctid desc limit 1")).rows[0]?.headers;

await setSecret("SEND_PUSH_URL", "https://example.supabase.co/functions/v1/send-push");
await setSecret("SEND_PUSH_SECRET", "long-trigger-secret");
await setSecret("SUPABASE_ANON_KEY", "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.signature");
await callEdge();
let requestHeaders = await headers();
check("JWT legacy: Authorization Bearer + apikey + secret header", (requestHeaders?.authorization || requestHeaders?.Authorization)?.startsWith("Bearer eyJ") && requestHeaders?.apikey?.startsWith("eyJ") && requestHeaders?.["x-send-push-secret"] === "long-trigger-secret");

await db.exec("delete from net.calls");
await setSecret("SUPABASE_ANON_KEY", "sb_publishable_test_public_key_123");
await callEdge();
requestHeaders = await headers();
check("sb_publishable: apikey + shared secret بلا Authorization غير JWT", requestHeaders?.apikey === "sb_publishable_test_public_key_123" && !requestHeaders?.authorization && requestHeaders?.["x-send-push-secret"] === "long-trigger-secret");

await db.exec("delete from net.calls; delete from public.push_delivery_log");
await setSecret("SUPABASE_ANON_KEY", "bad-key");
await callEdge();
const skipped = (await db.query("select note from public.push_delivery_log order by ctid desc limit 1")).rows[0]?.note;
check("مفتاح غير صالح: fail-closed مسجل في push_delivery_log وبلا نداء شبكة", /^SKIPPED:/.test(skipped || "") && (await db.query("select count(*)::int n from net.calls")).rows[0].n === 0);

await setSecret("SUPABASE_ANON_KEY", "sb_publishable_test_public_key_123");
const diag = (await db.query("select public.push_gateway_check() as result").catch(() => ({ rows: [] }))).rows[0]?.result;
if (diag) check("تشخيص الإعداد يقبل sb_publishable", diag.auth_key_set === true);

console.log(fails ? `\n❌ PUSH TESTS FAILED: ${fails}` : "\nPUSH TESTS PASSED");
await db.close();
process.exit(fails ? 1 : 0);
