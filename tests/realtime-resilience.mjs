/*
 * اختبار متانة قنوات Realtime (بدون شبكة)
 * -------------------------------------------------------------
 * يحاكي سلوك Supabase الحقيقي المسبِّب للحلقة:
 *   • removeChannel(ch) تُطلق CLOSED على القناة المُزالة (مُتزامنة تقريباً).
 *   • الاشتراك بجدول غير منشور يُرجع CHANNEL_ERROR بشكل دائم.
 *
 * يتحقق من:
 *   1) إعادة البناء لا تُولّد حلقة CLOSED ⇒ ينتهي بعدد استدعاءات محدود.
 *   2) Singleton: لا تتكرّر القنوات بنفس الـ topic.
 *   3) ensureHealthy لا يُعيد بناء قناة سليمة.
 *   4) خطأ دائم يتوقف بعد maxRetries ولا يعود تلقائياً.
 *
 * التشغيل: node tests/realtime-resilience.mjs
 */
import {
  createResilientChannel,
  diagnoseRealtime,
  getManagedChannel,
  isChannelAlive,
  isRealtimeConnected,
  startRealtimeWatchdog,
} from "../js/realtime.js";

let fails = 0;
const check = (name, ok, extra = "") => {
  console.log(ok ? "✅" : "❌", name, extra);
  if (!ok) fails += 1;
};
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** خادم وهمي: يتتبّع القنوات وأحداثها */
function createFakeSupabase({ failingTopics = new Set() } = {}) {
  const live = new Set();
  const stats = { created: 0, removed: 0, subscribes: 0 };
  let connected = true;

  const client = {
    stats,
    realtime: {
      connectionState: () => (connected ? "connected" : "disconnected"),
      connect: () => {
        connected = true;
      },
    },
    getChannels: () => [...live],
    channel(topic) {
      stats.created += 1;
      const ch = {
        topic,
        state: "closed",
        handlers: [],
        statusCb: null,
        on(type, filter, cb) {
          this.handlers.push({ type, filter, cb });
          return this;
        },
        subscribe(cb) {
          stats.subscribes += 1;
          this.statusCb = cb;
          this.state = "joining";
          live.add(this);
          queueMicrotask(() => {
            if (this.removed) return;
            if (failingTopics.has(topic)) {
              this.state = "errored";
              cb("CHANNEL_ERROR", new Error("publication missing"));
            } else {
              this.state = "joined";
              cb("SUBSCRIBED");
            }
          });
          return this;
        },
      };
      return ch;
    },
    removeChannel(ch) {
      stats.removed += 1;
      ch.removed = true;
      live.delete(ch);
      ch.state = "leaving";
      // سلوك Supabase: إزالة القناة تُطلق CLOSED عليها
      queueMicrotask(() => {
        ch.state = "closed";
        ch.statusCb?.("CLOSED");
      });
      return Promise.resolve("ok");
    },
    _setConnected(v) {
      connected = v;
    },
  };
  return client;
}

/* 0) عقد Supabase الحقيقي: connectionState() يعيد "open" لا "connected" ---- */
{
  const sb = createFakeSupabase();
  sb.realtime.connectionState = () => "open";
  const handle = createResilientChannel(sb, { topic: "t-open-state" });
  await handle.ready;
  await tick(10);

  const report = diagnoseRealtime(sb);
  check("connectionState='open' يُفسَّر كاتصال حيّ", isRealtimeConnected(sb));
  check("قناة joined على socket open تُعدّ حيّة", isChannelAlive(sb, handle.channel));
  check("تقرير الصحة لا يطلق healthy=false على open + joined", report.healthy, JSON.stringify(report));

  let revives = 0;
  let lost = 0;
  const watchdog = startRealtimeWatchdog({
    supabase: sb,
    visibleIntervalMs: 60_000,
    hiddenIntervalMs: 60_000,
    onRevive: () => { revives += 1; },
    onConnectionLost: () => { lost += 1; },
  });
  await Promise.all([watchdog.ping(), watchdog.ping()]);
  check("Watchdog لا يعيد الإحياء ولا يبلغ عن فقد الاتصال عند open + joined", revives === 0 && lost === 0);
  watchdog.stop();
  handle.stop();
}

/* 1) إعادة البناء المتكررة لا تُولّد حلقة ------------------------------ */
{
  const sb = createFakeSupabase();
  const handle = createResilientChannel(sb, { topic: "t-loop", label: "loop", minDelayMs: 5, maxDelayMs: 20 });
  await handle.ready;
  await tick(10);
  for (let i = 0; i < 5; i += 1) {
    await handle.rebuild({ force: true });
    await tick(10);
  }
  await tick(100);
  const { created, removed, subscribes } = sb.stats;
  check(
    "إعادة البناء 5 مرات لا تُولّد حلقة CLOSED (عدد محدود)",
    subscribes <= 8 && created <= 8 && removed <= created,
    `created=${created} removed=${removed} subscribes=${subscribes}`
  );
  check("القناة النهائية منضمّة", handle.channel?.state === "joined", `state=${handle.channel?.state}`);
  handle.stop();
}

/* 2) Singleton: لا تكرار للـ topic --------------------------------------- */
{
  const sb = createFakeSupabase();
  const a = createResilientChannel(sb, { topic: "t-single" });
  await a.ready;
  const b = createResilientChannel(sb, { topic: "t-single" });
  await b.ready;
  const liveSame = sb.getChannels().filter((c) => c.topic === "t-single" && c.state !== "closed");
  check("topic واحد ⇒ قناة حيّة واحدة", liveSame.length === 1, `live=${liveSame.length}`);
  check("السجل يشير للنسخة الأحدث", getManagedChannel("t-single") === b);
  check("النسخة القديمة أُوقفت", a.stopped === true);
  b.stop();
}

/* 3) ensureHealthy لا يلمس قناة سليمة ------------------------------------ */
{
  const sb = createFakeSupabase();
  const h = createResilientChannel(sb, { topic: "t-healthy" });
  await h.ready;
  const before = sb.stats.subscribes;
  await h.ensureHealthy();
  await h.ensureHealthy();
  check("ensureHealthy على قناة سليمة لا يعيد الاشتراك", sb.stats.subscribes === before);
  h.stop();
}

/* 4) خطأ دائم: يتوقف بعد maxRetries ولا حلقة لا نهائية ------------------- */
{
  const sb = createFakeSupabase({ failingTopics: new Set(["t-broken"]) });
  const h = createResilientChannel(sb, {
    topic: "t-broken",
    label: "broken",
    maxRetries: 3,
    minDelayMs: 2,
    maxDelayMs: 5,
  });
  await h.ready;
  // التأخير يحوي jitter عشوائياً (حتى 350ms) ⇒ ننتظر حتى تُعلَّم القناة failed
  const deadline = Date.now() + 5000;
  while (!h.failed && Date.now() < deadline) await tick(25);
  await tick(600);
  const afterWait = sb.stats.subscribes;
  await tick(900);
  check(
    "خطأ دائم: توقّف المحاولات التلقائية (لا نمو بعد الحد)",
    sb.stats.subscribes === afterWait && h.failed === true,
    `subscribes=${afterWait} failed=${h.failed}`
  );
  check("الاشتراكات محدودة بـ maxRetries+1", afterWait <= 3 + 1, `subscribes=${afterWait}`);
  h.stop();
}

console.log(fails ? `\n❌ REALTIME TESTS FAILED: ${fails}` : "\nREALTIME TESTS PASSED");
process.exit(fails ? 1 : 0);
