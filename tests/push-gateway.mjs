/*
 * اختبار بوابة الإرسال (Cloudflare Worker) — v2026-10-15.1
 * -------------------------------------------------------------
 * يحمي التعديل المعماري من الانحدار:
 *   1) send-push = طبقة أمان/عزل فقط: لا FCM مباشر، لا OAuth2/JWT، لا أسرار Firebase.
 *   2) لكل جهاز POST واحد إلى الـ Worker بالعقد {token,title,body,data}
 *      (+ تلميحا priority/ttlSeconds) مع ترويستي مصادقة.
 *   3) ⛔ حارس الحلقة: البوابة لا تقبل رابط دالة Supabase نفسها.
 *   4) هجرة v2.12 تعمل فعلياً على PostgreSQL (PGlite): push_gateway_check
 *      يكتشف الإعداد السليم وخطأ توجيه Vault SEND_PUSH_URL إلى الـ Worker.
 *   5) الـ Triggers ودالة push_call_edge بقيت بلا تغيير منطقي (المسار:
 *      Trigger ➔ Edge Function ➔ Worker ➔ FCM ➔ Service Worker).
 *
 * التشغيل: node tests/push-gateway.mjs
 * (الجزء التنفيذي على PGlite يتخطّى نفسه إن لم تكن الحزمة مثبّتة.)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

let fails = 0;
const check = (name, ok, extra = "") => {
  console.log(ok ? "✅" : "❌", name, extra ? `— ${extra}` : "");
  if (!ok) fails += 1;
};

const SEND_PUSH = read("supabase/functions/send-push/index.ts");
// الكود الفعلي بلا تعليقات التوثيق (التعليقات تذكر الأسماء القديمة تاريخياً)
const stripComments = (code) =>
  String(code)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1 ");
const SEND_PUSH_CODE = stripComments(SEND_PUSH);
const PAYLOAD = read("supabase/functions/send-push/payload.ts");
const MIGRATION_PATH = "sql/migrations/2026-10-15_v2_12_push_gateway_worker.sql";
const MIGRATION = fs.existsSync(path.join(ROOT, MIGRATION_PATH)) ? read(MIGRATION_PATH) : "";
const SCHEMA = read("sql/schema.sql");
const ENV_EXAMPLE = read(".env.example");
const CONFIG_TOML = read("supabase/config.toml");

/** رابط الـ Worker المعتمد (غير سرّي — نقطة نهاية عامة) */
const WORKER_URL = "https://nameless-dew-aac1.aabntlal680.workers.dev/";

/* ---------- 1) الفصل المعماري: أمان في الـ Edge Function، إرسال في الـ Worker ---------- */
check(
  "send-push لا يتصل بـ FCM مباشرة (لا fcm.googleapis.com)",
  !/fcm\.googleapis\.com/.test(SEND_PUSH),
);
check(
  "send-push لا يولّد توكنات Google OAuth2/JWT (أُزيلت getFirebaseAccessToken و jose)",
  !/getFirebaseAccessToken|importPKCS8|SignJWT|oauth2\.googleapis\.com/.test(SEND_PUSH_CODE),
);
check(
  "send-push لا يقرأ أسرار Firebase (ملك الـ Worker الآن)",
  !/Deno\.env\.get\("FIREBASE_/.test(SEND_PUSH),
);
check(
  "send-push يستدعي بوابة الـ Worker المعتمدة كقيمة افتراضية",
  SEND_PUSH.includes(WORKER_URL),
);
check(
  "send-push يبني الحمولة عبر fitFcmData (عقد data-only v2026-10-13.2 محفوظ)",
  /import \{ fitFcmData \} from "\.\/payload\.ts"/.test(SEND_PUSH) && /fitFcmData\(data\)/.test(SEND_PUSH),
);
check(
  "payload.ts ما زال يضبط حمولة FCM على الحد الأقصى (4KB)",
  /MAX_FCM_DATA_BYTES/.test(PAYLOAD) && /export function fitFcmData/.test(PAYLOAD),
);

/* ---------- 2) عقد الطلب لكل جهاز ---------- */
check(
  "الإرسال POST واحد لكل جهاز إلى رابط واحد (البوابة)",
  /await fetch\(GATEWAY_URL, \{[\s\S]*?method: "POST"/.test(SEND_PUSH),
);
check(
  "جسم الطلب يحمل token و title و body و data",
  /\{\s*token,\s*\n\s*title: fittedData\.title \|\| "",\s*\n\s*body: fittedData\.body \|\| "",\s*\n\s*data: fittedData,/.test(SEND_PUSH),
);
check(
  "تلميحا الأولوية والصلاحية يُرفقان (priority/ttlSeconds)",
  /priority: urgent \? "high" : "normal"/.test(SEND_PUSH) &&
    /ttlSeconds: opts\.highPriority \? 60 : 86400/.test(SEND_PUSH),
);
check(
  "مصادقة البوابة: Authorization Bearer + x-send-push-secret من GATEWAY_SECRET",
  /headers\["Authorization"\] = `Bearer \$\{GATEWAY_SECRET\}`/.test(SEND_PUSH) &&
    /headers\["x-send-push-secret"\] = GATEWAY_SECRET/.test(SEND_PUSH),
);
check(
  "GATEWAY_SECRET من PUSH_GATEWAY_SECRET وإلا SEND_PUSH_SECRET",
  /Deno\.env\.get\("PUSH_GATEWAY_SECRET"\)/.test(SEND_PUSH) &&
    /SEND_PUSH_SECRET\?\.trim\(\)\s*\|\|\s*""/.test(SEND_PUSH),
);
check(
  "مهلة لكل طلب حتى لا تتعطل الدفعة بجهاز بلا جواب",
  /AbortSignal\.timeout\(10_000\)/.test(SEND_PUSH),
);

/* ---------- 3) الحواجز الأمنية ---------- */
check(
  "⛔ حارس الحلقة: رفض /functions/v1/ في رابط البوابة",
  /candidate\.includes\("\/functions\/v1\/"\)/.test(SEND_PUSH),
);
check(
  "الـ Triggers ما زالت تعتمد السر المشترك (isAuthorized بحذفيه)",
  /function isAuthorized\(req: Request\)/.test(SEND_PUSH) &&
    SEND_PUSH.includes("x-send-push-secret"),
);
check(
  "حذف التوكن الميّت عبر البوابة: 410 أو أنماط صريحة — لا 404 وحدها (حماية من خطأ توجيه البوابة)",
  /status === 410/.test(SEND_PUSH) &&
    !/status === 404\) return true/.test(SEND_PUSH) &&
    /UNREGISTERED\|registration-token-not-registered\|Requested entity was not found/.test(SEND_PUSH),
);
check(
  "إعادة المحاولة للأخطاء العابرة (429/5xx) محفوظة",
  /429, 500, 502, 503, 504/.test(SEND_PUSH) && /FCM_MAX_ATTEMPTS/.test(SEND_PUSH),
);
check(
  "بوابة Supabase ما زالت بلا تحقق JWT للـ Triggers (config.toml)",
  /verify_jwt = false/.test(CONFIG_TOML),
);

/* ---------- 4) الهجرة وschema.sql ---------- */
check(
  "هجرة v2.12 موجودة وتوثّق رابط الـ Worker",
  MIGRATION.includes("2026-10-15") && MIGRATION.includes(WORKER_URL),
);
check(
  "الهجرة تضيف push_gateway_check لتشخيص البوابة",
  /create or replace function public\.push_gateway_check\(\)/.test(MIGRATION) &&
    /vault_url_is_worker/.test(MIGRATION),
);
check(
  "الهجرة تحذّر من توجيه Vault SEND_PUSH_URL إلى الـ Worker (تجاوز طبقة الأمان)",
  /خطأ إعداد: Vault SEND_PUSH_URL يشير إلى الـ Worker مباشرة/.test(MIGRATION),
);
check(
  "الهجرة توثّق push_call_edge بتعليق (المنطق بلا تغيير)",
  /comment on function public\.push_call_edge\(text, uuid, uuid, jsonb\)/.test(MIGRATION),
);
check(
  "schema.sql يحوي القسم 18 (v2.12) و push_gateway_check",
  /18\. الإصدار v2\.12 \(2026-10-15\): بوابة الإرسال عبر Cloudflare Worker/.test(SCHEMA) &&
    /create or replace function public\.push_gateway_check\(\)/.test(SCHEMA),
);
check(
  "دالة قاعدة البيانات لا تكشف قيم الأسرار (بلا vault_url/vault_secret_len الخام)",
  !/"vault_url",|'vault_url',|vault_secret_len/.test(MIGRATION),
);
check(
  ".env.example يوثّق متغيري البوابة",
  ENV_EXAMPLE.includes("PUSH_GATEWAY_URL") && ENV_EXAMPLE.includes("PUSH_GATEWAY_SECRET"),
);

/* ---------- 5) التنفيذ الفعلي لهجرة v2.12 على PostgreSQL (PGlite) ---------- */
let PGlite;
try {
  ({ PGlite } = await import("@electric-sql/pglite"));
} catch {
  console.log("⏭  التنفيذ الفعلي للهجرة (PGlite) متخطّى — ثبّت الحزمة بـ: npm i --no-save @electric-sql/pglite");
  if (fails) {
    console.log(`\n❌ PUSH GATEWAY TESTS FAILED: ${fails}`);
    process.exit(1);
  }
  console.log("\nPUSH GATEWAY TESTS PASSED (الجزء الثابت)");
  process.exit(0);
}

const db = new PGlite();

await db.exec(`
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then
      create role authenticated nologin;
    end if;
  end $$;
  -- بنية Vault الدنيا التي تقرأها الدوال
  create schema if not exists vault;
  create table if not exists vault.decrypted_secrets (
    id serial primary key,
    name text not null,
    decrypted_secret text not null default '',
    created_at timestamptz not null default now()
  );
  -- دالة push_call_edge موجودة في الإنتاج قبل الهجرة (نسخة مختصرة للفحص)
  create or replace function public.push_call_edge(p_kind text, p_ref uuid, p_recipient uuid, p_body jsonb)
  returns void language plpgsql as $$ begin return; end $$;
`);

await db.exec(MIGRATION);

const setVault = async (name, value) => {
  await db.query(`delete from vault.decrypted_secrets where name = $1`, [name]);
  if (value !== null) {
    await db.query(`insert into vault.decrypted_secrets (name, decrypted_secret) values ($1, $2)`, [name, value]);
  }
};

const gatewayCheck = async () => {
  const { rows } = await db.query(`select public.push_gateway_check() as v`);
  return rows[0].v;
};

// (أ) الإعداد السليم: Vault SEND_PUSH_URL = رابط دالة send-push
await setVault("SEND_PUSH_URL", "https://example-ref.supabase.co/functions/v1/send-push");
await setVault("SEND_PUSH_SECRET", "very-long-shared-secret");
await setVault("SUPABASE_ANON_KEY", "eyJhbGciOi.eyJzdWIi.SflKxwRJ");
{
  const v = await gatewayCheck();
  check(
    "الإعداد السليم: vault_url_ok وتلميح ✅",
    v.vault_url_ok === true && v.vault_url_is_edge_function === true && String(v.gateway_hint).startsWith("✅"),
    String(v.gateway_hint).slice(0, 60),
  );
  check("الإعداد السليم: ليس عاملاً على الـ Worker", v.vault_url_is_worker === false);
}

// (ب) الخطأ الشائع: توجيه التريگرات إلى الـ Worker مباشرة (تجاوز الأمان)
await setVault("SEND_PUSH_URL", WORKER_URL);
{
  const v = await gatewayCheck();
  check(
    "⛔ رصد توجيه Vault إلى الـ Worker (تحذير صريح)",
    v.vault_url_is_worker === true && v.vault_url_ok === false &&
      String(v.gateway_hint).startsWith("⚠️"),
    String(v.gateway_hint).slice(0, 60),
  );
}

// (ج) بلا إعداد: أعلام صفرية وتلميح تحذيري
await setVault("SEND_PUSH_URL", null);
await setVault("SEND_PUSH_SECRET", null);
{
  const v = await gatewayCheck();
  check(
    "بلا إعداد: vault_url_set=false وتلميح تحذيري",
    v.vault_url_set === false && v.vault_secret_set === false && String(v.gateway_hint).startsWith("⚠️"),
  );
}

// (د) إعادة التنفيذ آمنة (idempotent)
let idempotent = true;
try {
  await db.exec(MIGRATION);
  await db.exec(MIGRATION);
} catch {
  idempotent = false;
}
check("إعادة تنفيذ الهجرة آمنة (idempotent)", idempotent);

console.log(fails ? `\n❌ PUSH GATEWAY TESTS FAILED: ${fails}` : "\nPUSH GATEWAY TESTS PASSED");
process.exit(fails ? 1 : 0);
