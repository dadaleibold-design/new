/*
 * اختبار وسائط المكالمات (v2.10) — منطق نقي + فحص مصادر calls.js
 * -------------------------------------------------------------
 *   (أ) js/call-media.js — وحدات نقية (بلا DOM ولا Agora):
 *       • تبديل الكاميرا: الأمامية ⇄ الخلفية، والتطبيع، والمرآة للأمامية فقط
 *       • كاميرا بديلة (احتياط) تتخطى الجهاز الحالي ولا ترجع null إلا بلا بديل
 *       • تصنيف مخرج الصوت بالاسم، ولا يُختار جهاز غير مُصنَّف أبداً
 *       • دعم تغيير المخرج يعتمد على setSinkId فقط (لا وعد زائف)
 *       • مجموعة منع التكرار تنتهي صلاحيتها (ساعة مزيفة)
 *   (ب) فحص calls.js (الواجهة الحقيقية):
 *       • قيد v2.9 المحفوظ: shouldRingForInvite({ payload, room, roomChecked: ok, meId: me.id })
 *       • safeQuery("calls:verify-invite" كما هو
 *       • منع تكرار الرنين يُسجَّل قبل أي await في handleIncomingInvite
 *       • زر تبديل الكاميرا داخل شريط التحكم السفلي (لا في الهيدر) وللفيديو فقط
 *       • لا زر تبديل قديم (call-btn-switch) ولا خفض صوت زائف (setVolume(35))
 *       • الكاميرا: setDevice({ facingMode }) مع احتياط بالمعرّف + busy flag
 *       • المخرج: setPlaybackDevice بعد اختيار الجهاز بالاسم، والاحتياط يُبلغ المستخدم
 *
 * التشغيل: node tests/calls-media.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

let fails = 0;
const check = (name, ok, extra = "") => {
  console.log(ok ? "✅" : "❌", name, extra);
  if (!ok) fails += 1;
};

const media = await import(pathToFileURL(path.join(ROOT, "js/call-media.js")).href);
const {
  FACING_USER,
  FACING_ENVIRONMENT,
  AUDIO_ROUTE_SPEAKER,
  AUDIO_ROUTE_EARPIECE,
  normalizeFacing,
  nextFacingMode,
  facingFromSettings,
  shouldMirrorLocalPreview,
  pickAlternateCamera,
  classifyOutputLabel,
  pickOutputDevice,
  supportsAudioRouting,
  createExpiringSet,
  isCallPushType,
} = media;

/* ---------- (أ) كاميرا ---------- */
check("الأمامية = user، الخلفية = environment", FACING_USER === "user" && FACING_ENVIRONMENT === "environment");
check("التطبيع: القيم غير المعروفة ⇒ أمامية", normalizeFacing(undefined) === "user" && normalizeFacing("left") === "user");
check("التطبيع: environment يبقى كما هو", normalizeFacing("environment") === "environment");
check("التبديل: أمامية ⇒ خلفية", nextFacingMode("user") === "environment");
check("التبديل: خلفية ⇒ أمامية", nextFacingMode("environment") === "user");
check("التبديل مرتين يعيد الأصل", nextFacingMode(nextFacingMode("user")) === "user");
check("التبديل من قيمة غير صالحة ⇒ خلفية (تبدأ من الأمامية الافتراضية)", nextFacingMode("bogus") === "environment");
check("قراءة الاتجاه من getSettings", facingFromSettings({ facingMode: "environment" }) === "environment");
check("قراءة الاتجاه: غير معلَن ⇒ null (الحاسوب)", facingFromSettings({}) === null && facingFromSettings(null) === null);
check("المرآة للأمامية فقط", shouldMirrorLocalPreview("user") === true && shouldMirrorLocalPreview("environment") === false);

const cams = [{ deviceId: "a" }, { deviceId: "b" }, { deviceId: "c" }];
check("كاميرا بديلة: تتخطى الحالية", pickAlternateCamera(cams, "a")?.deviceId === "b");
check("كاميرا بديلة: تلتف عند آخر جهاز", pickAlternateCamera(cams, "c")?.deviceId === "a");
check("كاميرا بديلة: جهاز واحد ⇒ null", pickAlternateCamera([{ deviceId: "a" }], "a") === null);
check("كاميرا بديلة: قائمة فارغة ⇒ null", pickAlternateCamera([], "a") === null);
check("كاميرا بديلة: تتجاهل المدخلات الفارغة", pickAlternateCamera([null, { deviceId: "x" }, { deviceId: "y" }], "x")?.deviceId === "y");

/* ---------- (أ) مخرج الصوت ---------- */
check("تصنيف: Speakerphone ⇒ speaker", classifyOutputLabel("Speakerphone") === "speaker");
check("تصنيف: Earpiece ⇒ earpiece", classifyOutputLabel("Earpiece") === "earpiece");
check("تصنيف: سماعة الأذن بالعربية ⇒ earpiece", classifyOutputLabel("سماعة الأذن") === "earpiece");
check("تصنيف: بلوتوث أولاً (لا يُعد مكبّراً داخلياً)", classifyOutputLabel("Bluetooth Speaker") === "bluetooth");
check("تصنيف: اسم مجهول ⇒ other", classifyOutputLabel("Default") === "other" && classifyOutputLabel("") === "other");

const outs = [
  { deviceId: "d1", kind: "audiooutput", label: "Default" },
  { deviceId: "bt", kind: "audiooutput", label: "Bluetooth Headset" },
  { deviceId: "sp", kind: "audiooutput", label: "Speakerphone" },
  { deviceId: "ear", kind: "audiooutput", label: "Earpiece" },
];
check("اختيار السماعة بالاسم", pickOutputDevice(outs, AUDIO_ROUTE_SPEAKER) === "sp");
check("اختيار سماعة الأذن بالاسم", pickOutputDevice(outs, AUDIO_ROUTE_EARPIECE) === "ear");
check(
  "لا يُختار جهاز غير مُصنَّف (Default) ⇒ null بدل تخمين",
  pickOutputDevice([{ deviceId: "d1", kind: "audiooutput", label: "Default" }], AUDIO_ROUTE_EARPIECE) === null
);
check(
  "لا يُختار جهاز إدخال (audioinput) كمخرج",
  pickOutputDevice([{ deviceId: "mic", kind: "audioinput", label: "Earpiece mic" }], AUDIO_ROUTE_EARPIECE) === null
);
check("قائمة غير صالحة ⇒ null بلا رمي", pickOutputDevice(null, AUDIO_ROUTE_SPEAKER) === null);

check("دعم تغيير المخرج = وجود setSinkId فقط", supportsAudioRouting({ hasSetSinkId: true }) === true);
check("بلا setSinkId ⇒ غير مدعوم (لا وعد زائف)", supportsAudioRouting({ hasSetSinkId: false }) === false);
check("الافتراضي بلا معطيات ⇒ غير مدعوم", supportsAudioRouting() === false);

/* ---------- (أ) منع تكرار الرنين ---------- */
let clock = 1_000;
const seen = createExpiringSet({ ttlMs: 120_000, now: () => clock });
check("مجموعة فارغة لا تحتوي شيئاً", seen.has("room-1") === false);
seen.add("room-1");
check("بعد الإضافة: موجودة", seen.has("room-1") === true);
clock += 119_000;
check("قبل انتهاء المهلة: ما زالت موجودة", seen.has("room-1") === true);
clock += 2_000;
check("بعد انتهاء 120 ثانية: تُحذف", seen.has("room-1") === false);
seen.add("room-2");
seen.delete("room-2");
check("delete يزيل المفتاح", seen.has("room-2") === false);

check("أنواع Push للمكالمات: incoming_call و call_ended فقط", isCallPushType("incoming_call") && isCallPushType("call_ended") && !isCallPushType("message") && !isCallPushType(undefined));

/* ---------- (ب) فحص calls.js ---------- */
const calls = read("js/calls.js");

check(
  "قيد v2.9 محفوظ حرفياً",
  calls.includes("shouldRingForInvite({ payload, room, roomChecked: ok, meId: me.id })")
);
check("الاستعلام يحمل الاسم safeQuery(\"calls:verify-invite\"", calls.includes('safeQuery("calls:verify-invite"'));

const fnStart = calls.indexOf("async function handleIncomingInvite(");
const fnEnd = calls.indexOf("\n}\n", fnStart);
const handleBody = calls.slice(fnStart, fnEnd);
const addIdx = handleBody.indexOf("handledRooms.add(payload.roomId)");
const firstAwait = handleBody.indexOf("await ");
check("منع التكرار: التسجيل قبل أول await (يغلق سباق Realtime/Push)", addIdx !== -1 && addIdx < firstAwait, `add=${addIdx} await=${firstAwait}`);
check("الدعوة المكررة لا ترسل busy لأن الغرفة مسجّلة", handleBody.indexOf("handledRooms.has(payload.roomId)") < addIdx);

check("TTL منع التكرار = 120 ثانية", /createExpiringSet\(\{ ttlMs: 120000 \}\)/.test(calls));
check("الرنين لا يقارن الطوابع الزمنية في الواجهة", !/sentAt|startedAt\s*[<>]/.test(calls));

// ترتيب الأزرار داخل .call-controls وليس في الهيدر
const controlsSrc = calls;
const flipAt = controlsSrc.indexOf('id="call-btn-flip"');
const ctrlsAt = controlsSrc.indexOf('class="call-controls"');
const headerEnd = controlsSrc.indexOf("</header>");
check("زر التبديل موجود في شريط التحكم السفلي", flipAt > ctrlsAt && ctrlsAt !== -1, `flip=${flipAt} controls=${ctrlsAt}`);
check("زر التبديل ليس في الهيدر العلوي", !(flipAt < headerEnd && flipAt > controlsSrc.indexOf("<header")));
check("لا يوجد زر تبديل قديم في الواجهة", !calls.includes("call-btn-switch") && !calls.includes("call-top-btn\" title=\"تبديل"));
check("يُظهر زر التبديل للفيديو فقط", /call-btn-flip"\)\?\.classList\.toggle\("hidden", !isVideo\)/.test(calls));
check("لا خفض صوت زائف (setVolume(35))", !/setVolume\(35\)/.test(calls));
check("لا متغير speakerOn القديم", !/speakerOn/.test(calls));

const swStart = calls.indexOf("async function switchCamera(");
const swBody = calls.slice(swStart, calls.indexOf("\n}\n", swStart));
check("التبديل: setDevice({ facingMode }) هو المسار الأساسي", /setDevice\(\{ facingMode: target \}\)/.test(swBody));
check("التبديل: احتياط بالمعرّف عند الفشل", /pickAlternateCamera\(cameras, currentDeviceId\)/.test(swBody));
check("التبديل: قفل ضد التكرار (switchingCamera)", /switchingCamera/.test(swBody) && /finally/.test(swBody));
check("التبديل لا يُنهي المكالمة ولا يعيد التحميل", !/endCall|location\.reload/.test(swBody));
check("المعاينة تُعاد بعد التبديل بالمرآة الصحيحة", /renderLocalPreview\(track\)/.test(swBody));

const routeStart = calls.indexOf("async function applyAudioRoute(");
const routeBody = calls.slice(routeStart, calls.indexOf("\n}\n", routeStart));
check("المخرج: setPlaybackDevice بعد اختيار الجهاز بالاسم", /track\.setPlaybackDevice\(deviceId\)/.test(routeBody) && /pickOutputDevice\(devices, route\)/.test(routeBody));
check("المخرج: لا تخفيض للصوت كبديل", !/setVolume/.test(routeBody));
check("المخرج: يُطبَّق على الطرف البعيد الجديد إن اختاره المستخدم صراحةً", /audioRouteTouched/.test(calls) && /applyAudioRoute\(callState\.audioRoute\)/.test(calls));
check("المخرج: رسالة صادقة عند عدم الدعم", /ROUTE_MESSAGES/.test(calls) && /unsupported/.test(calls));

// تلميح جلسة الصوت (best-effort) ضمن try/catch
check("تلميح navigator.audioSession آمن (try/catch)", /navigator\.audioSession\.type/.test(calls) && /catch \{/.test(calls));

check("calls.js يستورد call-media من الوحدة النقية", /from "\.\/call-media\.js"/.test(calls));

check("واجهة المكالمة تحوي زر المخرج بالمعرّف نفسه", /id="call-btn-speaker"/.test(calls));

console.log(fails ? `\nFAILED ${fails}` : "\nPASSED calls-media");
process.exit(fails ? 1 : 0);
