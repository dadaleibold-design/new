/**
 * tests/push-relay-worker.mjs — سلوك بوابة التسليم البديلة (Cloudflare Worker)
 * =========================================================================
 * الهدف: التأكد أن worker/send-push-relay.js
 *   ① ترفض أي طلب بلا سرّ أو بسرّ خاطئ (401)
 *   ② تمرّر الطلب إلى دالة send-push مع ترويسة x-send-push-secret الصحيحة
 *   ③ لا تسرّب السرّ في الردّ
 *   ④ ترفض الطرق غير POST
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RELAY_PATH = path.join(ROOT, "worker/send-push-relay.js");
const SECRET = "my_send_push_19921121_almgawell_19921121";
const TARGET = "https://gqocavvhkfzgxzscrjms.supabase.co/functions/v1/send-push";

let fails = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "✅" : "❌"} ${name}${cond ? "" : " — " + detail}`);
  if (!cond) fails += 1;
};

const src = readFileSync(RELAY_PATH, "utf8");

// ── فحوص ثابتة على المصدر ──
check("الملف موجود ويصدّر معالجاً افتراضياً", /export default\s*\{/.test(src));
check("الهدف الافتراضي هو دالة send-push", src.includes(TARGET));
check("يتحقق من ترويسة x-send-push-secret", src.includes("x-send-push-secret"));
check("لا يمرّر Authorization من القاعدة (يبنيه من سرّه)", !/request\.headers\.get\("authorization"\)/i.test(src));
check("لا يطبع السرّ في أي سجل", !/console\.(log|info|warn|error)\([^)]*SEND_PUSH_SECRET/.test(src));

// ── فحص سلوكي: نستدعي المعالج ونحاكي fetch ──
const mod = await import(pathToFileURL(RELAY_PATH).href);
const worker = mod.default;

const env = { SEND_PUSH_SECRET: SECRET, SEND_PUSH_URL: TARGET };

let seen = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  seen = { url, opts };
  return new Response(JSON.stringify({ ok: true, sent: 1 }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

const mkReq = (headers = {}, method = "POST", body = '{"kind":"new_message"}') =>
  new Request("https://relay.example.workers.dev/", {
    method,
    headers,
    ...(method === "GET" || method === "HEAD" ? {} : { body }),
  });

try {
  // ① بلا سرّ ⇒ 401
  let r = await worker.fetch(mkReq({ "content-type": "application/json" }), env);
  check("بلا ترويسة سرّ ⇒ 401", r.status === 401, String(r.status));

  // ② سرّ خاطئ ⇒ 401 (ولا طلب صادر)
  seen = null;
  r = await worker.fetch(mkReq({ "content-type": "application/json", "x-send-push-secret": "wrong" }), env);
  check("سرّ خاطئ ⇒ 401", r.status === 401, String(r.status));
  check("سرّ خاطئ ⇒ لا طلب صادر للهدف", seen === null);

  // ③ سرّ صحيح ⇒ يمرّر إلى الهدف مع الترويسة
  seen = null;
  r = await worker.fetch(
    mkReq({ "content-type": "application/json", "x-send-push-secret": SECRET }),
    env,
  );
  check("سرّ صحيح ⇒ 200 من الهدف", r.status === 200, String(r.status));
  check("يوجّه الطلب إلى دالة send-push", seen?.url === TARGET, String(seen?.url));
  check("يمرّر الترويسة x-send-push-secret الصحيحة",
    seen?.opts?.headers?.["x-send-push-secret"] === SECRET, JSON.stringify(seen?.opts?.headers || {}));
  check("يمرّر جسم الرسالة كما هو", String(seen?.opts?.body || "").includes("new_message"));
  check("لا يسرّب السرّ في الردّ", !(await r.text()).includes(SECRET));

  // ④ طرق غير مدعومة
  r = await worker.fetch(mkReq({}, "GET"), env);
  check("GET ⇒ 405", r.status === 405, String(r.status));

  // ⑤ الهدف قابل للتهيئة (boothole بديل)
  seen = null;
  await worker.fetch(
    mkReq({ "content-type": "application/json", "x-send-push-secret": SECRET }),
    { ...env, SEND_PUSH_URL: "https://alt.example.workers.dev/" },
  );
  check("الهدف قابل للتهيئة عبر env", seen?.url === "https://alt.example.workers.dev/", String(seen?.url));

  // ⑥ سرّ غير مُعدّ ⇒ 500 (misconfiguration صريح)
  r = await worker.fetch(
    mkReq({ "content-type": "application/json", "x-send-push-secret": SECRET }),
    { SEND_PUSH_URL: TARGET },
  );
  check("بلا SEND_PUSH_SECRET ⇒ 500", r.status === 500, String(r.status));
} finally {
  globalThis.fetch = realFetch;
}

console.log(fails ? `\n❌ FAILED ${fails} check(s)` : "\n✅ PASSED push-relay-worker (بوابة التسليم البديلة)");
process.exit(fails ? 1 : 0);
