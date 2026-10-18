import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { routeFromUrl } from "../js/notification-router.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");
let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(ok ? "✅" : "❌", label, detail);
  if (!ok) failures += 1;
};

function setup(clients = []) {
  const listeners = new Map();
  const opened = [];
  const self = {
    location: { origin: "https://app.test" },
    registration: { scope: "https://app.test/" },
    clients: {
      matchAll: async () => clients,
      openWindow: async (url) => { opened.push(url); return null; },
    },
    addEventListener(type, fn) { listeners.set(type, fn); },
    skipWaiting() {},
  };
  const context = {
    self, clients: self.clients, URL, Promise, caches: { open: async () => ({ addAll: async () => {} }), keys: async () => [], match: async () => null },
    fetch: async () => ({ ok: true, clone() { return this; } }),
    Response, setTimeout, clearTimeout,
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: "sw.js" });
  return { listeners, opened };
}

const callClient = {
  url: "https://app.test/index.html",
  visibilityState: "visible",
  focus: async () => {},
  postMessage(message) { this.lastMessage = message; },
};
const callEnv = setup([callClient]);
const pending = [];
callEnv.listeners.get("notificationclick")({
  notification: { data: { type: "incoming_call", roomId: "room-42", conversationId: "conv-9" }, close() {} },
  waitUntil(promise) { pending.push(promise); },
});
await Promise.all(pending);
check("نقرة مكالمة: تركيز نافذة التطبيق وإرسال هدف الاتصال", callClient.lastMessage?.roomId === "room-42" && callClient.lastMessage?.action === "answer");
check("رابط المكالمة يتضمن room_id بدلاً من رابط دردشة فقط", callClient.lastMessage?.url.includes("room_id=room-42"));

const closedEnv = setup([]);
const callPending = [];
closedEnv.listeners.get("notificationclick")({
  notification: { data: { type: "call", room_id: "room-closed" }, close() {} },
  waitUntil(promise) { callPending.push(promise); },
});
await Promise.all(callPending);
check("مكالمة والتطبيق مغلق: فتح رابط شاشة المكالمة", closedEnv.opened[0]?.includes("room_id=room-closed"));

const messageClient = { ...callClient, lastMessage: null };
const messageEnv = setup([messageClient]);
const messagePending = [];
messageEnv.listeners.get("notificationclick")({
  notification: { data: { type: "message", conversationId: "conv-msg", messageId: "msg-1" }, close() {} },
  waitUntil(promise) { messagePending.push(promise); },
});
await Promise.all(messagePending);
check("نقرة رسالة: تبقى موجهة إلى المحادثة والرسالة", messageClient.lastMessage?.conversationId === "conv-msg" && messageClient.lastMessage?.messageId === "msg-1" && messageClient.lastMessage?.action === "open");
const parsedCallRoute = routeFromUrl("https://app.test/index.html?room_id=room-42");
check("الموجّه يستقبل room_id كرابط مكالمة واردة", parsedCallRoute?.roomId === "room-42" && parsedCallRoute?.type === "incoming_call" && parsedCallRoute?.action === "answer");

const calls = fs.readFileSync(path.join(ROOT, "js/calls.js"), "utf8");
const migration = fs.readFileSync(path.join(ROOT, "sql/migrations/2026-10-18_v2_12_call_state_cleanup.sql"), "utf8");
check("إنشاء مكالمة ينظف الرنين القديم عبر RPC قبل فحص الغرفة النشطة", calls.indexOf('rpc("expire_stale_ringing_calls_for_conversation"') < calls.indexOf('.from("call_rooms")', calls.indexOf('rpc("expire_stale_ringing_calls_for_conversation"')));
check("التنظيف يحدّث الرنين بعد دقيقتين والجلسة النشطة المهجورة بعد 24 ساعة", /conversation_id = p_conversation[\s\S]*status = 'ringing'[\s\S]*started_at < now\(\) - interval '2 minutes'[\s\S]*status = 'active'[\s\S]*answered_at < now\(\) - interval '24 hours'/.test(migration));
check("فشل إنشاء الغرفة يوقف النغمة ويعيد ضبط حالة واجهة المكالمة", /if \(!roomCreated\)[\s\S]{0,300}stopRingtone\(\)[\s\S]{0,350}setOverlayVisible\(false\)/.test(calls));

console.log(failures ? `\nFAILED ${failures}` : "\nPASSED app-shell-sw-routing");
process.exit(failures ? 1 : 0);
