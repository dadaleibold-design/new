/*
 * تحقّق فعلي من هجرة v2.10 (حداثة الرنين) على PostgreSQL حقيقي (PGlite/WASM)
 * -------------------------------------------------------------
 *   • غرفة ringing حديثة موجّهة لـ auth.uid() ⇒ true
 *   • غرفة ringing أقدم من دقيقتين ⇒ false (لا رنين لمكالمة منتهية الصلاحية)
 *   • غرفة بحالة غير ringing (answered/ended/missed) ⇒ false
 *   • غرفة موجّهة لغير المستدعي (طرف آخر أو المتصل نفسه) ⇒ false
 *   • غرفة غير موجودة ⇒ false
 *   • إعادة تنفيذ الهجرة بأمان (idempotent)
 *
 * التشغيل:
 *   npm i --no-save @electric-sql/pglite && node tests/sql-v210-postgres.mjs
 * (يتخطّى نفسه بلا فشل إن لم تكن الحزمة مثبّتة.)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let PGlite;
try {
  ({ PGlite } = await import("@electric-sql/pglite"));
} catch {
  console.log("⏭  اختبار هجرة v2.10 (PGlite) متخطّى — ثبّت الحزمة بـ: npm i --no-save @electric-sql/pglite");
  process.exit(0);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATION = fs.readFileSync(
  path.join(ROOT, "sql/migrations/2026-10-14_v2_10_call_ring_freshness.sql"),
  "utf8"
);

const db = new PGlite();
let fails = 0;
const check = (name, ok, extra = "") => {
  console.log(ok ? "✅" : "❌", name, extra);
  if (!ok) fails += 1;
};

const CALLEE = "00000000-0000-4000-8000-0000000000aa";
const CALLER = "00000000-0000-4000-8000-0000000000bb";
const OTHER = "00000000-0000-4000-8000-0000000000cc";

await db.exec(`
  -- أدوار Supabase القياسية (غير موجودة في PGlite افتراضياً)
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then
      create role authenticated nologin;
    end if;
  end $$;
  create schema if not exists auth;
  create or replace function auth.uid() returns uuid
  language sql stable as $$
    select nullif(current_setting('test.uid', true), '')::uuid;
  $$;

  create table public.call_rooms (
    id uuid primary key default gen_random_uuid(),
    caller_id uuid not null,
    callee_id uuid not null,
    status text not null default 'ringing',
    started_at timestamptz not null default now()
  );
`);

// غرف الاختبار: تُنشأ بوقت قاعدة البيانات نفسه (now()) ثم نعدّل started_at
const insertRoom = async (caller, callee, status, startedAgo) => {
  const { rows } = await db.query(
    `insert into public.call_rooms (caller_id, callee_id, status, started_at)
     values ($1, $2, $3, now() - ($4 || ' seconds')::interval)
     returning id`,
    [caller, callee, status, String(startedAgo)]
  );
  return rows[0].id;
};

const fresh = await insertRoom(CALLER, CALLEE, "ringing", 5);
const stale = await insertRoom(CALLER, CALLEE, "ringing", 180);
const answered = await insertRoom(CALLER, CALLEE, "active", 5);
const ended = await insertRoom(CALLER, CALLEE, "ended", 5);
const missed = await insertRoom(CALLER, CALLEE, "missed", 5);
const toOther = await insertRoom(CALLER, OTHER, "ringing", 5);
const missing = "00000000-0000-4000-8000-0000000000ff";

await db.exec(MIGRATION);

const ringingFor = async (uid, roomId) => {
  await db.exec(`select set_config('test.uid', '${uid}', false)`);
  const { rows } = await db.query("select public.call_room_is_ringing($1::uuid) as ok", [roomId]);
  return rows[0].ok;
};

check("غرفة حديثة ترنّ للمستدعي ⇒ true", (await ringingFor(CALLEE, fresh)) === true);
check("غرفة أقدم من دقيقتين ⇒ false", (await ringingFor(CALLEE, stale)) === false);
check("غرفة مُجابة (active) ⇒ false", (await ringingFor(CALLEE, answered)) === false);
check("غرفة منتهية (ended) ⇒ false", (await ringingFor(CALLEE, ended)) === false);
check("غرفة فائتة (missed) ⇒ false", (await ringingFor(CALLEE, missed)) === false);
check("غرفة موجّهة لطرف آخر ⇒ false للمستدعي", (await ringingFor(CALLEE, toOther)) === false);
check("المتصل لا يرى رنيناً لنفسه ⇒ false", (await ringingFor(CALLER, fresh)) === false);
check("غرفة غير موجودة ⇒ false", (await ringingFor(CALLEE, missing)) === false);
check("مستخدم الطرف الآخر يرى الغرفة الموجّهة إليه فقط", (await ringingFor(OTHER, toOther)) === true);

// الدالة تُنفَّذ بصلاحية المستدعي (security invoker) ولا تُظهر إلا غرف الحساب
const grants = await db.query(
  "select prosecdef from pg_proc where proname = 'call_room_is_ringing'"
);
check("الدالة security invoker (لا تتجاوز RLS)", grants.rows[0]?.prosecdef === false);

// إعادة التنفيذ آمنة
let rerunOk = true;
try {
  await db.exec(MIGRATION);
} catch (error) {
  rerunOk = false;
  console.log(String(error));
}
check("إعادة تنفيذ الهجرة بأمان (idempotent)", rerunOk);

console.log(fails ? `\nFAILED ${fails}` : "\nPASSED sql-v210-postgres");
process.exit(fails ? 1 : 0);
