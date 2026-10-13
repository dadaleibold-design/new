# تنظيف المفاتيح الثابتة والاعتماد على متغيرات البيئة

> التاريخ: 2026-10-13 — الفرع: `arena/ab93c2fa-new`
> النطاق: الواجهة الأمامية (Vite `import.meta.env`) + دوال Supabase Edge Functions (`Deno.env`) + ملف `.env.example`

---

## 1) ما كان موجوداً قبل التنظيف

| الملف | القيمة الثابتة (أُزيلت) |
|---|---|
| `js/config.js` | `SUPABASE_URL`، `SUPABASE_ANON_KEY`، `VAPID_PUBLIC_KEY`، `appId` الخاص بـ Agora، ورابط `agora-token` |
| `js/push.js` | كائن `firebaseConfig` كاملاً (apiKey/authDomain/projectId/storageBucket/messagingSenderId/appId/measurementId) + `VAPID_KEY` |
| `firebase-messaging-sw.js` | نسخة ثانية من كامل `firebaseConfig` (ازدواجية سبب سابق لخطأ «ServiceWorker script evaluation failed») |
| `js/config.js` + `js/auth.js` | قائمة 18 بريداً إلكترونياً للمشرفين + دالة `isAdminEmail` |
| `js/app.js` | استعلام `profiles.in("email", ADMINS…)` لبناء قائمة المشرفين، ومطابقة البريد للحكم بصلاحية المشرف |

كما أُزيلت من المستودع ملفات قديمة كانت تحمل نسخاً سابقة من الكود:
`main.zip` (أرشيف 200KB)، مجلد `--main/`، و `supabase/.temp/` (معرّف المشروع والمنظمة).

---

## 2) الواجهة الأمامية — `import.meta.env` حصراً

كل القراءات مرّت عبر وحدة واحدة جديدة: **`js/env.js`**

```
import.meta.env.VITE_*   (Vite: dev/build)
        ↓ إن غابت
self.__ENV__             (ملف env.js المولَّد — نشر استاتيكي بلا build)
        ↓
شاشة إعداد واضحة تسمّي المتغيرات الناقصة (بدل الانهيار)
```

الأسماء المعتمدة حصرياً (كما طُلبت):

| المتغير | الاستخدام |
|---|---|
| `VITE_SUPABASE_URL` | نقطة نهاية Supabase + اشتقاق رابط `agora-token` |
| `VITE_SUPABASE_ANON_KEY` | المفتاح العام لعميل Supabase وطلبات `functions/v1` |
| `VITE_FIREBASE_API_KEY` | تهيئة Firebase في الصفحة وفي الـ SW |
| `VITE_FIREBASE_PROJECT_ID` | أيضاً مصدر اشتقاق `authDomain` و `storageBucket` |
| `VITE_FIREBASE_MESSAGING_SENDER_ID` | تهيئة Firebase |
| `VITE_FIREBASE_APP_ID` | تهيئة Firebase |
| `VITE_VAPID_PUBLIC_KEY` | `getToken({ vapidKey })` في `js/push.js` |
| `VITE_AGORA_APP_ID` *(إضافي، غير سرّي)* | معرّف مشروع Agora — لم يكن ضمن قائمتك، ولا يمكن أن يبقى ثابتاً في الكود |

**لا وجود لأي مفتاح سيرفري في الواجهة:** لا `SUPABASE_SERVICE_ROLE_KEY` ولا `FIREBASE_PRIVATE_KEY`
ولا `FIREBASE_SERVICE_ACCOUNT` ولا `AGORA_APP_CERTIFICATE` ولا `SEND_PUSH_SECRET`.
اختبار `tests/env-config.mjs` يفشل تلقائياً إذا ظهر أي منها بقيمة، أو إذا قرأت الواجهة `Deno.env`.

### لماذا مسار `self.__ENV__` أيضاً؟
المشروع لا يستخدم build step (README الأصلي: «Vanilla JS بدون build step») و`import.meta.env`
لا يوجد في متصفح خام. لذلك:
* على Vite: تُقرأ `import.meta.env.VITE_*` مباشرة (الأسماء هي نفسها).
* على الاستضافة الاستاتيكية: `npm run env:generate` يكتب `env.js` (مُستثنى من Git) يضبط
  `self.__ENV__` بنفس الأسماء، ويُحمَّل في `index.html` **قبل** وحدات التطبيق، وفي الـ SW عبر
  `importScripts("./env.js")`.
* إن غاب `env.js` على الاستضافة: تظهر شاشة «إعداد البيئة غير مكتمل» تسرد المتغيرات الناقصة
  وخطوات الحل — لا شاشة بيضاء ولا خطأ غامض.

---

## 3) الدوال (Deno) — `Deno.env.get()` حصراً

| الدالة | الأسرار المقروءة |
|---|---|
| `supabase/functions/send-push` | `FIREBASE_SERVICE_ACCOUNT` **أو** (`FIREBASE_PROJECT_ID` + `FIREBASE_CLIENT_EMAIL` + `FIREBASE_PRIVATE_KEY`)، `SEND_PUSH_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` |
| `supabase/functions/agora-token` | `AGORA_APP_ID`, `AGORA_APP_CERTIFICATE`, `SUPABASE_URL`, `SUPABASE_ANON_KEY` |
| trigger قاعدة البيانات (Vault) | `SEND_PUSH_URL`, `SEND_PUSH_SECRET` |

الجديد:
1. **`FIREBASE_SERVICE_ACCOUNT`**: ملف حساب الخدمة كاملاً كسرّ واحد (JSON، ويدعم أيضاً Base64).
   يُفضَّل على الحقول الثلاثة المنفصلة، وكلاهما يعمل.
2. **معالجة السطر الجديد**: `normalizePrivateKey()` تُعيد `\n` المُهرَّبة إلى أسطر حقيقية
   (`value.replace(/\\n/g, "\n")`) قبل `importPKCS8` — سواء جاء المفتاح من
   `FIREBASE_PRIVATE_KEY` أو من داخل ملف حساب الخدمة.
3. **أخطاء واضحة**: رسالة صريحة تسمّي الصيغتين المقبولتين عند نقص الأسرار، و503 صريح في
   `agora-token` عند نقص `AGORA_APP_ID`/`AGORA_APP_CERTIFICATE`/`SUPABASE_*` بدل `!` التي
   تُسقط الدالة بخطأ غامض.

---

## 4) `.env.example` — المرجع القياسي (بلا أي قيمة)

يضم الأسماء المطلوبة فقط: سبعة متغيرات `VITE_*`، وثمانية أسرار للدوال
(`FIREBASE_SERVICE_ACCOUNT`, `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`,
`FIREBASE_PRIVATE_KEY`, `SEND_PUSH_SECRET`, `SEND_PUSH_URL`, `AGORA_APP_ID`,
`AGORA_APP_CERTIFICATE`) + `VITE_AGORA_APP_ID` في قسم إضافي معلَّم.

كل الأسطر **بلا قيم** (`KEY=`)، والاختبار يتحقق من ذلك ومن أن أي اسم آخر غير معتمد.

---

## 5) قائمة المشرفين: من الكود إلى قاعدة البيانات

أُزيلت القائمة الثابتة من الواجهة نهائياً، والمصدر الوحيد الآن هو علامات قاعدة البيانات:

* `js/app.js`: قائمة المشرفين المعروضة للمستخدم = `profiles` بشرط
  `is_admin.eq.true,is_super_admin.eq.true` (بدل `.in("email", ADMINS…)`).
* `js/app.js`: `isAdminContact()` و`enterApp()` يحكمان من `is_admin`/`is_super_admin` فقط.
* `js/auth.js`: أُزيل شرط «البريد ضمن القائمة» من التسجيل والدخول؛
  الحساب الذي يسجّل بالبريد لا يُقبل للدخول بالبريد إلا إن كان `is_admin` في قاعدة البيانات
  (منح العلامة يتم في `public.is_admin_email()` / `handle_new_user()`).
* `js/config.js`: حُذفت `ADMINS` و`isAdminEmail` بالكامل.

---

## 6) حراسة دائمة: `tests/env-config.mjs`

اختبار جديد (ضمن `npm test`) يفشل فوراً عند أي تراجع:

1. لا وجود لأي من القيم المسرّبة المعروفة (مفاتيح Supabase/Firebase/Agora/VAPID/قائمة البُرد)
   في أي ملف مصدري.
2. لا قيمة تشبه مفتاحاً (`eyJ…`, `AIza…`, PEM, رابط `.supabase.co`) في كود الواجهة.
3. `js/env.js` يقرأ `import.meta.env` بالأسماء السبعة + يدعم `self.__ENV__`.
4. لا يُستخدم أي مفتاح سيرفري في الواجهة (إسناد قيمة، `Deno.env.get`، `VITE_` سيرفري، localStorage).
5. الـ SW يقرأ `env.js` ولا يهيّئ Firebase بلا إعدادات.
6. `index.html` يحمّل `env.js` قبل `app.js`، وفيه شاشة الإعداد.
7. الدوال تقرأ الأسماء المطلوبة من `Deno.env`، وتحويل `\n` صحيح **سلوكياً** (يُنفَّذ التعبير
   المستخرج من الكود على مفتاح مهرَّب ويتحقق من الناتج).
8. `.env.example` يحوي الأسماء المطلوبة بلا قيم.
9. سلوك طبقة البيئة: قراءة وقت التشغيل، رصد النواقص، رفض العميل عند نقص الإعداد، واشتقاق
   `authDomain`/`tokenEndpoint`.

---

## 7) فحص الأنواع (TypeScript Type Checks)

```bash
npm run typecheck
# = tsc -p tsconfig.frontend.json && tsc -p tsconfig.functions.json
```

* `tsconfig.functions.json`: يفحص `send-push` و `agora-token` مع `strict: true`،
  و`supabase/functions/types/deno-shim.d.ts` يوفّر تعريفات `Deno.env.get` / `Deno.serve`
  وتوقيعات `jose` و`agora-access-token` (تعريفات للفحص فقط — Deno على Supabase يوفّرها أصلاً).
* `tsconfig.frontend.json`: يفحص طبقة الإعداد (`js/env.js`, `js/config.js`, `js/supabaseClient.js`)
  بـ `checkJs` مع `strict`؛ وي كشف أي خطأ في أسماء `VITE_*` (لأن `ImportMetaEnv` معرَّف بالأسماء
  المعتمدة فقط في `types/frontend-globals.d.ts`).
* النتيجة الحالية: **صفر أخطاء** في الفحصين.

---

## 8) خطوات ما بعد هذا التغيير (مهمّة للنشر)

1. أنشئ `.env` من `.env.example` واملأ القيم العامة (anon key / web apiKey / VAPID).
2. `npm run env:generate` (محلي)، وعلى Vercel: أضف المتغيرات في
   Project Settings → Environment Variables — `vercel.json` يشغّل نفس السكربت وقت البناء.
3. على Supabase: `supabase secrets set FIREBASE_SERVICE_ACCOUNT="$(cat service-account.json)"`
   و `SEND_PUSH_SECRET=...` (وقيم Agora)، ثم:
   `supabase functions deploy send-push` و `supabase functions deploy agora-token --no-verify-jwt`.
4. لتفعيل مفتاح VAPID الجديد: بدّل قيمته في متغيرات البيئة فقط — لا تعديل كود بعد اليوم.
