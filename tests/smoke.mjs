// اختبار دخاني بـ jsdom: يشغّل app.js مع Supabase وهمي ويتحقق من السلوكيات
import { register } from "node:module";
register("./hooks.mjs", import.meta.url);
import { JSDOM } from "jsdom";
import fs from "fs";
import path from "path";
const ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const ROLE = process.argv[2] || "user"; // user | admin | super
const html = fs.readFileSync(path.join(ROOT,"index.html"),"utf8");
const dom = new JSDOM(html, { url: "http://localhost/index.html", pretendToBeVisual: true });
const { window } = dom;
for (const k of ["window","document","navigator","localStorage","sessionStorage","HTMLElement","Event","CustomEvent","DocumentFragment","Node","location","history"]) { if (!(k in globalThis)) { try { globalThis[k] = window[k]; } catch {} } }
globalThis.matchMedia = () => ({ matches:false }); window.matchMedia = globalThis.matchMedia;

const ME = { id:"me", display_name: ROLE==="user"?"User":"Admin", is_admin: ROLE!=="user", is_super_admin: ROLE==="super", email: ROLE==="user"?null:"almgawell1@gmail.com" };
const ADMINS = [
  { id:"a1", display_name:"Admin One", email:"almgawell1@gmail.com", is_admin:true },
  { id:"a2", display_name:"Admin Two", email:"almgawell2@gmail.com", is_admin:true },
  { id:"a3", display_name:"Admin Three", email:"almgawell3@gmail.com", is_admin:true },
];
const CONVS_USER = [
  { id:"c1", user_id:"me", admin_id:"a1", last_message:"old", last_message_at:"2026-09-19T10:00:00Z" },
  { id:"c3", user_id:"me", admin_id:"a3", last_message:"newest", last_message_at:"2026-09-21T10:00:00Z" },
];
const UNREAD = [ {conversation_id:"c1"},{conversation_id:"c1"},{conversation_id:"c3"} ];
const USERS_CONVS = [
  { id:"u1", user_id:"user1", admin_id:"me", last_message:"hi", last_message_at:"2026-09-20T10:00:00Z", user:{id:"user1",display_name:"Zed"} },
  { id:"u2", user_id:"user2", admin_id:"me", last_message:"yo", last_message_at:"2026-09-21T09:00:00Z", user:{id:"user2",display_name:"Amy"} },
];
const calls = [];
let realtimeHandlers = [];
const mkq = (table) => {
  const st = { table, filters: [] }; const q = {};
  ["select","eq","neq","in","or","gt","gte","lt","order","limit","insert","update","upsert","delete"].forEach(m => q[m] = (...a)=>{ calls.push(table+"."+m); st.filters.push([m,...a]); return q; });
  const resolve = () => {
    if (table==="profiles") {
      if (st.filters.some(f=>f[0]==="in")) return ADMINS;
      if (st.filters.some(f=>f[0]==="eq" && f[1]==="is_admin")) return ADMINS;
      return [];
    }
    if (table==="conversations") {
      if (ROLE==="user") return CONVS_USER;
      if (st.filters.some(f=>f[0]==="or")) return [{ id:"ac2", user_id:"me", admin_id:"a2", last_message:"admin chat", last_message_at:"2026-09-21T11:00:00Z" }];
      return USERS_CONVS;
    }
    if (table==="messages") {
      const inF = st.filters.find(f=>f[0]==="in");
      if (st.filters.some(f=>f[0]==="neq" && f[1]==="status")) return UNREAD.filter(u => !inF || inF[2].includes(u.conversation_id)).concat(ROLE!=="user"? [{conversation_id:"u1"},{conversation_id:"ac2"}] : []);
      return [];
    }
    return [];
  };
  q.maybeSingle = async()=>({data: table==="conversations" ? {id:"c1",user_id:"me",admin_id:"a1"} : null, error:null});
  q.single = async()=>({data: table==="profiles" ? ME : table==="conversations" ? {id:"c1",user_id:"me",admin_id:"a1"} : null, error:null});
  q.then = (res)=>res({data: resolve(), error:null});
  return q;
};
let session = { user:{id:"me"} };
window.supabase = { createClient: () => ({
  auth:{ getSession: async()=>({data:{session}}), onAuthStateChange(){}, signOut: async()=>{}, signInWithPassword: async()=>({data:{user:{id:"me"},session},error:null}) },
  from: mkq,
  channel: (name)=>({ _h:[], on(type, opts, cb){ this._h.push({name,opts,cb}); return this; }, subscribe(cb){ realtimeHandlers.push(...this._h); cb&&setTimeout(()=>cb("SUBSCRIBED"),5); return this; }, send: async()=>"ok", track: async()=>"ok", untrack: async()=>"ok", presenceState:()=>({}) }),
  removeChannel(){}, realtime:{ connect(){}, disconnect(){}, connectionState:()=>"connected" }, rpc: async()=>({error:null}) }) };
globalThis.fetch = async () => ({ ok:true, status:200, text: async()=> fs.readFileSync(path.join(ROOT,"partials/chat-panel.html"),"utf8"), json: async()=>({token:"t"}) });
window.HTMLMediaElement.prototype.play = async()=>{}; window.HTMLMediaElement.prototype.pause = ()=>{};
globalThis.Notification = { permission: "granted" }; window.Notification = globalThis.Notification;
Object.defineProperty(globalThis.navigator, "onLine", { value: true, configurable: true });
Object.defineProperty(globalThis.navigator, "serviceWorker", { value: undefined, configurable: true });
const errors = [];
window.addEventListener("error", e => errors.push(e.message));
process.on("unhandledRejection", e => errors.push("unhandled: " + (e?.message||e)));
const wait = (ms)=>new Promise(r=>setTimeout(r,ms));
let fails = 0;
const check = (name, cond, extra="") => { console.log((cond?"✅":"❌"), name, extra); if(!cond) fails++; };

await import(path.join(ROOT,"js/app.js"));
await wait(1500);
check("app shell visible", !document.getElementById("app-shell").classList.contains("hidden"));

if (ROLE === "user") {
  const rows = [...document.querySelectorAll("#contact-list .contact-row")];
  const names = rows.map(r=>r.querySelector(".contact-name").textContent.trim());
  check("user sees 3 admins", rows.length===3, names.join(","));
  check("sorted by latest interaction (a3 first, a1 second, a2 last)", names[0]==="Admin Three" && names[1]==="Admin One" && names[2]==="Admin Two");
  const badges = rows.map(r=>r.querySelector(".unread-badge")?.textContent||"0");
  check("unread badges shown for user (2 for a1, 1 for a3)", badges[0]==="1" && badges[1]==="2" && badges[2]==="0", badges.join(","));
  // realtime: new message in c1 (Admin One) → badge 3 and moves to top
  const msgH = realtimeHandlers.find(h=>h.opts?.table==="messages" && h.opts?.event==="INSERT" && !h.opts.filter);
  check("global message watch subscribed for user", !!msgH);
  msgH?.cb({ new:{ id:"mX", conversation_id:"c1", sender_id:"a1", content:"ping", message_type:"text", created_at:new Date().toISOString() } });
  await wait(50);
  const rows2 = [...document.querySelectorAll("#contact-list .contact-row")];
  check("after realtime msg: Admin One moves to top with badge 3", rows2[0].querySelector(".contact-name").textContent.trim()==="Admin One" && rows2[0].querySelector(".unread-badge")?.textContent==="3", rows2[0].querySelector(".contact-sub")?.textContent.trim());
  // open conversation → badge cleared
  rows2[0].click(); await wait(800);
  check("badge cleared after opening conversation", !document.querySelector('[data-conversation-id="c1"] .unread-badge'));
} else {
  const adminRows = [...document.querySelectorAll("#admins-section .contact-row")];
  const names = adminRows.map(r=>r.querySelector(".contact-name").textContent.trim());
  check("admins listed", adminRows.length===3, names.join(","));
  check("admins sorted by latest interaction (Admin Two first)", names[0]==="Admin Two");
  check("admin unread badge for Admin Two", adminRows[0].querySelector(".unread-badge")?.textContent==="1");
  const userNames = [...document.querySelectorAll("#users-section .contact-row .contact-name")].map(e=>e.textContent.trim());
  check("users sorted by latest (Amy first)", userNames[0]==="Amy", userNames.join(","));
  const section = document.getElementById("admins-section");
  const toggle = document.getElementById("admins-toggle");
  check("admins toggle exists", !!toggle);
  check(ROLE==="super" ? "super admin: admins collapsed by default" : "admin: admins expanded by default", section.classList.contains("collapsed") === (ROLE==="super"));
  toggle.click();
  check("toggle flips state", section.classList.contains("collapsed") !== (ROLE==="super"));
  check("toggle persisted", localStorage.getItem("wa_admins_collapsed") === (ROLE==="super" ? "0" : "1"));
  check("section header shows unread total", !!toggle.querySelector(".section-unread"));
  // open user chat and test message actions visibility
  document.querySelector("#users-section .contact-row").click(); await wait(800);
}

// ----- message actions hidden until tap -----
const box = document.getElementById("chat-messages");
const msgs = [
 {id:"m1",conversation_id:"c1",sender_id:"a1",content:"hello",message_type:"text",created_at:"2026-09-21T09:00:00Z",status:"read"},
 {id:"m2",conversation_id:"c1",sender_id:"me",content:"hi",message_type:"text",created_at:"2026-09-21T09:01:00Z",status:"read"},
];
const convH = realtimeHandlers.filter(h=>h.opts?.table==="messages" && h.opts?.event==="INSERT" && h.opts.filter);
check("conversation channel subscribed", convH.length>0);
msgs.forEach(m => convH.at(-1).cb({ new:m }));
await wait(100);
const rowsB = [...box.querySelectorAll(".bubble-row:not(.call-row)")];
check("2 bubbles rendered", rowsB.length===2);
check("no bubble selected initially", !box.querySelector(".bubble-row.selected"));
const css = fs.readFileSync(path.join(ROOT,"css/style.css"),"utf8");
check("CSS hides actions unless .selected", /\.bubble-row\.selected \.bubble-actions\{display:flex/.test(css) && /\.bubble-row:hover \.bubble-actions,\.bubble-row:has\(\.bubble-action-delete\) \.bubble-actions\{display:none\}/.test(css));
rowsB[0].querySelector(".bubble").click();
check("tap selects bubble (actions visible)", rowsB[0].classList.contains("selected"));
rowsB[1].querySelector(".bubble").click();
check("tapping another bubble moves selection", !rowsB[0].classList.contains("selected") && rowsB[1].classList.contains("selected"));
rowsB[1].querySelector(".bubble").click();
check("tapping same bubble again deselects", !rowsB[1].classList.contains("selected"));
rowsB[0].querySelector(".bubble").click();
box.click();
check("click outside deselects", !box.querySelector(".bubble-row.selected"));
check("delete button only for admins", (box.querySelectorAll(".bubble-action-delete").length>0) === (ROLE!=="user"));
check("no runtime errors", errors.length===0, errors.join(" | "));
console.log(fails ? `\n${fails} FAILED (${ROLE})` : `\nALL PASSED (${ROLE})`);
process.exit(fails?1:0);
