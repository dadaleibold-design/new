# تطبيق المحادثات (WhatsApp-style PWA) — دليل الإعداد

## 1. إعداد Supabase
1. أنشئ مشروعاً جديداً على https://supabase.com
2. اذهب إلى **SQL Editor** وشغّل محتوى الملف `sql/schema.sql` بالكامل. هذا سينشئ:
   - جداول: `profiles`, `conversations`, `messages`, `message_reactions`, `typing_status`
   - سياسات RLS تضمن أن كل طرف يرى محادثاته فقط
   - Trigger تلقائي ينشئ صف `profiles` عند التسجيل، ويحدد `is_admin` تلقائياً بمطابقة البريد مع القائمة الثابتة
   - Buckets تخزين: `avatars`, `attachments`, `wallpapers`
3. من **Settings > API** انسخ `Project URL` و `anon public key` — ولا تضعهما في الكود:
   ضعهما في متغيرات البيئة `VITE_SUPABASE_URL` و `VITE_SUPABASE_ANON_KEY` (انظر القسم 2).
4. من **Authentication > Providers** تأكد أن تسجيل الدخول بالبريد/كلمة المرور مُفعّل.
   (اختياري) عطّل "Confirm email" أثناء التطوير لتسريع الاختبار.
5. من **Database > Replication** تأكد أن الجداول `messages`, `typing_status`, `profiles`,
   `message_reactions` مضافة إلى `supabase_realtime` (السكربت يفعل هذا تلقائياً).

## 2. متغيرات البيئة (إلزامية — لا مفاتيح في الكود)

كل المفاتيح والروابط تُقرأ من متغيرات البيئة، ولا يوجد أي مفتاح مكتوب في المستودع.

```bash
cp .env.example .env     # ثم املأ القيم
npm run env:generate     # يولّد env.js في جذر الموقع (مُستثنى من Git)
```

| المتغير | مكانه | ملاحظة |
|---|---|---|
| `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` | الواجهة | المفتاح العام (anon) مصمَّم للظهور؛ الحماية من RLS |
| `VITE_FIREBASE_API_KEY` / `VITE_FIREBASE_PROJECT_ID` / `VITE_FIREBASE_MESSAGING_SENDER_ID` / `VITE_FIREBASE_APP_ID` | الواجهة | من Firebase Console → Project Settings → Web app |
| `VITE_VAPID_PUBLIC_KEY` | الواجهة | Cloud Messaging → Web Push certificates |
| `VITE_AGORA_APP_ID` | الواجهة (اختياري) | معرّف عام غير سرّي |
| `FIREBASE_*` / `SEND_PUSH_*` / `AGORA_APP_CERTIFICATE` | الدوال فقط | أسرار Supabase Edge Functions (`Deno.env`) — انظر القسم 6 |

آلية القراءة في الواجهة: `import.meta.env.VITE_*` (Vite) ← `self.__ENV__` (ملف `env.js` المولَّد)،
عبر وحدة واحدة هي `js/env.js`. `firebase-messaging-sw.js` يقرأ نفس الملف بـ `importScripts("./env.js")`.
إن غابت القيم تظهر **شاشة إعداد واضحة** تسمّي المتغيرات الناقصة بدل الانهيار.

> 🚫 ممنوع في الواجهة إطلاقاً: `SUPABASE_SERVICE_ROLE_KEY`، `FIREBASE_PRIVATE_KEY`،
> `FIREBASE_SERVICE_ACCOUNT`، `AGORA_APP_CERTIFICATE`، `SEND_PUSH_SECRET`.
> اختبار `tests/env-config.mjs` يفشل تلقائياً إذا ظهر أي منها — ويحمي أيضاً `scripts/generate-env.mjs`.

## 3. تشغيل التطبيق محلياً
التطبيق Vanilla JS بدون build step — يكفي خادم استاتيكي بسيط:

```bash
npm run env:generate     # مرة واحدة (وبعد كل تغيير في .env)
python3 -m http.server 8080
# افتح http://localhost:8080
```

> من يفضّل Vite: `npx vite` يقرأ `.env` ويحقن `import.meta.env` مباشرة (نفس الأسماء).
> ملاحظة: وحدات ES Modules (`type="module"`) لا تعمل من `file://` مباشرة، يجب تقديمها عبر خادم HTTP.

## 4. أيقونات وصوت الإشعار
المجلد `icons/` يحتاج منك إضافة:
- `icon-192.png` و `icon-512.png` (أيقونة التطبيق لتثبيت PWA)
- `notify.mp3` (صوت إشعار الرسائل الجديدة)

هذه ملفات ثنائية لم يتم توليدها هنا — أضف ملفاتك الخاصة بنفس الأسماء.

## 5. نشر التطبيق (Deploy)
يعمل على أي استضافة استاتيكة: Vercel, Netlify, GitHub Pages, Cloudflare Pages.
ارفع محتوى المجلد كما هو (تأكد أن `manifest.json` و `sw.js` في الجذر)، مع خطوة واحدة
قبل النشر: توليد `env.js` من متغيرات بيئة المنصة.

| المنصة | الطريقة |
|---|---|
| Vercel | أضف المتغيرات في Project Settings → Environment Variables — ملف `vercel.json` يشغّل `node scripts/generate-env.mjs` تلقائياً وقت البناء |
| Netlify / Cloudflare Pages | Build command: `node scripts/generate-env.mjs` + Environment variables |
| GitHub Pages | خطوة في GitHub Actions: `npm run env:generate` مع أسرار المستودع قبل النشر |
| أي استضافة يدوية | `npm run env:generate` محلياً ثم ارفع `env.js` مع الملفات (لا يحتوي أي سرّ سيرفري) |

## 6. ما تم تنفيذه في هذا الإصدار
- تسجيل/دخول عبر البريد وكلمة المرور + حفظ الاسم في `profiles`
- توجيه حسب الدور: مستخدم عادي يرى المشرفين الستة، والمشرف يرى بقية المشرفين + محادثاته
- رسائل فورية عبر Supabase Realtime
- مؤشر "يكتب الآن..."
- حالات الرسالة: أُرسلت / وصلت / قُرئت (صح رمادي وصحين أزرق)، بالإضافة لحالة "قيد الإرسال" (🕓) للرسائل المؤجلة أثناء انقطاع الاتصال
- عداد الرسائل غير المقروءة كشارة خضراء
- حالة الاتصال (متصل الآن) + **آخر ظهور دقيق** (heartbeat دوري + تحديث فوري عند إغلاق/تصغير التبويب)
- دعم عربي/إنجليزي مع تبديل RTL/LTR فوري
- وضع داكن/فاتح بألوان واتساب الرسمية
- رفع صورة شخصية وخلفية دردشة مخصصة
- إرسال صور وملفات كمرفقات
- **رسائل صوتية**: تسجيل عبر MediaRecorder، رفعها، وتشغيلها بمشغّل صوت مدمج
- **الرد على رسالة**: بالنقر على أيقونة ↩ أو **بالسحب الأفقي (Swipe to Reply)** على الجوال، مع معاينة الرسالة المقتبسة فوق صندوق الكتابة وداخل الفقاعة
- **التفاعل بالإيموجي**: قائمة سريعة (❤️👍😂😮😢🙏) فوق كل رسالة، مع شارات قابلة للنقر للإزالة، ومزامنة فورية عبر Realtime
- منتقي إيموجي سريع للرسائل الجديدة
- **واجهة المحادثة في ملف منفصل** (`partials/chat-panel.html`) يُحقن ديناميكياً — يسهّل الصيانة ويُبقي `index.html` خفيفاً
- **وضع عدم الاتصال (Offline)**: تخزين المحادثات والرسائل في IndexedDB، عرضها فوراً عند فتح التطبيق حتى دون إنترنت، وشريط تنبيه علوي عند انقطاع الاتصال
- **قائمة انتظار الإرسال (Outbox)**: أي رسالة تُكتب أثناء انقطاع الاتصال تُخزَّن محلياً وتُرسل تلقائياً بمجرد عودة الشبكة (`online` event)
- **PWA** قابل للتثبيت + Service Worker لتخزين الواجهة (App Shell)
- **FCM Web Push Notifications حقيقية** تصل حتى مع إغلاق المتصفح، عبر Firebase Service Worker وEdge Function (تفاصيل الإعداد أدناه)
- **التعافي من الخلفية**: طبقة `js/realtime.js` تعيد الاشتراكات مع backoff عندما يعمل
  JavaScript، ومزامنة «ما فات» تُنفَّذ عند عودة الصفحة. قد يجمّد المتصفح الصفحة ويخنق المؤقتات
  والـ WebSocket؛ لذلك لا يُعتمد على الـ watchdog أثناء الإغلاق/التجميد. FCM بأولوية عالية
  ومزامنة التوكن عند التشغيل/الاستئناف تقللان الانقطاع، لكن التسليم يظل خاضعاً للمتصفح والنظام.
- **نقرة الإشعار تفتح المحادثة الصحيحة دائماً**: موجّه مركزي `js/notification-router.js`
  يلتقط النقرة حتى لو وصلت أثناء إقلاع التطبيق (تخزين مؤقت 30 دقيقة)، ويمرّر الشاشة إلى
  الرسالة نفسها ويميّزها تمييزاً مؤقتاً.
- **عدّاد غير المقروء**: مصدر واحد للحقيقة يُصفَّر **فوراً** بمجرد لمس المحادثة، ويُثبَّت على
  السيرفر بدالة ذرّية `mark_conversation_read(uuid)` أو طلب UPDATE احتياطي، مع طابور قراءات
  دائم (`wa_pending_reads`) يُعاد إرساله بعد انقطاع الشبكة.
- **علامات حالة الرسالة**: ✓ واحدة (محفوظة محلياً — أوفلاين/خلفية) ⇒ ✓✓ رمادي بمجرد استلام
  السيرفر للرسالة أو وصول الإشعار ⇒ ✓✓ أزرق عند القراءة الفعلية، مع تثبيت «تم التسليم» من جهة
  المستقبِل (Realtime/مزامنة/Edge Function) ودالتَي `mark_messages_delivered` و`mark_all_messages_delivered`.
- **الرسالة الترحيبية**: لم تعد تُرسل بمجرد فتح محادثة المشرف — تُرسل عند **أول رسالة فعلية من
  العميل**، بنص يتضمّن التنبيه («التواصل مع العديد من المكاتب قد يعرّضك للحظر…») مع الإبقاء على
  الزرّين التفاعليين كما هما.
- **«متصل الآن» للمشرفين**: ثابت ودائم في الواجهة وفي قاعدة البيانات (مُشغِّل على `profiles`)،
  ولا يقطعه سكون متصفح المشرف ولا انقطاع الحضور ولا نبضة خروج.
- **عزل مستلمي الإشعارات (v2.9)**: إشعار الرسالة للطرف الآخر في المحادثة حصراً، ورنين المكالمة
  لـ `callee_id` في غرفة المكالمة حصراً، وبوابة مركزية ترفض أي مستلم لا يطابق الحدث —
  **المشرف العام يرى كل شيء (RLS) لكن لا يرن هاتفه ولا يصله إشعار لأي محادثة/مكالمة ليس طرفاً فيها**.

> ℹ️ تقارير الخطوات القديمة حُذفت من المستودع؛ سجلّ التغييرات محفوظ في تاريخ Git.

### اختبارات سريعة
```bash
npm test        # 3 أدوار (user/admin/super) + 4 سيناريوهات لنقر الإشعار والعدّاد
npm run lint        # ESLint على js/
npm run typecheck   # فحص أنواع دوال Deno + طبقة إعداد الواجهة (tsc)
npm run check       # صياغة app.js + العلامات الأساسية + lint + typecheck
npm run env:check   # التأكد من وجود كل متغيرات البيئة المطلوبة
```

## 7. إعداد الإشعارات الحقيقية (Firebase Cloud Messaging)
الإشعارات الحالية تستخدم **FCM Web Push** مع Supabase Edge Function `send-push`؛ أما جدول
`push_subscriptions` فهو بقايا مسار Web Push القديم ولا يدخل في مسار FCM الحالي.

### آلية العمل الحالية
- `js/push.js`: يهيّئ Firebase SDK، يطلب إذن الإشعارات، ويسجّل
  `firebase-messaging-sw.js` في نطاق مخصص `./firebase-cloud-messaging-push-scope`، منفصل عن
  `sw.js` الخاص بكاش App Shell.
- `supabase/functions/send-push/index.ts`: يرسل **Data-only payload** إلى FCM HTTP v1، بلا
  `notification` أو `webpush.notification`، ويقصّ النص عند الحاجة إلى حد آمن (3500 بايت UTF-8)
  كي لا ترفض FCM حمولة رسالة طويلة. نجاح `sent=1/1` يعني أن FCM قبل الإرسال، وليس تأكيداً
  بأن الجهاز عرض الإشعار أو أن نظام التشغيل سمح بصوته.
- `firebase-messaging-sw.js`: مستمع `push` الخام هو المسؤول الوحيد عن الإشعار في الخلفية؛
  يقرأ `data` ويعرضه عبر `registration.showNotification()`. معالج Firebase
  `onBackgroundMessage()` للتشخيص فقط، لمنع إشعار تلقائي ثانٍ بحمولة مختلفة.
- عند بقاء صفحة التطبيق ظاهرة، `listenForForegroundMessages()` في `push.js` يتولى إشعار
  المقدمة والصوت داخل الصفحة. لا يُستخدم `new Notification()`.
- كل جهاز/متصفح له صف FCM مستقل في `fcm_tokens`. يسجَّل التوكن من الصفحة بعد تسجيل الدخول
  عبر RPC آمنة، وتقرأ الدالة/تحذف التوكنات الميتة عبر `service_role`.

### حدود المنصة (لا يمكن ضمان «100%» من جهة JavaScript)
- بعد إغلاق الصفحة لا تعمل مؤقتات التطبيق أو WebSocket؛ الذي يمكن إيقاظه هو Service Worker
  عند وصول Push. المتصفح ونظام التشغيل قد يؤخران أو يمنعان التسليم بسبب حظر الإذن، وضع توفير
  الطاقة، DND، اتصال الجهاز أو سياسات النظام. `Urgency: high` وFCM `priority: high` يقللان
  التأخير ولا يلغيان هذه القيود.
- Service Worker لا يستطيع تشغيل ملف `notify.mp3` أو إبقاء صوت مستمر موثوقاً بالخلفية.
  `silent: false` يطلب صوت الإشعار الافتراضي من المتصفح/النظام، ويظل خاضعاً لإعدادات الجهاز.
  الملف الصوتي مخصص للمقدمة فقط، وتشغيله فيها قد يمنعه autoplay policy.
- على iOS يلزم دعم Web Push في إصدار النظام، وإضافة التطبيق إلى الشاشة الرئيسية (PWA)؛
  الإشعارات ليست مدعومة في كل سياقات Safari/المتصفحات المضمّنة.

### تشخيص «الاختبار ينجح لكن إشعار الرسالة لا يصل»
1. زر الاختبار المباشر يختبر **الجلسة → Edge Function → FCM** فقط؛ لا يختبر Trigger قاعدة البيانات.
2. استخدم `push_probe()`/`push_probe_result()` أو `push_diagnostics()`، ثم راجع
   `push_delivery_log` للتأكد من أن Trigger الرسائل و`pg_net` وصلا إلى `send-push`.
3. افحص سجل Service Worker `[push-sw]`: `push received` يعني أن دفعة وصلت إلى المتصفح؛
   `decision: background → render notification` ثم `notification shown` يعني أن العرض طُلب.
   إن لم يظهر `push received` فالمشكلة قبل معالج العرض (توكن/مشروع Firebase/إذن/متصفح/نظام).
4. عند تسجيل `sent=1/1` مع غياب `push received`، لا تعتبر FCM ACK دليلاً على وصول الجهاز؛
   أعد تسجيل FCM token، وتأكد أن التطبيق وEdge Function يستخدمان مشروع Firebase وVAPID نفسيهما.

### خطوات الإعداد
1. **مشروع Firebase**: أنشئ مشروعاً على [console.firebase.google.com](https://console.firebase.google.com)،
   فعّل **Cloud Messaging**، واحصل على `firebaseConfig` من Project Settings → General → Your apps → Web app.
2. **مفتاح VAPID الخاص بـ Firebase** (مختلف عن VAPID القديم): Project Settings → Cloud Messaging →
   Web Push certificates → Generate key pair.
3. ضع قيم الإعداد في متغيرات البيئة **مرة واحدة فقط** (بدل نسخها في ملفين):
   `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_MESSAGING_SENDER_ID`,
   `VITE_FIREBASE_APP_ID`. يقرأها `js/push.js` من `js/env.js`، ويقرأها
   `firebase-messaging-sw.js` من نفس `env.js` عبر `importScripts` — فلا يمكن أن يختلفا
   (كان اختلاف النسخ/الاختصار سبب خطأ "ServiceWorker script evaluation failed" سابقاً).
   `authDomain` و `storageBucket` مشتقّان تلقائياً من `projectId`.
4. ضع مفتاح VAPID في `VITE_VAPID_PUBLIC_KEY` (نفس المتغير يقرأه `js/push.js`).
5. **نفّذ قسم 8 و 9 من `sql/schema.sql`** في SQL Editor (جدول `fcm_tokens` + صلاحيات).
6. من داخل التطبيق: **الإعدادات ⚙️ → تفعيل إشعارات الجهاز**.

### نشر Edge Function للإشعارات (الإرسال المباشر إلى FCM)

المسار الحالي مبسّط: `Database Trigger → pg_net → send-push (تحقق وعزل) → FCM HTTP v1 → Service Worker`.
لا يوجد Worker وسيط. بذلك تُرجع الدالة أكواد وأخطاء FCM الأصلية، وتضبط `priority: high` وTTL
مباشرةً لكل رسالة. ما زالت قواعد التحقق وعزل المستلمين وتعدد الأجهزة كما هي.

```bash
supabase functions deploy send-push

# أسرار Supabase Edge Function (أسرار سيرفرية فقط):
supabase secrets set \
  SEND_PUSH_SECRET="ضع-سراً-عشوائياً-طويلاً" \
  FIREBASE_SERVICE_ACCOUNT="$(cat /مسار-آمن/service-account.json)"
```

بدلاً من JSON كامل، يمكن ضبط `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`,
`FIREBASE_PRIVATE_KEY` كلٌّ على حدة. أنشئ حساب خدمة من Firebase/Google Cloud يملك صلاحية إرسال
FCM (Firebase Cloud Messaging API)، واحفظ الملف/المفتاح الخاص في أسرار Edge Function فقط،
ولا تضعه في Git أو في متغيرات الواجهة `VITE_*`. يُخزّن OAuth access token مؤقتاً في الذاكرة
ويُجدّد قرب انتهاء صلاحيته. `PUSH_NORMAL_URGENCY=1` اختياري لتخفيض أولوية الرسائل؛ الافتراضي
`high`، ومكالمات/اختبارات الإشعار تستخدم TTL قصيراً (60 ثانية) بينما الرسائل تستخدم 24 ساعة.

مسار التريگرات (قاعدة البيانات → send-push) في v2.15 يحمل الرابط العام والسرّ المشترك
**مُضمَّنين مباشرةً** داخل دالة `trigger_send_push_notification` — بلا أي قراءة من
Supabase Vault. السبب: قراءة `SEND_PUSH_URL`/`SEND_PUSH_SECRET` من
`vault.decrypted_secrets` كانت تُرجِع نصاً مشفّراً (أو تفشل فكّ التشفير) فيفشل
`pg_net.http_post` بخطأ `Couldn't resolve host name`. الرابط ليس سرّاً (دالة عامة على
البوابة منشورة بـ `verify_jwt = false`)، والتحقّق الفعلي عبر ترويسة `x-send-push-secret`.

التضمين الآن **شامل في كل ملفات SQL بالمستودع** (لا `sql/schema.sql` ولا أي هجرة في
`sql/migrations/` تقرأ `SEND_PUSH_URL`/`SEND_PUSH_SECRET` من Vault — صفر مراجع
`vault.decrypted_secrets`/`vault.secrets` في الكود)، وتشمل كل دوال التريغرات
(`notify_new_message` / `notify_call_room` / `notify_admins_new_profile` /
`push_call_edge` / `trigger_send_push_notification`) وكل دوال التشخيص
(`push_diagnostics` / `push_gateway_check` / `push_probe` / `push_probe_result`).

```sql
-- مطلوب على القواعد القائمة (آمن لإعادة التنفيذ):
-- sql/migrations/2026-10-21_v2_15_hardcoded_send_push_endpoint.sql
-- (يضمن امتداد pg_net وتريگر on_message_inserted على messages)

-- ⚠️ السرّ المُضمَّن في trigger_send_push_notification يجب أن يطابق تماماً
--    SEND_PUSH_SECRET المضبوط على دالة send-push (أعلاه)، وإلا رُدّت الطلبات بـ 401.
--    القيمة المعتمدة حالياً: my_send_push_19921121_almgawell_19921121
--    لتغييره: عدّل ثابت v_secret داخل الدالة ثم أعد تنفيذ الهجرة.
--    (المقابل في أسرار الدالة: supabase secrets set SEND_PUSH_SECRET=<القيمة>)
```

طبّق `sql/migrations/2026-10-21_v2_15_hardcoded_send_push_endpoint.sql` على قواعد البيانات القائمة؛ `sql/schema.sql` يتضمن التعديل (القسم 21) للتثبيت الجديد. للتحقق:
`select public.push_diagnostics();` و`select public.push_gateway_check();` — يعلنان
الرابط المُضمَّن وحالة pg_net بلا أي اعتماد على Vault. لا تحتاج إلى أي أسرار أو إعدادات
Cloudflare Worker.

> ملاحظة: iOS Safari لا يدعم FCM Web Push إلا عندما يكون التطبيق **مثبّتاً كـ PWA** على
> الشاشة الرئيسية (iOS 16.4+)، تماماً كحال Web Push العادي.

## 8. صلاحيات المشرف العام (Super Admin)
حساب `almgawell17@gmail.com` يملك صلاحيات مطلقة على **كل** المحادثات و**كل** المشرفين —
مُفعَّلة عبر عمود `profiles.is_super_admin` وسياسات RLS في قسمي 9 و**19** من `sql/schema.sql`.
تظهر محادثات المشرفين الآخرين في قائمته مع شارة صغيرة باسم المشرف الأصلي صاحب المحادثة.

الوضع المعمول به بعد v2.13:
- **قراءة وكتابة كاملة** على `conversations` و`messages` و`typing_status` و`message_reactions`
  — يستطيع الرد بسلاسة على محادثات المستخدمين مع المشرفين الآخرين بلا أي 403،
  وإرسال «يكتب الآن» والتفاعل مع الرسائل في أي محادثة.
- **إشعار ردّه** في محادثة ليست طرفاً فيها يذهب إلى **المستخدم** صاحب المحادثة
  (العميل المنتظر للجواب) — لا إلى المشرف المالك ولا لأي جهة أخرى.
- **يبقى قراءة فقط** (خارج نطاق الكتابة عمداً): غرف المكالمات وسجلاتها، وإدارة
  المستخدمين (الحظر/الحذف عبر `admin_set_user_blocked`/`admin_delete_user`)،
  وحالة قراءة/تسليم رسائل المحادثات المراقَبة لا تتغيّر باطلاعه (وضع v2.9 الصامت).
- **حماية الرسائل من العبث باقية**: صلاحية التحديث لا تسمح بتغيير محتوى/مرفقات
  رسالة أرسلها شخص آخر (`protect_message_immutable_fields`).

لإضافة حساب مشرف عام آخر لاحقاً: نفّذ فقط سطر `update public.profiles set is_super_admin =
true, is_admin = true where email = '...';` من قسم 9 بالبريد الجديد — لا حاجة لتعديل أي كود.

## 9. المرحلة التالية (لم تُبنَ بعد — يمكن إضافتها عند الطلب)
- مزامنة صراعات التعديل (conflict resolution) عند تعديل نفس الرسالة من أكثر من جهاز أثناء العمل دون اتصال
- بحث فعلي داخل قائمة المحادثات وداخل الرسائل (الحقل موجود شكلياً فقط حالياً)
- ضغط وتصغير الصور قبل الرفع لتوفير الباندويدث
- دعم مجموعات (Group Chats) بدلاً من محادثات ثنائية فقط

---

## 🎥 المكالمات الصوتية والمرئية (Agora)

### أ) تهيئة المنصة
1. أنشئ مشروعاً على [Agora Console](https://console.agora.io) ثم انسخ **App ID**.
2. ضع القيمة في متغير البيئة `VITE_AGORA_APP_ID` (بدل كتابتها في الكود).
3. بدون تعديل الكود يمكنك ضبطها وقت التشغيل:
   ```js
   // من وحدة تحكم المتصفح
   localStorage.setItem("agora_app_id", "APP_ID_HERE");
   ```

> **تحميل المكتبة:** يُحمَّل SDK من عدة مصادر بالتتابع
> (jsdelivr ← unpkg ← download.agora.io)، فلا يُعطّل مصدرٌ واحد فاشل (503) الميزة.
> لتثبيت مصدر محدد: `localStorage.setItem("agora_sdk_url", "https://...")`.
>
> ⚠️ لا تضبط `crossOrigin` على وسم `<script>` الخاص بالـ SDK — الوسم العادي
> لا يخضع لـ CORS أصلاً، وضبط الخاصية يُفعّل فحص CORS فيرفض المتصفح الملف
> لأن `download.agora.io` لا يُرسل `Access-Control-Allow-Origin`.

### ب) وضع الأمان (مهم جداً)
| الوضع | App Certificate | ما تحتاجه |
|---|---|---|
| **Testing** | معطّل | App ID فقط — يكفي للتجربة |
| **Secured** (موصى به للإنتاج) | مفعّل | خادم توكن آمن |

> ⚠️ **لا تضع App Certificate في الكود الأمامي إطلاقاً.** إن فعّلت الوضع الآمن،
> انشر Edge Function تُصدر التوكن وضع رابطها في `AGORA_DEFAULTS.tokenEndpoint`
> (أو `localStorage.agora_token_endpoint`). يجب أن تُرجع `{ "token": "..." }`.

### ج) جداول قاعدة البيانات
شغّل `sql/schema.sql` (القسم 10) — وهو **idempotent** أي يمكن إعادة تنفيذه بأمان:
- `call_rooms` — غرفة/جلسة كل مكالمة، مع عمود `duration_seconds` محسوب تلقائياً،
  وفهرس فريد يمنع أكثر من مكالمة نشطة على نفس المحادثة.
- `call_logs` — سجل أحداث append-only للتدقيق (`initiated`, `answered`, `ended`, ...).
- `profiles.call_status` — حالة اتصال المستخدم (`available` / `ringing` / `in_call` / `unavailable`).
- سياسات RLS: الطرفان فقط يريان الغرفة؛ لا يمكن انتحال مكالمة لطرف خارج المحادثة؛
  السجلات لا تُعدَّل ولا تُحذف؛ المشرف العام له اطّلاع كامل للتدقيق.

### د) كيف تعمل
- **الإشارات**: Supabase Realtime Broadcast على قناة `calls:user:<uid>`.
- **الوسائط**: Agora RTC Web SDK، يُحمَّل **بشكل كسول عند أول مكالمة فقط** حتى لا يبطئ الإقلاع.
- **الضوابط**: كتم الميكروفون، إيقاف/تشغيل الكاميرا، تبديل الكاميرا، إنهاء المكالمة، ومؤقّت المدة.
- زرّا المكالمة (📞 صوتية و🎥 مرئية) يظهران بجانب زر البحث 🔍 في رأس المحادثة،
  ويُعطَّلان تلقائياً عند غياب محادثة نشطة أو انقطاع الإنترنت.
- انقطاع الشبكة أثناء مكالمة يُنهيها بلطف ويحرّر الكاميرا/الميكروفون.

> المتصفح يتطلب **HTTPS** (أو `localhost`) للوصول إلى الكاميرا والميكروفون.

---

## 🗜️ ضغط الوسائط قبل الرفع

الوحدة `js/media.js` تضغط الصور تلقائياً قبل رفعها إلى Supabase Storage:

| السياق | أقصى أبعاد | الجودة |
|---|---|---|
| مرفقات المحادثة | 1600×1600 | 0.72 |
| الصورة الشخصية | 512×512 | 0.80 |
| خلفية الدردشة | 1920×1920 | 0.70 |

- تُصدَّر بصيغة **WebP** عند دعم المتصفح لها (أصغر 25‑35% من JPEG)، وإلا JPEG/PNG.
- تُحترم دوران الصورة (EXIF) عبر `imageOrientation: "from-image"`.
- يُستخدم `createImageBitmap` + `OffscreenCanvas` لتقليل استهلاك الذاكرة، مع **تحرير الموارد فوراً** بعد المعالجة.
- **لا تُضغط**: GIF/SVG/AVIF/HEIC (يفسدها)، الملفات الأصغر من 60KB، والرسائل الصوتية (مضغوطة أصلاً).
- حد أقصى 25MB لأي ملف بعد الضغط، وأي فشل في الضغط يرفع الملف الأصلي بدل إيقاف الإرسال.
- تضبط القيم من `MEDIA_LIMITS` في `js/config.js`.

---

## 🛡️ حماية الواجهة من الانهيار

الوحدة `js/safety.js` توفّر طبقة Error Boundaries:

- `safeAsync(label, fn, {fallback, retries})` — تنفيذ آمن مع قيمة بديلة وإعادة محاولة تصاعدية.
- `safeQuery(label, queryFn, fallback)` — تغليف استعلامات Supabase (تلتقط `{error}` وأخطاء الشبكة معاً).
- `safeDom(label, fn)` — تعديلات DOM لا توقف بقية التدفق إن اختفى عنصر.
- `guard(label, handler)` — تغليف مستمعي الأحداث فلا يتسرّب استثناء للمتصفح.
- `installGlobalErrorBoundary()` — التقاط `error` و `unhandledrejection` عالمياً وعرض تنبيه لطيف بدل شاشة بيضاء.

**تحسينات الاستقرار المطبّقة:**
- الإقلاع لم يعد يعتمد على `DOMContentLoaded` وحده (كان التطبيق قد لا يُقلع إطلاقاً لو أُطلق الحدث قبل تحميل الوحدة).
- `IndexedDB` غير المتاح (التصفح الخاص) لم يعد يُسقط التطبيق — يتحوّل تلقائياً للوضع المتصل.
- حماية من **سباق الحالة**: تجاهل رد الشبكة إن غُيّرت المحادثة أثناء الانتظار.
- الرسم عبر `DocumentFragment` (إعادة تدفّق واحدة)، وفقاعة تالفة لا تُسقط المحادثة كلها.
- `debounce` على تحديث قائمة جهات الاتصال (كانت تُستدعى عشرات المرات مع أحداث presence).
- نبضة الحضور تتوقف عند إخفاء الصفحة أو انقطاع الشبكة (توفير بطارية وحزمة).
- حماية الامتيازات في قاعدة البيانات: trigger يمنع أي مستخدم من منح نفسه `is_admin` / `is_super_admin`.
- تشديد سياسات التخزين: الرفع مسموح داخل مجلد المستخدم `<user_id>/` فقط.
- ربط عناصر واجهة كانت معطّلة: حذف الصورة الشخصية/الخلفية، والبحث في قائمة المحادثات والرسائل.

### هـ) إصلاح خطأ `dynamic use static key`
إذا كان App Certificate مفعّلاً، انشر دالة التوكن قبل اختبار المكالمات:
```bash
supabase functions deploy agora-token --no-verify-jwt
supabase secrets set AGORA_APP_ID=... AGORA_APP_CERTIFICATE=...
```
لا تضع App Certificate في الواجهة إطلاقاً — يبقى سرّاً في `Deno.env.get("AGORA_APP_CERTIFICATE")` داخل الدالة، وهي تتحقق من جلسة Supabase وتصدر توكناً صالحاً لمدة ساعة.

---

## 🆕 الإصدار v2 (2026-09-21) — ما الجديد

> **مطلوب:** نفّذ `sql/migrations/2026-09-21_v2_calls_auth_rls.sql` في SQL Editor (أو `sql/schema.sql` كاملاً — يتضمّنه كقسم 11)، ثم أعد نشر `supabase functions deploy send-push`.

### 1) أداء الرسائل + وضع الأوفلاين
- **Cache-first**: تُعرض الرسائل من IndexedDB فوراً ثم تُزامَن من الشبكة.
- **مزامنة تفاضلية (Delta sync)**: بعد أول تحميل لا يُجلب إلا الجديد/المحدَّث بدل 500 رسالة كل مرة.
- **ترقيم (Pagination)**: أول فتح يجلب آخر 80 رسالة فقط، مع زر/تمرير "تحميل رسائل أقدم".
- **إرسال متفائل (Optimistic UI)**: تظهر رسالتك فوراً بعلامة 🕓 ثم تتحوّل إلى ✓ — لا انتظار للخادم.
- استعادة **آخر موضع تمرير** لكل محادثة عند العمل دون اتصال، وفواصل الأيام داخل المحادثة.
- فشل شبكة أثناء الإرسال ⇒ يُحفظ في صندوق الصادر ويُرسل تلقائياً.
- Service Worker بنمط **stale-while-revalidate** لملفات JS/CSS/HTML (إقلاع فوري + تحديث خلفي).

### 2) إشعارات الخلفية
- **بطاقة طلب إذن الإشعارات** تظهر بعد الدخول (مع تأجيل 3 أيام عند "لاحقاً").
- **تجديد توكن FCM بصمت** عند كل دخول (مرة يومياً) — أشهر سبب لتوقف الإشعارات بعد فترة.
- **دليل تعطيل تحسين البطارية والعمل في الخلفية** حسب النظام (Android / iOS / سطح المكتب) من الإعدادات ⚙️ → "إعداد العمل في الخلفية"، ويُفتح تلقائياً بعد التفعيل على أندرويد.
- **إشعار مكالمة واردة في الخلفية**: Trigger على `call_rooms` يستدعي `send-push` بأولوية عالية (`priority: high`, `Urgency: high`, TTL قصير) مع أزرار رد/رفض، وإشعار "مكالمة فائتة" عند عدم الرد.

### 3) واجهة مكالمات عصرية (واتساب/تليجرام)
- شاشة كاملة بخلفية ضبابية من صورة الطرف الآخر، حلقات نبض أثناء الرنين، مؤشر جودة الشبكة، عدّاد المدة، شارة "مشفّرة".
- أزرار دائرية بتسميات: السماعة / الكاميرا / كتم / إنهاء، معاينة الكاميرا المحلية PiP، إخفاء الضوابط بالنقر على الفيديو، **تصغير المكالمة** لشريط عائم والعودة إليها.
- شاشة مكالمة واردة كاملة مع زر قبول نابض.
- **نغمات رنين تفاعلية** مولَّدة بـ Web Audio (`js/ringtone.js`): نغمة انتظار للمتصل، لحن + اهتزاز للمستقبل، نغمات اتصال/إنهاء/مشغول.

### 4) سجل المكالمة داخل المحادثة
- بطاقة لكل مكالمة: النوع (صوت/فيديو)، الاتجاه (صادرة/واردة)، **المدة** عند الرد، أو **"مكالمة فائتة"** بالأحمر عند عدم الرد/الرفض، مع زر معاودة الاتصال.
- أعمدة جديدة على `messages`: `call_type`, `call_status`, `call_caller_id`.

### 5) أيقونة سجل المكالمات أعلى قائمة المحادثات
- أيقونة 📞🕘 بشارة عدد المكالمات الفائتة غير المشاهدة، ونافذة سجل مجمّعة حسب اليوم (اليوم/أمس/التاريخ) مع **الوقت والتاريخ الكاملين**، تبويب "الفائتة"، معاودة الاتصال، والحذف من سجلي فقط.

### 6) صلاحيات المشرفين (RLS)
- حذف الرسائل: سياسة `messages delete admins only` (المشرفون فقط)، والواجهة تُخفي الزر لغيرهم.
- حظر/حذف المستخدمين عبر دوال `SECURITY DEFINER` تتحقق داخلياً: `admin_set_user_blocked(uuid, boolean)` و`admin_delete_user(uuid)` (تحذف من `auth.users` أيضاً). لا يمكن حظر/حذف مشرف.
- المستخدم المحظور لا يستطيع الإرسال أو بدء محادثة/مكالمة (`is_not_blocked()`)، ولا يمكن لأي مستخدم رفع صلاحياته أو تغيير `is_blocked`/`phone`.
- غير المشرف لا يستطيع تعديل محتوى الرسائل (يغيّر حالة القراءة فقط).

### 7) المصادقة
- **مستخدم عادي**: اسم المستخدم + رقم الهاتف + كلمة المرور (لا بريد). داخلياً يُشتق بريد `phone.<digits>@users.local` لمصادقة Supabase (لا حاجة لمزوّد SMS)، والـ trigger يخفيه ويحفظ الرقم الحقيقي في `profiles.phone`.
- **مشرف**: بريد معتمد في قائمة `ADMINS` + كلمة المرور.
- شاشة الدخول: مبدّل (👤 مستخدم / 🛡️ مشرف). إدخال **هاتف + كلمة مرور** ⇒ مستخدم عادي؛ إدخال **بريد + كلمة مرور** ⇒ مشرف (ويُرفض إن لم يكن البريد معتمداً أو الحساب غير مشرف).
- من إعدادات Supabase → Authentication: أبقِ مزوّد **Email** مفعّلاً، ويُنصح بتعطيل "Confirm email" (أو إضافة `users.local` لقائمة السماح) حتى يدخل المستخدمون فوراً.

## الإصدار v2.1 — عدّاد غير المقروء، الترتيب، إجراءات الرسائل، الإشعارات

- **عدّاد غير المقروء للمستخدم العادي**: يُحسب من `messages` ويُحدَّث لحظياً (Realtime) مع نقل المحادثة للأعلى.
- **الترتيب حسب آخر تفاعل** في قائمة المشرفين (لوحة المشرف والمستخدم) وقائمة المستخدمين.
- **إجراءات الرسالة** (حذف/تفاعل/رد) مخفية دائماً وتظهر فقط عند النقر على الفقاعة (Esc أو النقر خارجها يخفيها).
- **قسم المشرفين قابل للطي**: مطوي افتراضياً للسوبر أدمن مع زر إظهار؛ الحالة محفوظة في `localStorage`.
- **الإشعارات في الخلفية** — قائمة التحقق بعد النشر:
  1. نفّذ `sql/migrations/2026-09-21_v2_1_unread_push.sql` (Triggers لا تكسر الإدراج + جدول `push_delivery_log` للتشخيص).
  2. طبّق `sql/migrations/2026-10-21_v2_15_hardcoded_send_push_endpoint.sql`: يضمن امتداد pg_net، ويضمّن رابط وثابت send-push مباشرةً في `trigger_send_push_notification` — بلا Vault (تأكد أن السرّ المُضمَّن يطابق سرّ الدالة).
  3. انشر `send-push` مع `verify_jwt = false`، واضبط `SEND_PUSH_SECRET` وحساب خدمة Firebase كأسرار للدالة. الإرسال الحالي مباشر من الدالة إلى FCM HTTP v1؛ لا Worker مطلوب.
  4. من التطبيق: **🔔 إرسال إشعار تجريبي** ثم أغلق التطبيق — يجب أن يصل. إن لم يصل راجع `select * from push_delivery_log order by id desc`.
- اختبارات دخانية: `cd tests && npm i jsdom && node smoke.mjs user|admin|super`.

## الإصدار v2.2 — تشخيص الإشعارات + حذف المستخدم الشامل
- زر **🔔 إرسال إشعار تجريبي** يعرض الآن تقريراً خطوة بخطوة (HTTPS، الإذن، Service Worker، إشعار محلي فوري، توكن FCM، pg_net/الرابط المُضمَّن/Triggers عبر `push_diagnostics()`, ثم الإرسال الفعلي عبر `send-push`).
- **سبب عدم وصول الإشعارات حالياً**: دالة `send-push` غير منشورة على المشروع (تعيد 404). الحل:
  `supabase functions deploy send-push --no-verify-jwt` + ضبط الأسرار `SEND_PUSH_SECRET` وبيانات حساب خدمة Firebase (FCM مباشر)، ثم تنفيذ migrations v2.1 و v2.15 (رابط وثابت send-push مُضمَّنان في مسار التريگرات — بلا Vault).
- إشعار مرئي محلي عند وصول رسالة Realtime والتطبيق مفتوح في محادثة/تبويب آخر (لا يعتمد على FCM).
- `admin_delete_user`: متاح لكل مشرف (`is_admin` أو `is_super_admin`)، يحذف: التخزين (مرفقات/أفاتار/خلفيات)، التفاعلات، الرسائل، الكتابة، المكالمات وسجلاتها، المحادثات، توكنات FCM، الملف الشخصي، وحساب `auth.users`؛ ويعيد إحصاءات ما حُذف. `reply_to_id` أصبح `on delete set null` حتى لا يعيق الحذف.
- إجراءات الرسالة مخفية لكل الأدوار حتى النقر على الفقاعة.

## الإصدار v2.3 — جوانب الفقاعات، شارة المشرف المالك، سلاسة العدّادات، مسبار الخلفية
- **جانب الفقاعة حسب الفريق**: رسائل المشرفين/الإدارة كلها في جهة (`mine`)، ورسائل المستخدم العادي في الجهة الأخرى (`theirs`) — يشمل السوبر أدمن عند مشاهدة محادثة مشرف آخر (تظهر فقاعته بلون أفتح مع اسم المرسل).
- **شارة المشرف المالك** بجانب اسم المستخدم للسوبر أدمن (في القائمة ورأس المحادثة) مع احتياط إن فشل الـ join.
- **العدّادات**: تصفير فوري عند فتح المحادثة (قبل الشبكة)، تحديث موضعي لصف المحادثة بدل إعادة رسم القائمة، مزامنة التصفير بين الأجهزة، وإعادة اشتراك تلقائية عند انقطاع قناة Realtime.
- **مسبار مسار الخلفية**: زر الإشعار التجريبي يختبر الآن أيضاً المسار الحقيقي (قاعدة البيانات → pg_net → send-push) ويطبع رمز HTTP الفعلي (401 = السرّ المُضمَّن في trigger_send_push_notification لا يطابق سر الدالة، 404 = الرابط المُضمَّن خاطئ، timeout). يتطلب `sql/migrations/2026-10-21_v2_15_hardcoded_send_push_endpoint.sql` وإعادة نشر `send-push`.

## الإصدار v2.9 — عزل إشعارات الرسائل والمكالمات + الوضع الصامت للمشرف العام

الهجرة: `sql/migrations/2026-10-13_v2_9_notification_recipient_isolation.sql` (مطابقة في `sql/schema.sql` §17)
— **دوال + Triggers + سياسات RLS فقط، بلا أي تغيير على الجداول أو أنواع البيانات**.

- **إشعار الرسالة = الطرف الآخر في نفس صف المحادثة** (`conversations.user_id` ⇄ `admin_id`).
  إن كان المرسل ليس طرفاً في المحادثة (مشاهدة/مراقبة المشرف العام) ⇒ لا إشعار لأي جهة،
  ويُسجَّل السبب في `push_delivery_log` بوسم `SKIPPED`.
- **رنين المكالمة = `call_rooms.callee_id` حصراً** — لا سوبر أدمن، ولا مشرفين، ولا أي حساب غير المعني
  (`incoming_call` عند الرنين و`call_ended` عند الفوات/الانتهاء).
- **بوابة مركزية** `push_recipient_allowed()` داخل `push_call_edge()`: تمنع أي إشعار لا يطابق الحدث
  **قبل** أي طلب شبكة (fail-closed)، وتُعيد التحقق من أن طرفي المكالمة هما طرفا المحادثة.
- **`send-push` تشدّد أيضاً**: مستلم الرسالة يُحسب من صف المحادثة، ورنين المكالمة يُقرأ من `call_rooms`
  (لا من الحمولة)، مع رفض `callee mismatch` و`recipient mismatch`.
- **المشرف العام (Super Admin)**: مراقبة كاملة بلا قيود عبر RLS (محادثات/رسائل/غرف مكالمات/سجلات/سجل الإشعارات
  + `call_history_hidden`)، ووضع صامت كامل: لا صوت ولا إشعار نظام ولا رنين لأي محادثة أو مكالمة ليس طرفاً مباشراً
  فيها — على مستوى قاعدة البيانات والدالة **والواجهة** (قناة Realtime + دعوة المكالمة).
- **وضع المراقبة للقراءة فقط**: فتح المشرف العام لمحادثة ليس طرفاً فيها لا يغيّر حالة «مقروء/مُسلَّم»
  لأصحابها (حراسة داخل `mark_conversation_read` و`mark_messages_delivered` + بوابة في الواجهة) —
  فلا يُطفئ شاراتهم ولا يعرض للمرسل ✓✓ كاذبة.
- **إشعار المستخدم الجديد يبقى الإشعار الجماعي الوحيد**: نوع مستقل `new_user` بمستلم `null`، بوسم
  `category: admin_broadcast`، ولا يقبل مستلماً فردياً، ولا يتقاطع مع مساري الرسائل والمكالمات.
- **تشخيص**: `push_diagnostics()` يعرض `isolation_version` و`isolation_gate` و`recipient_isolation`
  و`skipped_total` و`super_admin_silenced`.
- **اختبارات**: `npm run test:isolation` (منطق + مصادر) و`npm run test:sql:v29`
  (تنفيذ الهجرة على PostgreSQL حقيقي: 66 فحصاً) — وكلاهما ضمن `npm test`.

## الإصدار v2.11 — تدقيق الأمان وتشديد RLS ومراجعة الإنتاج

الهجرة: `sql/migrations/2026-10-14_v2_11_security_hardening.sql` (مطابقة لما في `sql/schema.sql`).
للقواعد القائمة: نفّذ الهجرة في SQL Editor، ثم أعد نشر `supabase/functions/agora-token` و`send-push`.

- **لا مفاتيح ثابتة في SQL**: مسار التريگرات (v2.15) يحمل الرابط العام فقط مُضمَّناً في `trigger_send_push_notification`
  (`https://gqocavvhkfzgxzscrjms.supabase.co/functions/v1/send-push`)، ولا مفاتيح JWT في أي ملف SQL. التحقّق الفعلي عبر
  `x-send-push-secret` داخل الدالة (منشورة بـ `verify_jwt = false`)؛ السرّ يُضبط على الدالة ويُطابق ثابت `v_secret` في التريگر
  (بلا Vault — كان فكّ Vault يفشل فيرجع ciphertext ويسقط pg_net بـ `Couldn't resolve host name`).
- **المشرف العام = مراقب للقراءة فقط**: يرى المحادثات والرسائل والمكالمات، لكنه لا يكتب ولا يحذف ولا يحظر
  (السياسات `SELECT` فقط، والحظر/الحذف يرفضهما الخادم، وأزرارهما مخفية عنه). لا يصله أي إشعار.
- **لا RPC للزوار** وسحب الدوال الداخلية (تنظيف المكالمات، توزيع الإشعارات، قائمة المشرفين) من `anon` و`authenticated`.
- **التخزين**: لا سياسة سرد عامة على المرفقات/الصور (الروابط العامة للحاويات تعمل كما هي).
- **توكن Agora مُقيَّد**: `agora-token` لا يُصدر توكناً إلا لطرف في المحادثة التي تُنتج القناة `wa_<conversationId>`، وغير المحظور.
- **Enter / Shift+Enter** في حقل الرسالة: Enter = سطر جديد، Shift+Enter = إرسال (ولا شيء عند الحقل الفارغ).
- **الاعتمادات**: `eslint` و`jsdom` صارا devDependencies، و`@electric-sql/pglite` صار devDependency مثبّتاً
  فتعمل اختبارات PostgreSQL فعلياً في `npm ci` (كانت تتخطّى صامتةً).
- **الاختبار**: `npm run test:rls` (تدقيق العزل والصلاحيات على PostgreSQL حقيقي) ضمن `npm test`.

## الإصدار v2.12 — (تاريخي) بوابة الإرسال عبر Cloudflare Worker

> **تنبيه:** هذا القسم يوثّق إصداراً سابقاً فقط؛ تم إلغاء وسيط Worker في v2.14. البنية الحالية وخطوات النشر الصحيحة أعلاه: `send-push → FCM HTTP v1` مباشرة.


الهجرة: `sql/migrations/2026-10-15_v2_12_push_gateway_worker.sql` (مطابقة لما في `sql/schema.sql` §18).
النشر: `supabase functions deploy send-push` بعد ضبط أسرار البوابة (انظر قسم النشر أعلاه).

- **التعديل المعماري**: الاتصال المباشر بـ FCM وتوليد توكنات Google OAuth2/JWT
  (`getFirebaseAccessToken` و `sendToFcm` واعتماد `jose` وحساب الخدمة) أُزيلت من
  `send-push` وانتقلت إلى Cloudflare Worker:
  `https://nameless-dew-aac1.aabntlal680.workers.dev/`.
- **`send-push` = Business Logic & Security Guard**: كل قواعد v2.9/v2.10 كما هي
  (عزل المستلم عبر صف المحادثة، مصدر الحقيقة `call_rooms`، حارس «ringing» ونافذة
  الدقيقتين، إشعار المشرفين `new_user`، تعدد الأجهزة، حذف التوكنات الميتة، تعليم
  `delivered`).
- **الـ Worker = Gateway/Proxy**: يستقبل لكل جهاز POST بالشكل
  `{ token, title, body, data }` (+ تلميحا `priority`/`ttlSeconds`) مع
  `Authorization: Bearer <PUSH_GATEWAY_SECRET>` و`x-send-push-secret`.
- **إعادة المحاولة** (429/5xx/شبكة) كما هي، وحذف التوكن الميت أصارم: 410 أو نص
  رفض FCM صريح — لم نعد نعتبر 404 وحدها دليلاً (404 من مسار خاطئ في الـ Worker
  لا يجوز أن يحذف كل التوكنات).
- **⛔ حارس الحلقة**: رابط بوابة يحوي `/functions/v1/` يُرفض عند الإقلاع — حماية
  من توجيه الدالة إلى نفسها (إشعارات لا نهائية).
- **`push_gateway_check()`**: دالة تشخيص جديدة تعيد أعلام الإعداد وتحذّر صراحة
  إن وُجّه Vault `SEND_PUSH_URL` إلى `workers.dev` (تجاوز طبقة الأمان).
- **الاختبار**: `npm run test:gateway` (فحوص ثابتة + تنفيذ الهجرة على PGlite) ضمن `npm test`.
- **اختبار تشغيلي فعلي** (اختياري، يتطلب Deno): `npm run test:gateway:runtime` يشغّل
  ملف `send-push/index.ts` الحقيقي ضد محاكي Worker وعميل Supabase وهمي ويتحقق من عقد
  الطلب `{token,title,body,data}` والترويستين وحراس العزل وحذف التوكن الميت وحارس الحلقة.

## الإصدار v2.14 — FCM مباشر + دعم مفاتيح Supabase الجديدة

الهجرة: `sql/migrations/2026-10-18_v2_14_push_auth_key_compat.sql`.
- أزيل اعتماد الإرسال الفعلي على Cloudflare Worker؛ Edge Function تنشئ OAuth2 access token بحساب الخدمة وترسل FCM HTTP v1 مباشرة.
- تضبط `android.priority`, `android.ttl`, و`webpush.headers.Urgency/TTL` في نفس الطلب؛ تُحفظ أخطاء FCM الأصلية بدلاً من أي رد 200 وسيط.
- `push_call_edge` يقبل JWT القديم أو `sb_publishable_*`/`sb_secret_*`: المفاتيح الجديدة تذهب في `apikey` فقط، ولا تُرسل كـ Bearer غير صالح. يبقى `x-send-push-secret` التحقق الداخلي.
- `firebase-messaging-sw.js` في المشروع الحالي يعالج push الخام data-only حتى عند غياب `env.js` أو فشل تحميل Firebase SDK؛ لا حاجة لاستبداله بالنسخة المرفقة الأقدم.

## الإصدار v2.13 — كتابة كاملة للمشرف العام + إصلاح إغراق حالة الكتابة

الهجرة: `sql/migrations/2026-10-15_v2_13_super_admin_full_write.sql` (مطابقة لما في `sql/schema.sql` §19).
التنفيذ: SQL Editor ثم تحديث الصفحة (لا إعادة نشر دوال مطلوبة — تعديل الواجهة ضمن `app.js`).

### 1) صلاحيات المشرف العام (إلغاء قصر v2.11 على القراءة — للمحادثات والرسائل فقط)
- سياسات RLS جديدة (`FOR ALL` مقيّدة بـ `is_super_admin_user()`): `conversations write superadmin`
  و`messages write superadmin` و`typing full access superadmin` و`reactions full access superadmin` —
  يردّ المشرف العام على أي محادثة (حتى بين مستخدم ومشرف آخر) بلا أي 403.
- **توجيه الإشعار**: `conversation_direct_recipient` و`push_recipient_allowed` (والـ Edge Function
  `send-push` عبر `conversationCounterpart` بوسيطة `senderIsSuperAdmin`) تسمح بردّه وتوجّه
  الإشعار إلى **المستخدم صاحب المحادثة** حصراً — أطراف المحادثات الأصلية كما هم.
- يبقى قراءة فقط: المكالمات (`call_rooms`/`call_logs`) وإدارة المستخدمين (حظر/حذف)
  وحالة قراءة/تسليم المحادثات المراقَبة (وضع v2.9 الصامت). حماية العبث بالرسائل باقية.
- الفحوص السلوكية على PostgreSQL: القسم 3 في `tests/rls-hardening-postgres.mjs`،
  والفحوص الثابتة: `npm run test:super-admin`.

### 2) حالة الكتابة (Typing Indicator) — Debounce جذري في `js/app.js`
- **المشكلة السابقة**: كل حرف كان يُطلق upsert فوري إلى `typing_status` + مؤقت توقيف 2 ثانية
  — إغراق شبكي يملأ الكونسول بأخطاء `[safety] setTyping` ويستنزف الموارد.
- **الحل**: طلب واحد عند بدء التدفق (`typingActive` guard) + تجديد مقيّد (كل 8 ثوانٍ
  كحد أقصى) للجلسات الطويلة + مؤقت توقيف واحد يُلغى ويُعاد بـ `clearTimeout` مع كل
  حرف ولا يُرسل «توقفت عن الكتابة» إلا بعد **سكون > 3 ثوانٍ متواصلة**
  (`TYPING_STOP_DEBOUNCE_MS = 3000`).
- **cancelTypingTimers()** تُلغى المؤقتات في كل مسارات الخروج (بعد الإرسال، إغلاق
  المحادثة، تبديل الاشتراك، تفكيك القنوات) — فلا يطلق مؤقت قديم كتابةً في محادثة خاطئة.
- **حارس الالتصاق لدى المستقبِل**: إن توقف المرسل دون إرسال «توقفت» (إغلاق تبويب/انقطاع)
  يُخفى «يكتب الآن» تلقائياً بعد 12 ثانية بلا تحديث.
- الفحوص: `npm run test:typing` (ضمن `npm test`).

## الإصدار v2.15 — تضمين رابط/سرّ send-push في مسار التريگرات (إصلاح "Couldn't resolve host name")

الهجرة: `sql/migrations/2026-10-21_v2_15_hardcoded_send_push_endpoint.sql` (مطابقة لما في `sql/schema.sql` §21).

- **المشكلة**: فشل تسليم الإشعارات في الخلفية بخطأ `Couldn't resolve host name` من `pg_net.http_post`
  داخل تريگرات `messages`/`call_rooms`/`profiles`: قراءة `SEND_PUSH_URL` (والسرّ) من
  `vault.decrypted_secrets`/`vault.secrets` كانت تُرجِع نصاً مشفّراً أو تفشل فكّ التشفير
  (pgsodium session) ⇒ pg_net يستقبل نصاً غير صالح كـ URL ⇒ فشل DNS. وأي مسبار تشخيص يعتمد
  على Vault يفشل بنفس السبب.
- **الحل**: دالة `trigger_send_push_notification()` تحمل الرابط العام
  `https://gqocavvhkfzgxzscrjms.supabase.co/functions/v1/send-push` وثابت `v_secret`
  (يُرسل في `x-send-push-secret`) **مُضمَّنين مباشرةً** — بلا أي قراءة من Vault.
  الرابط ليس سرّاً (الدالة عامة على البوابة ومُنشورة بـ `verify_jwt = false`).
- **تغطية المستودع كاملةً**: استُبدلت كل قراءات Vault في مسار الإشعارات — في
  `sql/schema.sql` وفي كل هجرة (`v2.1` … `v2.15`): تريگرات الرسائل والمكالمات
  والمستخدم الجديد، `push_call_edge`، ودوال التشخيص `push_diagnostics` /
  `push_gateway_check` / `push_probe` / `push_probe_result`. صفر مراجع
  `vault.decrypted_secrets`/`vault.secrets` في أي كود SQL، وفروع «SKIPPED: … Vault»
  أُزيلت لأن القيم مُضمَّنة لا يُفترض أن تكون فارغة.
- **الواجهة**: تقرير «إرسال إشعار تجريبي» في `js/app.js` صار يفحص الرابط والسرّ
  المُضمَّنين (`push_diagnostics` ⇒ `edge_function_url`/`secret_hardcoded`/
  `vault_dependency=false`، و`push_gateway_check` قبل المسبار) بدل توقّع سجلات Vault.
- **⚠️ السرّ**: ثابت `v_secret` داخل `trigger_send_push_notification` يجب أن يطابق تماماً
  `SEND_PUSH_SECRET` المضبوط على دالة `send-push` (Edge Function Secrets)، وإلا رُدّت
  الطلبات بـ 401. القيمة المعتمدة الآن: `my_send_push_19921121_almgawell_19921121`.
  لتغييره: عدّل الثابت داخل الدالة (و`sql/schema.sql`) ثم أعد تنفيذ الهجرة.
- **التوافق**: `push_call_edge` تبقى بنفس التوقيع وتفوّض إلى `trigger_send_push_notification`
  (notify_new_message / notify_call_room / notify_admins_new_profile / push_probe كما هي)،
  والبوابة المركزية `push_recipient_allowed` (عزل v2.9) تعمل قبل أي نداء شبكة.
- **pg_net**: الهجرة تضمن `create extension if not exists pg_net` (محاطاً بحاجز)، و`net.http_post`
  **غير متزامن**: يعيد `request_id` فوراً والرد يُقرأ لاحقاً من `net._http_response` عبر
  `push_probe_result` — إدراج الرسالة/المكالمة لا ينتظر الشبكة ولا يتأثر بفكّ Vault.
  الهجرة أيضاً تضمن وجود تريگر `on_message_inserted` على `messages`.
- **التشخيص**: `push_diagnostics()` يعلن `edge_function_url` و`edge_url_ok` و`vault_dependency=false`
  و`secret_hardcoded=true` (بلا قراءة Vault)، و`push_gateway_check()` يفحص الرابط المُضمَّن،
  و`push_probe` يعمل بلا Vault.
- **الاختبارات**: `npm run test:push-trigger` (مسار التريگر كامل على PGlite بجدول Vault فارغ:
  INSERT على messages ⇒ net.http_post بالرابط المُضمَّن + صفر قراءات Vault + الرد غير المتزامن)،
  و`npm run test:gateway` (الرابط والثابت من الكود لا من Vault)، ضمن `npm test`.
  فحوص إضافية تتأكّد أن **كل** ملف SQL في المستودع خالٍ من مراجع Vault في الكود، وأن
  السرّ المُضمَّن هو القيمة المعتمدة بالضبط (`my_send_push_19921121_almgawell_19921121`).

## الإصدار v2.16 — تثبيت مسار الإشعارات في القاعدة الحيّة + تشخيص لا يكذب

الهجرة: `sql/migrations/2026-10-22_v2_16_send_push_live_state.sql` (مطابقة لما في `sql/schema.sql` §22).

- **المشكلة**: قواعد حيّة متأخرة بقيت على **أجسام الدوال القديمة** (القائمة على Vault) من
  v2.12/v2.14، بينما `push_diagnostics` محدَّث (v2.15) ⇒ التقرير يقول «مسار سليم /
  اعتماد Vault معدوم» بينما مسار الإرسال الفعلي يفشل:
  - `push_gateway_check` (الجسم القديم: `search_path` فيه Vault) يرمي استثناءً عند التنفيذ
    ⇒ خطأ RPC ⇒ «دالة غير متاحة» في الواجهة.
  - `push_call_edge` (الجسم القديم) يقرأ `SEND_PUSH_URL` من `vault.decrypted_secrets`
    ⇒ يستقبل `pg_net` نصاً مشفّراً كـ URL ⇒ `Couldn't resolve host name`.
  - **السبب**: المشروع يطبّق SQL يدوياً من SQL Editor، و`create or replace function` =
    آخر كاتب يفوز **لكل دالة على حدة** ⇒ إعادة تشغيل ملف قديم بعد v2.15 تُرجع أجسام
    Vault القديمة وتترك دوال التشخيص الحديثة مكانها.
- **الحل (v2.16) — ملف واحد يفعل ثلاث أشياء**:
  1. **يُعيد تعريف كل دوال مسار الإشعارات** بالرابط والسرّ المُضمَّنين
     (`trigger_send_push_notification` · `push_call_edge` · `push_diagnostics` ·
     `push_probe` · `push_probe_result` · `push_gateway_check`) — `create or replace`
     ⇒ آمن لإعادة التنفيذ ويُصلح أي قاعدة متأخرة.
  2. **`push_diagnostics` يفحص الجسم الحيّ** (`pg_proc.prosrc`) بدل إرجاع ثوابت، ويُعلن:
     - `live_path_vault_free` — لا دالة في المسار تقرأ Vault.
     - `live_path_secret_ok` — جسم `trigger_send_push_notification` فيه السرّ المعتمد.
     - `live_path_url_ok` — جسمها فيه الرابط الصحيح.
     - `live_path_stale` — `true` ⇒ القاعدة متأخرة ⇒ أعد تنفيذ هذه الهجرة.
     - `live_path_functions` — تفصيل لكل دالة.
     و`secret_hardcoded` / `vault_dependency` / `edge_url_ok` صارت تعكس **الحالة الحيّة**
     (وليس ما يقرّره التشخيص عن نفسه).
  3. **`push_egress_check()` جديد**: يفحص `pg_net ← DNS ← send-push` **مباشرةً** متجاوزاً
     كل دوال المسار — يميّز بين «جسم دالة قديم» (يُصلحه هذا الملف) و«مخرج الشبكة (egress)
     للمشروع مقيّد أو DNS معطّل» (لا علاقة له بالكود).
- **`push_probe_result` صار يُفسّر**: يميّز `dns_error` (فشل تحليل المضيف) عن 401/404
  ويعطي `hint` يشرح السبب والخطوة التالية.
- **الواجهة**: تقرير «إرسال إشعار تجريبي» يعرض سطراً أحمر عند `live_path_stale = true`
  («مسار الإرسال في القاعدة قديم») بدل أن يقول «سليم»، ويشغّل `push_egress_check` بعد
  المسبار.
- **تطبيقها**: نفّذ `sql/migrations/2026-10-22_v2_16_send_push_live_state.sql` في SQL Editor
  (أو `sql/schema.sql` كاملاً). آمنة لإعادة التنفيذ.
- **التحقّق بعد التطبيق**:
  ```sql
  select public.push_diagnostics();
  -- live_path_stale = false، live_path_vault_free = true، live_path_secret_ok = true
  ```
  ولو بقي `live_path_stale = true` فالقاعدة متأخرة — أعد تنفيذ الملف.
- **تذكير**: يجب أن يطابق `SEND_PUSH_SECRET` على دالة `send-push` السرّ المُضمَّن تماماً،
  وإلا رُدّت طلبات `pg_net` بـ 401:
  ```
  supabase secrets set SEND_PUSH_SECRET=my_send_push_19921121_almgawell_19921121
  ```

---

## الإصدار v2.17 — نقطة تسليم قابلة للتهيئة + تشخيص شبكة القاعدة (الحلّ الجذري)

الهجرة: `sql/migrations/2026-10-23_v2_17_push_delivery_endpoint_and_net_diagnostics.sql`
(مطابقة لما في `sql/schema.sql` §23) — آمنة لإعادة التنفيذ.

### التشخيص الذي أعطاه v2.16 (ولم يُحلَّق)

بعد تطبيق v2.16 وتأكّده في القاعدة الحيّة، بقي الخطأ نفسه:
`Couldn't resolve host name` — **حتى عبر `push_egress_check()` الذي يستدعي الرابط الحرفي
مباشرةً** ⇒ الكود سليم، والعطل **شبكي داخل حاوية القاعدة** (DNS/مخرج).

- **لا يوجد نقل بديل داخل القاعدة**: `supabase_functions.http_request` (المستخدم في
  Database Webhooks) ليس مساراً مستقلاً — هو `RETURNS trigger` يستدعي `net.http_get`/
  `net.http_post` داخلياً ⇒ **نفس مسار DNS تماماً**. لذلك لا يمكن "تجاوز" المشكلة
  بدالة SQL أخرى.
- **الخارج الوحيد المتاح**: تغيير **الوجهة** (destination) إلى مضيف تصل إليه القاعدة.

### ما تضيفه v2.17

1. **نقطة تسليم قابلة للتهيئة وقت التشغيل** — بلا هجرة جديدة عند تغيير الوجهة:
   - `public.push_settings` (صفّ واحد، RLS مفعّل بلا سياسات ⇒ لا أحد يقرؤه من الخارج
     إلا `service_role`).
   - `public.push_delivery_url()` ⇒ ترجع الرابط المُضمَّن افتراضياً أو ما هو مضبوط.
   - `public.push_set_delivery_url(text)` ⇒ **service_role فقط** (SQL Editor)، ويقبل
     `https://` فقط.
   - `trigger_send_push_notification` و`push_call_edge` صارا **يقرآن** نقطة التسليم
     بدل الرابط الثابت ⇒ تغيير الوجهة يسري فوراً.
2. **تشخيص شبكة القاعدة** — `public.push_net_diagnostics()` يُطلق 4 مسبارات ويكشف
   **أي مضيفات تصل إليها القاعدة فعلاً**:
   | المسبار | الوجهة | ماذا يعني |
   |---|---|---|
   | `function` | رابط `send-push` | المسار الطبيعي يعمل؟ |
   | `legacy` | `functions.supabase.co` | نطاق بديل داخل Supabase |
   | `public` | `example.com` | هل DNS/Egress يعمل عموماً؟ |
   | `cloudflare` | `cloudflare.com` | هل نطاق Cloudflare متاح (⇒ بوابة Worker ممكنة)؟ |
   النتيجة تُقرأ لاحقاً: `select public.push_probe_result(<request_id>);`
3. **بوابة تسليم بديلة جاهزة للنشر** — `worker/send-push-relay.js` (Cloudflare Worker)
   يمرّر الطلب إلى دالة `send-push` بعد التحقّق من `x-send-push-secret`.

### خطوات التشغيل (بعد تطبيق الهجرة)

```sql
-- ① طبّق ملف الهجرة في SQL Editor:
--    sql/migrations/2026-10-23_v2_17_push_delivery_endpoint_and_net_diagnostics.sql

-- ② شغّل تشخيص الشبكة (يسجّل 4 طلبات في net.calls)
select public.push_net_diagnostics();

-- ③ اقرأ نتيجة كل مسبار (بعد ثوانٍ)
select public.push_probe_result(<request_id>);
```

**ثم حسب النتيجة:**

- **`function` ناجح (status_code > 0)** ⇒ المسار سليم — أعد اختبار الإشعار من التطبيق.
- **`function` فاشل + `public` أو `cloudflare` ناجح** ⇒ القاعدة تصل إلى الإنترنت لكن
  **لا** إلى `*.supabase.co` ⇒ انشر البوابة البديلة (الخطوات أدناه).
- **كل المسبارات فاشلة** ⇒ مخرج الشبكة (egress) مقيّد في المشروع ⇒ راجع
  Supabase Dashboard ← Project Settings ← **Network / Restrict egress** (أو تواصل مع دعم
  Supabase) — لا علاقة للكود هنا.

### نشر البوابة البديلة (Cloudflare Worker) — متى تكون ضرورية

```bash
cd worker
npx wrangler deploy
npx wrangler secret put SEND_PUSH_SECRET   # my_send_push_19921121_almgawell_19921121
npx wrangler secret put SEND_PUSH_URL      # https://gqocavvhkfzgxzscrjms.supabase.co/functions/v1/send-push
```

ثم وجّه القاعدة إليها (SQL Editor أو `service_role`):

```sql
select public.push_set_delivery_url('https://<اسم-الـ-worker>.workers.dev/');
-- للعودة إلى النمط:  select public.push_set_delivery_url(null);
```

- الرابط والسرّ يبقىان **مُضمَّنين بلا Vault** كما هي ⇒ لا شيء يتغيّر في سياسة الأسرار.
- البوابة **لا تمرّر** ترويسة `Authorization` القادمة من القاعدة (تبني ترويساتها من سرّها)
  ⇒ لا حاجة إلى `apikey`/JWT في القاعدة.
- `worker/send-push-relay.js` مُغطّى باختبار `tests/push-relay-worker.mjs`
  (401 بلا سرّ/بسرّ خاطئ، تمرير صحيح، لا تسريب للسرّ).

---

## الإصدار v2.18 — الحكم الحاسم على مسار التسليم + إصلاح ذاتي كامل

الهجرة: `sql/migrations/2026-10-24_v2_18_push_path_verdict_and_self_healing.sql`
(مطابقة لما في `sql/schema.sql` §24) — آمنة لإعادة التنفيذ.

### ما كشفه v2.17 في القاعدة الحيّة (نتيجة حقيقية)

| المسبار | النتيجة |
|---|---|
| `*.supabase.co/functions/v1/send-push` | ❌ `Couldn't resolve host name` |
| `example.com` | ✅ تصل |
| `cloudflare.com` | ✅ تصل |
| `*.functions.supabase.co` | ✅ تصل |

⇒ **القاعدة تصل إلى الإنترنت، لكن نطاق `*.supabase.co` تحديداً غير قابل للوصول منها.**
العطل في نطاق دوال EdgeFunctions لهذا المشروع — لا في الكود ولا في السرّ ولا في Vault.

### ما يضيفه v2.18

1. **إصلاح ذاتي حقيقي**: يحذف **كل** نسخ دوال المسار (أي توقيع) ثم يُنشئها من جديد
   (`drop` + `create` بدل `create or replace`). السبب: `create or replace` **يفشل**
   إذا اختلف نوع الإرجاع/التوقيع ⇒ عندها يتوقّف تنفيذ الملف عند تلك العبارة وتبقى
   الدوال القديمة (وهو ما كان يُسقط `push_gateway_check` في القاعدة الحيّة). الآن
   **مهما كانت حالة القاعدة،become النتيجة هي الملف الصحيح كاملاً**.
2. **مسبار حاسم**: `push_probe_endpoint(url)` يرسل **POST حقيقياً** بصيغة send-push
   مع `x-send-push-secret` ⇒ `status_code = 200` = «هذه الوجهة تخدم الدالة والسرّ
   مطابق» (لا يكفي أن يُحلَّل اسم المضيف).
3. **حكم شامل في نداء واحد**: `push_path_verdict()` يفحص كل المرشّحين بالتوازي
   (primary · legacy · current) + مسبار عام (`example.com`) ويُرجع:
   - `candidates[]` — لكل مرشّح: `status_code` · `dns_error` · `works` · `hint`
   - `internet_reachable` — هل يعمل DNS عموماً من القاعدة؟
   - `best_url` — الوجهة التي تعمل
   - `verdict` — حكم جاهز بالعربية.
4. **تحويل تلقائي**: `push_path_verdict(true)` يحوّل نقطة التسليم إلى `best_url`
   (الأولوية: `primary` ← `legacy` ← `current`) — **لخدمة فقط**
   (`service_role` أو جلسة SQL Editor)؛ أي مستخدم مصادَق يقرأ الحكم دون تغيير.
5. `push_diagnostics` صار يكشف **الدوال الناقصة** (`live_path_missing`) فلا يقول
   «سليم» مع دالة غائبة، و`push_gateway_check` صار يعمل ويُظهر وجهة التسليم.

### التشغيل (بعد تطبيق الملف)

```sql
-- ① الحكم (قراءة فقط)
select public.push_path_verdict();

-- ② التحويل إلى الوجهة العاملة (سطر واحد — يكفي!)
select public.push_path_verdict(true);

-- ③ تحقّق
select public.push_diagnostics();   -- delivery_url / delivery_overridden
```

**قراءة النتيجة:**

| `verdict` | المعنى | الخطوة |
|---|---|---|
| `best_url` = legacy | النطاق القديم يخدم الدالة | تم التحويل تلقائياً — تحقّق من الإشعار |
| `best_url` = null و`internet_reachable` = true | الإنترنت يعمل لكن `*.supabase.co` لا | انشر بوابة بديلة (§أدناه) |
| `internet_reachable` = false | لا مضيف أصلاً | Project Settings ← Network ← Restrict egress |

### بوابة بديلة (عند عدم نفع النطاق القديم)

```bash
cd worker
npx wrangler deploy
npx wrangler secret put SEND_PUSH_SECRET   # my_send_push_19921121_almgawell_19921121
npx wrangler secret put SEND_PUSH_URL      # https://gqocavvhkfzgxzscrjms.supabase.co/functions/v1/send-push
```

```sql
select public.push_set_delivery_url('https://<worker>.workers.dev/');
-- ثم تحقّق:
select public.push_path_verdict();
```

> بعد النشر، `push_path_verdict` يجرّب الوجهة الجديدة تلقائياً (وهي `current`).

---

## الإصدار v2.19 — وضع العميل: إلغاء كل اتصال شبكي من قاعدة البيانات

الهجرة: `sql/migrations/2026-10-25_v2_19_client_side_push_mode.sql`
(مطابقة لما في `sql/schema.sql` §25) — آمنة لإعادة التنفيذ.

### لماذا إعادة هيكلة كاملة

تشخيص v2.18 أثبت أن حاوية القاعدة في هذا المشروع **معزولة شبكياً بالكامل**:
`pg_net` لا يستطيع حتى تحليل أسماء المضيفات (`Couldn't resolve host name`)، بينما
`example.com` و`cloudflare.com` تصل ⇒ **العطل في نطاق الدالة لا في DNS العام**،
و`supabase_functions.http_request` غلافٌ حول `net.http_post` (نفس المسار) ⇒
**لا يوجد أي نقل بديل من القاعدة**.

⇒ إذن: **المسار الوحيد المتبقي هو الواجهة (المتصفّح)** — لا القاعدة.

### البنية الجديدة

```
INSERT في messages
   └─ Supabase Realtime ──► متصفّح المُرسِل ──fetch (Authorization: Bearer <JWT>)──►
        Edge Function send-push  (type: client_message)
             └─ تحقّق على الخادم: المُرسِل = صاحب الرمز، المستلَم يُشتقّ من المحادثة
                  └─ FCM HTTP v1 ──► جهاز المستلِم ──Service Worker──► إشعار
```

| الطبقة | التغيير |
|---|---|
| **القاعدة** | `push_settings.push_mode = 'client'` (افتراضي) ⇒ التريغرات **لا تُجري أي طلب شبكة إطلاقاً** (لا `net.http_post`، لا DNS، لا مهل) — تُسجّل النيّة في `push_delivery_log` فقط. **الجداول وسياسات RLS لم تتغيّر إطلاقاً.** |
| **التراجع** | `select public.push_set_mode('db');` ⇒ يعود السلوك القديم (بلا هجرة جديدة) — مفيد إن تغيّر عزل الشبكة لاحقاً. |
| **Edge Function** | مسارات `client_message` · `client_call` · `client_new_user` · `client_probe` — **مصادقة برمز المستخدم (JWT)** لا بالسرّ المشترك. الخادم يُثبّت المُرسِل/المتصل من الرمز (لا يُقبل من العميل) ⇒ لا impersonation. |
| **الواجهة** | `js/clientPush.js` + ربطها بأحداث Realtime (رسالة / مكالمة / مستخدم جديد). |
| **التشخيص** | فحص **اتصال المتصفح بالدالة** (`client_probe`) بدل فحص شبكة القاعدة؛ ويعلن `push_mode`. |

### 🔐 المصادقة من الواجهة: رمز المستخدم **و** السرّ المشترك (اختياري)

طلبك كان «تمرير السرّ ومصادقة المستخدم من الواجهة» — وهذا **مُنفَّذ بالكامل**،
مع ترتيب للمصداقية:

| الطريقة | كيف تُستخدم | القوة |
|---|---|---|
| **رمز المستخدم (JWT)** — الافتراضية | المتصفح يرسل `Authorization: Bearer <رمز الجلسة>` | ✅ الأقوى: الخادم يُثبّت المُرسِل = صاحب الرمز |
| **السرّ المشترك** — اختياري | `VITE_SEND_PUSH_SECRET` ⇒ تُرسَل ترويسة `x-send-push-secret` | متوافق مع طلبك؛ يُستخدم إن كان المالك يريده |

- في **الطرفين** يبقى المُرسِل/المتصل **مُشتقّاً من سجلّ القاعدة** (رسالة/غرفة
  مكالمة) — لا يُقرأ من جسم الطلب أبداً ⇒ لا انتحال في الحالتين.
- **الموصى به**: اترك `VITE_SEND_PUSH_SECRET` فارغاً ⇒ لا سرّ في المتصفح إطلاقاً،
  والمصادقة برمز المستخدم وحده.
- السرّ موجود أصلاً في ملفات SQL داخل المستودع ⇒ نشره في الواجهة لا يضيف حماية
  حقيقية (فهو معلن عملياً)، ولذلك جُعل **اختيارياً** لا إجبارياً.

### التبديل بين الوضعين

```sql
select public.push_mode();          -- 'client' (افتراضي) | 'db'
select public.push_set_mode('db');   -- تراجع: القاعدة ترسل عبر pg_net (service_role / SQL Editor)
select public.push_set_mode('client');
```

### ملاحظة تشغيلية

في وضع العميل، **من يطلق الإشعار هو جهاز المُرسِل** (يرصد الحدث عبر Realtime).
إن كان تطبيق المُرسِل مغلقاً تماماً فلا مُطلِق ⇒ لا إشعار. منع التكرار مضمون:
`send-push` يتجاهل `message_id` المكرّر، والواجهة تتجاهل الرسالة نفسها محلياً.
