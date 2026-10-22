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

### آلية العمل الحالية (تريگرات قاعدة البيانات البسيطة + `pg_net` — بلا Webhook يدوي وبلا Vault)
- **تفعيل تلقائي بالكامل من داخل SQL**: امتداد `pg_net` مفعّل في المخطط العام (`Async HTTP`)،
  وتريگر `send_fcm_on_new_message` على جدول `messages` يستدعي دالة
  `handle_new_message_notification` (مع وجود `handle_new_message_push` و`notify_new_message`
  للتوافق الكامل مع إعدادات المشروع العامل)، بالإضافة إلى تريگر `on_call_room_notify` على
  `call_rooms` وتريگر `on_profile_created_notify_admins` على `profiles`.
- **لا حاجة لإنشاء Database Webhooks يدوياً** من لوحة تحكم Supabase، ولا حاجة لـ Supabase Vault.
- **الرابط الصحيح לדالة المشروع**: `https://gqocavvhhfwgkzscrjms.supabase.co/functions/v1/send-push`
  (تم إصلاح الخطأ الإملائي القديم `gqocavvhkfzgxzscrjms` الذي كان يسبّب فشل DNS `Couldn't resolve host name`).
- `supabase/functions/send-push/index.ts` هي **الجهة الوحيدة** التي تفهم الحدث وتختار
  المستلم وتتحدث مع FCM. لا تثق بأي `recipient_id` قادم من الحمولة (تعارض ⇒ 409).
- `supabase/functions/send-push/recipients.ts` تحمل قواعد العزل النقية: رسالة ⇒ الطرف الآخر
  في نفس صف المحادثة، رنين ⇒ `callee_id` فقط وخلال نافذة دقيقتين، مستخدم جديد ⇒ المشرفون فقط.
- `supabase/functions/send-push/webhook.ts` تُطبِّع الحمولة (سواء من تريگر `pg_net` القياسي أو
  الحمولة المسطّحة البسيطة `{ message_id, conversation_id, sender_id, content }`) وتتجاهل ما لا يخصّها.
- `js/push.js`: يهيّئ Firebase SDK، يطلب الإذن، ويسجّل `firebase-messaging-sw.js`،
  ويرسل **إشعاراً تجريبياً/تشخيصاً فقط** (`type: "test"` / `type: "diagnostics"`).
- `firebase-messaging-sw.js`: مستمع `push` الخام هو المسؤول الوحيد عن الإشعار في
  الخلفية؛ يقرأ `data` ويعرضه عبر `registration.showNotification()`.
- كل جهاز/متصفح له صف مستقل في `fcm_tokens`، وتقرأ الدالة التوكنات وتحذف الميت منها
  بـ `service_role`.
- كل حدث يُسجَّل في `push_delivery_log` (يكتبه الـ Edge Function وحده) — وهو مصدر
  التشخيص الحقيقي: `select * from public.push_delivery_log order by created_at desc limit 20;`

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
الاختبار التجريبي يختبر **الجلسة → Edge Function → FCM** فقط، ولا يلمس الـ Webhook.
للتشخيص الكامل استخدم زر «اختبار الإشعارات» في التطبيق أو:

```bash
curl -s https://<project-ref>.supabase.co/functions/v1/send-push \
  -H "apikey: $SUPABASE_ANON_KEY" \
  -H "Authorization: Bearer $USER_JWT" \
  -H "Content-Type: application/json" \
  -d '{"type":"diagnostics"}'
```

يعيد التقرير:
- `database_notifications`: `{ pg_net: false, vault: false, db_triggers: false }` — أي اعتماد
  على القاعدة في الإشعارات يجب أن يكون صفراً.
- `webhook.expected_hooks`: الجداول والأحداث الثلاثة المتوقَّعة، و`secret_configured`.
- `me.devices`: عدد أجهزة حسابك المسجّلة.
- `delivery_log.recent` + `checks.webhook_flow_observed`: هل وصل حدث Webhook فعلاً؟
  إن كانت `false` فالـ Webhook غير مُنشأ أو يشير إلى رابط/سرّ خاطئ.

ثم:
1. راجع `push_delivery_log`: صف جديد عند كل رسالة/مكالمة/تسجيل مستخدم.
2. افحص سجل Service Worker `[push-sw]`: `push received` يعني أن دفعة وصلت للمتصفح.
3. عند `sent=1/1` مع غياب `push received`، لا تعتبر FCM ACK دليلاً على الوصول؛ أعد
   تسجيل التوكن وتأكد أن التطبيق والدالة على نفس مشروع Firebase وVAPID.

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

### نشر Edge Function + ربط Database Webhook (الخطوة الحاسمة)

```
INSERT/UPDATE على messages | call_rooms | profiles
        │
        ▼  Supabase Database Webhook (لوحة التحكم)
POST https://<project-ref>.supabase.co/functions/v1/send-push
        │  x-send-push-secret: <SEND_PUSH_SECRET>
        ▼
Edge Function send-push  →  FCM HTTP v1  →  firebase-messaging-sw.js
```

**1) أسرار الدالة** (لا شيء منها في المستودع ولا في القاعدة):

```bash
supabase functions deploy send-push

supabase secrets set \
  SEND_PUSH_SECRET="$(openssl rand -hex 32)" \
  FIREBASE_SERVICE_ACCOUNT="$(cat /مسار-آمن/service-account.json)"
```

بدلاً من JSON كامل: `FIREBASE_PROJECT_ID` + `FIREBASE_CLIENT_EMAIL` +
`FIREBASE_PRIVATE_KEY`. اختياري: `PUSH_NORMAL_URGENCY=1` لتخفيض أولوية رسائل الدردشة
(الافتراضي `high`؛ المكالمات والاختبارات TTL 60 ثانية، والرسائل 24 ساعة).

`SUPABASE_URL` و`SUPABASE_SERVICE_ROLE_KEY` يوفّرهما Supabase تلقائياً لكل دالة.

**2) `supabase/config.toml`** — الدالة منشورة بـ `verify_jwt = false` لأن الـ Webhook لا
يحمل JWT مستخدم؛ المصادقة عبر ترويسة `x-send-push-secret` داخلياً.

**3) إنشاء الـ Webhooks من لوحة Supabase** (مرة واحدة):
`Database → Webhooks → Create a new hook` ثم أنشئ ثلاثة هوكات:

| الاسم | الجدول | الأحداث | النوع |
|---|---|---|---|
| `push_message` | `public.messages` | `INSERT` | Supabase Edge Function → `send-push` |
| `push_call` | `public.call_rooms` | `INSERT` + `UPDATE` | Supabase Edge Function → `send-push` |
| `push_signup` | `public.profiles` | `INSERT` | Supabase Edge Function → `send-push` |

- **الترويسة الإضافية (إلزامية):** `x-send-push-secret: <نفس SEND_PUSH_SECRET>`.
  بدونها تردّ الدالة 401، وتظهر في `push_delivery_log` بلا أي صف.
- إن استخدمت نوع **HTTP Request** بدل Edge Function، فالرابط:
  `https://<project-ref>.supabase.co/functions/v1/send-push` مع نفس الترويسة.
- الحمولة القياسية: `{ "type": "INSERT"|"UPDATE", "table": "...", "schema": "public",
  "record": {...}, "old_record": {...} }` — الدالة تستخرج المستلم من سجلّ المحادثة/الغرفة
  نفسه. لا تُضِف أي حقل مستلم في الحمولة.
- الـ Webhooks مستضافة سحابياً ⇒ **لا تحتاج `pg_net` ولا Vault ولا أي SQL**، وتعوّض عزل
  شبكة حاوية القاعدة الذي كان يسبب `Couldn't resolve host name`.

**4) تحقّق بعد الربط:**

```sql
select kind, source, sent, total, skipped, created_at
  from public.push_delivery_log order by created_at desc limit 20;
```

صف جديد بعد كل رسالة/مكالمة/تسجيل مستخدم = المسار الحيّ يعمل. للفحص الكامل من التطبيق:
زر «اختبار الإشعارات» في الإعدادات.

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
- **الإشعارات في الخلفية** — قائمة التحقق بعد النشر (v3.0):
  1. نفّذ `sql/schema.sql` (أو الهجرات بالترتيب) — لا تريگرات إشعارات ولا `pg_net`.
  2. أنشئ الـ Webhooks الثلاثة من **Database → Webhooks** في لوحة Supabase كما في القسم 7.
  3. انشر `send-push` بـ `verify_jwt = false` واضبط `SEND_PUSH_SECRET` + أسرار Firebase.
  4. من التطبيق: **🔔 إرسال إشعار تجريبي** ثم أغلق التطبيق — يجب أن يصل. إن لم يصل راجع
     `select * from push_delivery_log order by created_at desc`.
- اختبارات دخانية: `cd tests && npm i jsdom && node smoke.mjs user|admin|super`.

## الإصدار v2.2 — تشخيص الإشعارات + حذف المستخدم الشامل
- زر **🔔 إرسال إشعار تجريبي** يعرض تقريراً خطوة بخطوة (HTTPS، الإذن، Service Worker، إشعار محلي فوري، توكن FCM، ثم `send-push` → FCM)، ويليه تقرير التشخيص من الدالة (`type: "diagnostics"`) الذي يعلن حالة الـ Webhooks وسجل التسليم.
- **أسباب عدم وصول الإشعارات**: (أ) `send-push` غير منشورة (404) ⇒ `supabase functions deploy send-push`
  بـ `verify_jwt = false`؛ (ب) أسرار `SEND_PUSH_SECRET`/Firebase غير مضبوطة؛ (ج) الـ Webhooks الثلاثة
  غير مُنشأة في لوحة Supabase أو ترويسة `x-send-push-secret` لا تطابق السرّ (401).
- إشعار مرئي محلي عند وصول رسالة Realtime والتطبيق مفتوح في محادثة/تبويب آخر (لا يعتمد على FCM).
- `admin_delete_user`: متاح لكل مشرف (`is_admin` أو `is_super_admin`)، يحذف: التخزين (مرفقات/أفاتار/خلفيات)، التفاعلات، الرسائل، الكتابة، المكالمات وسجلاتها، المحادثات، توكنات FCM، الملف الشخصي، وحساب `auth.users`؛ ويعيد إحصاءات ما حُذف. `reply_to_id` أصبح `on delete set null` حتى لا يعيق الحذف.
- إجراءات الرسالة مخفية لكل الأدوار حتى النقر على الفقاعة.

## الإصدار v2.3 — جوانب الفقاعات، شارة المشرف المالك، سلاسة العدّادات، مسبار الخلفية
- **جانب الفقاعة حسب الفريق**: رسائل المشرفين/الإدارة كلها في جهة (`mine`)، ورسائل المستخدم العادي في الجهة الأخرى (`theirs`) — يشمل السوبر أدمن عند مشاهدة محادثة مشرف آخر (تظهر فقاعته بلون أفتح مع اسم المرسل).
- **شارة المشرف المالك** بجانب اسم المستخدم للسوبر أدمن (في القائمة ورأس المحادثة) مع احتياط إن فشل الـ join.
- **العدّادات**: تصفير فوري عند فتح المحادثة (قبل الشبكة)، تحديث موضعي لصف المحادثة بدل إعادة رسم القائمة، مزامنة التصفير بين الأجهزة، وإعادة اشتراك تلقائية عند انقطاع قناة Realtime.
- **مسبار مسار الخلفية** (v3.0): زر الإشعار التجريبي يعرض تقرير `diagnostics` من الدالة —
  `database_notifications { pg_net: false, vault: false, db_triggers: false }`، و`webhook.expected_hooks`،
  و`delivery_log.recent`. إن لم يظهر أي حدث Webhook فالمشكلة في إعداد اللوحة لا في القاعدة.

## الإصدار v2.9 — عزل إشعارات الرسائل والمكالمات + الوضع الصامت للمشرف العام

الهجرة: `sql/migrations/2026-10-13_v2_9_notification_recipient_isolation.sql` (مطابقة في `sql/schema.sql` §17)
— **دوال + Triggers + سياسات RLS فقط، بلا أي تغيير على الجداول أو أنواع البيانات**.

- **إشعار الرسالة = الطرف الآخر في نفس صف المحادثة** (`conversations.user_id` ⇄ `admin_id`).
  إن كان المرسل ليس طرفاً في المحادثة (مشاهدة/مراقبة المشرف العام) ⇒ لا إشعار لأي جهة،
  ويُسجَّل السبب في `push_delivery_log` بوسم `SKIPPED`.
- **رنين المكالمة = `call_rooms.callee_id` حصراً** — لا سوبر أدمن، ولا مشرفين، ولا أي حساب غير المعني
  (`incoming_call` عند الرنين و`call_ended` عند الفوات/الانتهاء).
- **بوابة مركزية** في `supabase/functions/send-push/recipients.ts`: تمنع أي إشعار لا يطابق الحدث
  **قبل** أي طلب إلى FCM (fail-closed)، وتتحقق من أن طرفي المكالمة هما طرفا المحادثة.
  (كانت `push_recipient_allowed()` داخل `push_call_edge()` في الجيل القديم — أُزيلت في v3.0.)
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
- **تشخيص**: نقطة `diagnostics` في الدالة تعرض `database_notifications` و`webhook.expected_hooks`
  و`delivery_log.recent` و`checks` — وكل حالات التخطي مسجّلة في `push_delivery_log.skipped`.
- **اختبارات**: `npm run test:isolation` (منطق + مصادر) و`npm run test:sql:v29`
  (تنفيذ الهجرة على PostgreSQL حقيقي: 66 فحصاً) — وكلاهما ضمن `npm test`.

## الإصدار v2.11 — تدقيق الأمان وتشديد RLS ومراجعة الإنتاج

الهجرة: `sql/migrations/2026-10-14_v2_11_security_hardening.sql` (مطابقة لما في `sql/schema.sql`).
للقواعد القائمة: نفّذ الهجرة في SQL Editor، ثم أعد نشر `supabase/functions/agora-token` و`send-push`.

- **لا مفاتيح ولا روابط إشعارات في SQL**: منذ v3.0 لا يحمل أي ملف SQL رابط send-push ولا سرّاً ولا أي
  قراءة من Vault. العنوان يُدخل مرة واحدة في لوحة Supabase (Database Webhook)، والسرّ في أسرار الدالة
  فقط، ويُتحقق منه عبر `x-send-push-secret` (الدالة منشورة بـ `verify_jwt = false`).
- **المشرف العام = مراقب للقراءة فقط**: يرى المحادثات والرسائل والمكالمات، لكنه لا يكتب ولا يحذف ولا يحظر
  (السياسات `SELECT` فقط، والحظر/الحذف يرفضهما الخادم، وأزرارهما مخفية عنه). لا يصله أي إشعار.
- **لا RPC للزوار** وسحب الدوال الداخلية (تنظيف المكالمات، توزيع الإشعارات، قائمة المشرفين) من `anon` و`authenticated`.
- **التخزين**: لا سياسة سرد عامة على المرفقات/الصور (الروابط العامة للحاويات تعمل كما هي).
- **توكن Agora مُقيَّد**: `agora-token` لا يُصدر توكناً إلا لطرف في المحادثة التي تُنتج القناة `wa_<conversationId>`، وغير المحظور.
- **Enter / Shift+Enter** في حقل الرسالة: Enter = سطر جديد، Shift+Enter = إرسال (ولا شيء عند الحقل الفارغ).
- **الاعتمادات**: `eslint` و`jsdom` صارا devDependencies، و`@electric-sql/pglite` صار devDependency مثبّتاً
  فتعمل اختبارات PostgreSQL فعلياً في `npm ci` (كانت تتخطّى صامتةً).
- **الاختبار**: `npm run test:rls` (تدقيق العزل والصلاحيات على PostgreSQL حقيقي) ضمن `npm test`.

## الإصدار v3.0 — تفعيل إشعارات الخلفية البسيطة عبر `pg_net` وتريگرات قاعدة البيانات

الهجرة: `sql/migrations/2026-10-26_v3_0_database_webhooks_only.sql` — آمنة لإعادة التنفيذ،
ولا تحذف أي بيانات محادثات أو مستخدمين.

### ما تم تفعيله (مطابق لإعدادات المشروع العامل البسيطة)
- **امتداد `pg_net`**: مفعّل تلقائياً في المخطط العام (`create extension if not exists pg_net`).
- **تريگرات ودوال الإشعارات البسيطة**:
  - `send_fcm_on_new_message` على `public.messages` (`AFTER INSERT`) يستدعي `handle_new_message_notification()` (مع وجود `handle_new_message_push()` و`notify_new_message()` في المخطط العام).
  - `on_call_room_notify` على `public.call_rooms` (`AFTER INSERT OR UPDATE`) يستدعي `notify_call_room()`.
  - `on_profile_created_notify_admins` على `public.profiles` (`AFTER INSERT`) يستدعي `notify_admins_new_profile()`.
- **إصلاح رابط دالة المشروع**: جميع التريگرات تستدعي الرابط الصحيح `https://gqocavvhhfwgkzscrjms.supabase.co/functions/v1/send-push` (تم إصلاح الخطأ الإملائي القديم `gqocavvhkfzgxzscrjms` الذي كان يسبّب فشل DNS).
- **إزالة التعقيدات القديمة**: صفر اعتماد على Supabase Vault، صفر حاجة لإنشاء Database Webhooks يدوياً، وإزالة دوال المسبار المعقدة (`push_probe`، `push_call_edge`، `push_settings`).

### الطبقات الحالية
| الطبقة | الملف | المسؤولية |
|---|---|---|
| تريگرات القاعدة | `sql/schema.sql` (§26) | `send_fcm_on_new_message` + `pg_net` |
| تطبيع الحدث | `supabase/functions/send-push/webhook.ts` | تحويل حمولة التريگر/Webhook إلى `PushEvent` |
| قواعد المستلم | `supabase/functions/send-push/recipients.ts` | عزل الرسائل/المكالمات/المشرفين |
| الإرسال | `supabase/functions/send-push/index.ts` | FCM HTTP v1 + `push_delivery_log` |
| الإعداد | `supabase/config.toml` | `verify_jwt = false` + ترويسة السرّ |
| الواجهة | `js/push.js` | `test` + `diagnostics` فقط |

### سجل التسليم
`push_delivery_log(kind, ref_id, recipient_id, source, sent, total, skipped, detail, created_at)`
بـ RLS وقراءة للمشرفين فقط، ولا سياسة كتابة لأي عميل. تُنظَّف بدالة
`prune_push_delivery_log(keep_days)` المحجوزة على `service_role`.

### الاختبارات
- `tests/send-push-runtime.mjs` — **تشغيل الدالة الحقيقية** على Node مع محاكي
  supabase-js وOAuth2/FCM، بحمولات Webhook حقيقية: رسائل/مكالمات/مستخدم جديد،
  التكرار، حراس العزل، التوكنات الميتة، إعادة المحاولة (`npm run test:runtime`).
- `tests/notification-isolation.mjs` — قواعد `recipients.ts` + تطبيع `webhook.ts` + فحص
  صفر مراجع `pg_net`/Vault/تريگرات في كل ملفات SQL.
- `tests/sql-v29-postgres.mjs` — تنفيذ `schema.sql` + هجرة v3.0 على PostgreSQL حقيقي
  (PGlite): لا دوال إشعارات، سجل تسليم محمي، سياسات المراقبة باقية.
- `tests/rls-hardening-postgres.mjs` · `tests/sql-v28-postgres.mjs` — تحديث كامل للمعمارية.

> ℹ️ الأقسام التاريخية (v2.12 → v2.19: Worker، Vault، pg_net، مسار العميل) حُذفت من
> هذا الملف لأنها تصف بنية أُلغيت نهائياً. سجلّها محفوظ في تاريخ Git.
