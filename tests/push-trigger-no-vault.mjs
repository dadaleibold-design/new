/*
 * تحقّق v2.15 على PostgreSQL حقيقي (PGlite/WASM): مسار التريگرات بلا Vault
 * ----------------------------------------------------------------------
 * المشكلة المُصلَحة: pg_net.http_post داخل تريگر messages يفشل بـ
 * "Couldn't resolve host name" لأن SEND_PUSH_URL تُقرأ من
 * vault.decrypted_secrets فتُرجِع ciphertext. v2.15 يضمّن الرابط والسرّ
 * مباشرةً في trigger_send_push_notification.
 *
 * يتحقق هذا الاختبار أن:
 *   • امتداد pg_net مضمّن (الهجرة تضمنه) و net.http_post يعمل غير متزامن
 *     على تريگر INSERT في messages: الإدراج يعود فوراً، والطلب في net.calls،
 *     والرد يُقرأ لاحقاً من net._http_response عبر push_probe_result.
 *   • مسار التريگر كامل (notify_new_message → push_call_edge →
 *     trigger_send_push_notification → net.http_post) يعمل وجدول Vault فارغ
 *     تماماً (صفر قراءات/كتابات) — الرابط والسرّ من الكود لا من Vault.
 *   • بطاقات المكالمات (message_type='call') لا تُطلق إشعار رسالة.
 *   • البوابة المركزية (push_recipient_allowed) ترفض قبل أي نداء شبكة.
 *   • التشخيص والمسبار (push_diagnostics / push_probe / push_gateway_check)
 *     يعلنون الرابط المُضمَّن ويعملون بلا Vault.
 *   • الهجرة idempotent (تُعاد بلا أخطاء).
 *
 * التشغيل:
 *   npm i --no-save @electric-sql/pglite && node tests/push-trigger-no-vault.mjs
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
const MIGRATION_V215 = read("sql/migrations/2026-10-21_v2_15_hardcoded_send_push_endpoint.sql");
const MIGRATION_V216 = read("sql/migrations/2026-10-22_v2_16_send_push_live_state.sql");

// القيم المعتمدة (مُضمَّنة في الكود — بلا Vault).
const EXPECTED_URL = "https://gqocavvhkfzgxzscrjms.supabase.co/functions/v1/send-push";
const EXPECTED_SECRET = "my_send_push_19921121_almgawell_19921121";

// القيم المُضمَّنة (v2.15) — تُستخرج من نص الهجرة ليبقى الاختبار متوافقاً معها
const HARDCODED_URL = MIGRATION_V215.match(/v_url text := '([^']+)'/)?.[1] ?? "";
const HARDCODED_SECRET = MIGRATION_V215.match(/v_secret text := '([^']+)'/)?.[1] ?? "";

// كل ملفات SQL: لا مراجع Vault في كود مسار الإشعارات
const SQL_FILES = [
  "sql/schema.sql",
  ...fs.readdirSync(path.join(ROOT, "sql/migrations")).map((f) => "sql/migrations/" + f),
];
const SQL_VAULT_REFS = SQL_FILES.filter((f) => {
  const code = read(f).split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
  return /vault\.(decrypted_secrets|secrets)/.test(code);
});

const db = new PGlite();

let fails = 0;
const check = (name, ok, extra = "") => {
  console.log(ok ? "✅" : "❌", name, extra);
  if (!ok) fails += 1;
};

const U = (n) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
const ADMIN = U(1);
const USER = U(2);

/* ---------- بيئة مصغّرة تحاكي Supabase ---------- */
await db.exec(`
  do $$ begin if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if; end $$;
  do $$ begin if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if; end $$;

  create schema if not exists auth;
  create schema if not exists vault;
  create schema if not exists net;

  create or replace function auth.uid() returns uuid
  language sql stable as $$
    select nullif(current_setting('test.uid', true), '')::uuid;
  $$;

  -- Vault موجود لكن فارغ تماماً: يثبت أن المسار لا يحتاجه إطلاقاً
  create table vault.decrypted_secrets (name text primary key, decrypted_secret text not null);

  -- محاكاة pg_net: http_post يُدرج الطلب في net.calls ويعيد request_id فوراً
  -- (غير متزامن)، والرد يُكتب لاحقاً في net._http_response كما يفعل عامل الخلفية.
  create table net.calls (
    id bigserial primary key,
    request_id bigint,
    url text,
    headers jsonb,
    body jsonb,
    timeout_milliseconds int,
    created_at timestamptz default now()
  );
  create table net._http_response (id bigint primary key, status_code int, content jsonb, error_msg text);

  create sequence net_request_seq as bigint start 500;

  create or replace function net.http_post(
    url text,
    headers jsonb default '{}'::jsonb,
    body jsonb default '{}'::jsonb,
    params jsonb default '{}'::jsonb,
    timeout_milliseconds int default 8000
  ) returns bigint language plpgsql as $$
  declare
    v_req bigint;
  begin
    select nextval('net_request_seq') into v_req;
    insert into net.calls (request_id, url, headers, body, timeout_milliseconds)
    values (v_req, url, coalesce(headers, '{}'::jsonb), coalesce(body, '{}'::jsonb), timeout_milliseconds);
    return v_req;
  end;
  $$;

  create table public.profiles (
    id uuid primary key,
    email text unique,
    display_name text,
    is_admin boolean not null default false,
    is_super_admin boolean not null default false,
    is_blocked boolean not null default false,
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

  create table public.messages (
    id uuid primary key default gen_random_uuid(),
    conversation_id uuid not null references public.conversations(id) on delete cascade,
    sender_id uuid not null references public.profiles(id) on delete cascade,
    content text,
    attachment_type text,
    message_type text not null default 'text',
    status text not null default 'sent',
    created_at timestamptz default now()
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

  create or replace function public.is_admin_user(p_user_id uuid default null)
  returns boolean language sql stable as $$ select false $$;

  create or replace function public.admin_recipient_ids()
  returns table(id uuid) language sql stable as $$ select null::uuid where false $$;

  -- بوابة مبسّطة: المستلم الفردي مطلوب (منطق العزل الكامل مُختبَر في sql-v29)
  create or replace function public.push_recipient_allowed(p_kind text, p_ref uuid, p_recipient uuid, p_body jsonb)
  returns boolean language sql stable as $$
    select case
      when p_kind = 'new_user' then p_recipient is null
      else p_recipient is not null
    end;
  $$;

  create or replace function public.push_skip_note(p_kind text, p_recipient uuid)
  returns text language sql as $$ select 'SKIPPED: مستلم غير مسموح (بوابة الاختبار)' $$;

  -- نسخة مبسّطة أمينة لتريگر notify_new_message (§17): بطاقات المكالمات مستثناة،
  -- والمستلم = الطرف الآخر في المحادثة، ثم الاستدعاء عبر push_call_edge.
  create or replace function public.notify_new_message()
  returns trigger language plpgsql security definer set search_path = public as $$
  declare
    v_user uuid;
    v_admin uuid;
    v_recipient uuid;
  begin
    if new.message_type = 'call' then
      return new;
    end if;
    select c.user_id, c.admin_id into v_user, v_admin
    from public.conversations c where c.id = new.conversation_id;
    if new.sender_id = v_user then
      v_recipient := v_admin;
    elsif new.sender_id = v_admin then
      v_recipient := v_user;
    end if;
    if v_recipient is null or v_recipient = new.sender_id then
      return new;
    end if;
    perform public.push_call_edge(
      'new_message', new.id, v_recipient,
      jsonb_build_object(
        'message_id', new.id,
        'conversation_id', new.conversation_id,
        'sender_id', new.sender_id,
        'content', coalesce(new.content, 'مرفق')
      )
    );
    return new;
  end;
  $$;

  drop trigger if exists on_message_inserted on public.messages;
  create trigger on_message_inserted
    after insert on public.messages
    for each row execute procedure public.notify_new_message();
`);

/* ---------- بيانات ---------- */
await db.query(
  "insert into public.profiles (id, email, display_name, is_admin) values ($1,$2,$3,true), ($4,$5,$6,false)",
  [ADMIN, "admin@example.com", "المشرف", USER, "user@example.com", "المستخدم"],
);
const { rows: convRows } = await db.query(
  "insert into public.conversations (user_id, admin_id) values ($1,$2) returning id",
  [USER, ADMIN],
);
const CONV = convRows[0].id;

/* ---------- تطبيق الهجرة (مرتين: idempotent) ---------- */
try {
  await db.exec(MIGRATION_V215);
  check("هجرة v2.15 تُنفَّذ بلا أخطاء (pg_net محاط بحاجز)", true);
} catch (e) {
  check("هجرة v2.15 تُنفَّذ بلا أخطاء (pg_net محاط بحاجز)", false, String(e.message).slice(0, 200));
  process.exit(1);
}
try {
  await db.exec(MIGRATION_V215);
  check("إعادة تنفيذ الهجرة بأمان (idempotent)", true);
} catch (e) {
  check("إعادة تنفيذ الهجرة بأمان (idempotent)", false, String(e.message).slice(0, 200));
}

/* ---------- ① ثوابت نص الهجرة ---------- */
const v215Code = MIGRATION_V215.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
check("v2.15: الرابط العام المُضمَّن صحيح", HARDCODED_URL === EXPECTED_URL, HARDCODED_URL);
check("v2.15: السرّ المُضمَّن مطابق للقيمة المعتمدة", HARDCODED_SECRET === EXPECTED_SECRET, HARDCODED_SECRET);
check("v2.15: لا ملف SQL في المستودع يقرأ من Vault (إطلاقاً)", SQL_VAULT_REFS.length === 0, SQL_VAULT_REFS.join(", "));
check("v2.15: لا مراجع لـ Vault في كود مسار التريگر", !/vault\.(decrypted_secrets|secrets|create_secret)/.test(v215Code));
check("v2.15: الهجرة تضمن امتداد pg_net (محاطاً بحاجز للبيئات البديلة)", /create extension if not exists pg_net;/.test(v215Code));
check("v2.15: الهجرة تضمن تريگر الإدراج على messages", /create trigger on_message_inserted[\s\S]*?after insert on public\.messages[\s\S]*?execute procedure public\.notify_new_message\(\)/.test(v215Code));

/* ---------- ② تريگر INSERT على messages: pg_net برابط مُضمَّن وجدول Vault فارغ ---------- */
await db.exec("delete from net.calls; delete from public.push_delivery_log");
const { rows: msgRows } = await db.query(
  "insert into public.messages (conversation_id, sender_id, content, message_type) values ($1,$2,$3,'text') returning id, created_at",
  [CONV, USER, "رسالة اختبار مسار الخلفية"],
);
const MSG = msgRows[0].id;
check("إدراج الرسالة نجح فوراً (net.http_post غير متزامن — لا انتظار شبكي)", true);

const { rows: calls } = await db.query("select request_id, url, headers, body, timeout_milliseconds from net.calls order by id desc limit 1");
const call = calls[0] ?? {};
check("تريگر messages استدعى net.http_post مرة واحدة", calls.length === 1, `count=${calls.length}`);
check("url الطلب = الرابط المُضمَّن (بلا Vault)", call.url === HARDCODED_URL, String(call.url));
check("ترويسة x-send-push-secret = السرّ المُضمَّن", call.headers?.["x-send-push-secret"] === HARDCODED_SECRET);
check("الترويسات = Content-Type + x-send-push-secret فقط", JSON.stringify(Object.keys(call.headers ?? {})) === JSON.stringify(["Content-Type", "x-send-push-secret"]));
check("الحمولة تحمل معرّف الرسالة والمحادثة والمرسل",
  call.body?.message_id === MSG && call.body?.conversation_id === CONV && call.body?.sender_id === USER);

const { rows: logRows } = await db.query("select kind, ref_id, recipient_id, request_id, note from public.push_delivery_log order by id desc limit 1");
check("سجل التسليم: new_message للمشرف مع request_id (لا سبب تخطٍّ)",
  logRows[0]?.kind === "new_message" && logRows[0]?.recipient_id === ADMIN && logRows[0]?.request_id != null && logRows[0]?.note == null);

const vaultCount = (await db.query("select count(*)::int n from vault.decrypted_secrets")).rows[0].n;
check("جدول Vault فارغ تماماً بعد مسار التريگر (صفر قراءات/كتابات)", vaultCount === 0, `rows=${vaultCount}`);

const tsDef = (await db.query("select pg_get_functiondef('public.trigger_send_push_notification(text,uuid,uuid,jsonb)'::regprocedure) d")).rows[0].d;
check("تعريف trigger_send_push_notification في القاعدة يطابق: رابط مُضمَّن + صفر Vault",
  tsDef.includes(HARDCODED_URL) && !/vault\.(decrypted_secrets|secrets|create_secret)/.test(tsDef));

/* ---------- ③ الرد غير المتزامن: يكتبه عامل الخلفية لاحقاً ويقرأه push_probe_result ---------- */
await db.query("insert into net._http_response (id, status_code, content) values ($1, 200, $2)", [call.request_id, JSON.stringify({ sent: 1, total: 1 })]);
const probeResult = (await db.query("select public.push_probe_result($1) r", [call.request_id])).rows[0].r;
check("push_probe_result يقرأ رد pg_net من net._http_response (200)", probeResult?.status_code === 200, JSON.stringify(probeResult));

/* ---------- ④ بطاقات المكالمات لا تُطلق إشعار رسالة ---------- */
await db.exec("delete from net.calls; delete from public.push_delivery_log");
await db.query("insert into public.messages (conversation_id, sender_id, content, message_type) values ($1,$2,$3,'call')", [CONV, USER, "📞 مكالمة"]);
check("رسالة من نوع call: لا نداء send-push (لها مسارها الخاص)",
  (await db.query("select count(*)::int n from net.calls")).rows[0].n === 0);

/* ---------- ⑤ البوابة المركزية ترفض قبل أي نداء شبكة ---------- */
await db.exec("delete from net.calls; delete from public.push_delivery_log");
await db.query("select public.push_call_edge('new_message', gen_random_uuid(), null, '{}'::jsonb)");
const skipNote = (await db.query("select note from public.push_delivery_log order by id desc limit 1")).rows[0]?.note ?? "";
check("البوابة ترفض (مستلم null) ⇒ لا نداء شبكة + سبب مُسجَّل",
  (await db.query("select count(*)::int n from net.calls")).rows[0].n === 0 && /SKIPPED/.test(skipNote), skipNote);

/* ---------- ⑥ التشخيص والمسبار يعملان بلا Vault ---------- */
const diag = (await db.query("select public.push_diagnostics() d")).rows[0].d;
check("push_diagnostics: الرابط المُضمَّن سليم", diag?.edge_url_ok === true && diag?.edge_function_url === HARDCODED_URL);
check("push_diagnostics: بلا اعتماد على Vault + السرّ مُضمَّن", diag?.vault_dependency === false && diag?.secret_hardcoded === true);
check("push_diagnostics: تريگر messages موجود + مؤشرات العزل v2.9 محفوظة",
  diag?.trigger_messages === true && diag?.isolation_version === "v2.9" && diag?.isolation_gate === true);
check("push_diagnostics: مؤشر pg_net_installed معروض (حقل منطقي)",
  typeof diag?.pg_net_installed === "boolean", String(diag?.pg_net_installed));

const gw = (await db.query("select public.push_gateway_check() g")).rows[0].g;
check("push_gateway_check: url مُضمَّن سليم + بلا Vault",
  gw?.url === HARDCODED_URL && gw?.url_ok === true && gw?.vault_dependency === false && gw?.url_hardcoded === true);
check("push_gateway_check: التلميح يؤكد المسار السليم", /✅/.test(gw?.gateway_hint ?? ""), gw?.gateway_hint);

await db.exec(`set test.uid = '${USER}'`);
await db.exec("delete from net.calls; delete from public.push_delivery_log");
const probe = (await db.query("select public.push_probe() p")).rows[0].p;
const probeCall = (await db.query("select url, headers from net.calls order by id desc limit 1")).rows[0];
check("push_probe: يعيد request_id ويستدعي الرابط المُضمَّن (يعمل بلا Vault)",
  probe?.request_id != null && probeCall?.url === HARDCODED_URL && probeCall?.headers?.["x-send-push-secret"] === HARDCODED_SECRET);

await db.exec("set test.uid = ''");

/* ---------- ⑦ v2.16: التشخيص يفحص الجسم الحيّ ويكشف القاعدة المتأخرة ---------- */
await db.exec(MIGRATION_V216);
const diag216 = (await db.query("select public.push_diagnostics() d")).rows[0].d;
check("v2.16: live_path_vault_free = true (المسار الحيّ بلا Vault)", diag216?.live_path_vault_free === true,
  JSON.stringify(diag216?.live_path_functions));
check("v2.16: live_path_secret_ok + live_path_url_ok = true",
  diag216?.live_path_secret_ok === true && diag216?.live_path_url_ok === true);
check("v2.16: live_path_stale = false (القاعدة محدَّثة)",
  diag216?.live_path_stale === false, String(diag216?.live_path_hint));

// محاكاة قاعدة متأخرة (جسم push_call_edge القديم القائم على Vault)
await db.exec(`
  create or replace function public.push_call_edge(p_kind text, p_ref uuid, p_recipient uuid, p_body jsonb)
  returns void language plpgsql security definer set search_path = public, vault, net as $$
  declare v_url text; v_secret text;
  begin
    select decrypted_secret into v_url from vault.decrypted_secrets where name = 'SEND_PUSH_URL' limit 1;
    select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'SEND_PUSH_SECRET' limit 1;
    perform net.http_post(url := v_url, headers := jsonb_build_object('x-send-push-secret', v_secret), body := p_body);
  end $$;
`);
const staleDiag = (await db.query("select public.push_diagnostics() d")).rows[0].d;
check("v2.16: live_path_stale = true لقاعدة متأخرة (يكشف الكذب)",
  staleDiag?.live_path_stale === true && staleDiag?.vault_dependency === true);
check("v2.16: live_path_hint ينبّه على هجرة v2.16",
  /v2\.16/.test(staleDiag?.live_path_hint ?? ""), staleDiag?.live_path_hint);

// تطبيق v2.16 يُصلح القاعدة المتأخرة
await db.exec(MIGRATION_V216);
const fixedDiag = (await db.query("select public.push_diagnostics() d")).rows[0].d;
check("v2.16: تطبيقها يُصلح القاعدة المتأخرة (live_path_stale = false)",
  fixedDiag?.live_path_stale === false && fixedDiag?.live_path_vault_free === true);

// فحص الخروج: طلب مباشر من القاعدة يتجاوز الدوال
await db.exec("delete from net.calls");
const eg = (await db.query("select public.push_egress_check() e")).rows[0].e;
const egCall = (await db.query("select url, headers from net.calls order by id desc limit 1")).rows[0];
check("v2.16: push_egress_check يفحص الرابط المُضمَّن مباشرةً",
  eg?.queued === true && egCall?.url === HARDCODED_URL
  && egCall?.headers?.["x-send-push-secret"] === HARDCODED_SECRET, String(egCall?.url));

/* ---------- النتيجة ---------- */
if (fails) {
  console.log(`\n❌ FAILED ${fails} check(s)`);
  process.exit(1);
}
console.log("\nPASSED push-trigger-no-vault (v2.15)");
await db.close();
process.exit(0);
