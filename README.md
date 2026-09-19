# تطبيق المحادثات (WhatsApp-style PWA) — دليل الإعداد

## 1. إعداد Supabase
1. أنشئ مشروعاً جديداً على https://supabase.com
2. اذهب إلى **SQL Editor** وشغّل محتوى الملف `sql/schema.sql` بالكامل. هذا سينشئ:
   - جداول: `profiles`, `conversations`, `messages`, `message_reactions`, `typing_status`
   - سياسات RLS تضمن أن كل طرف يرى محادثاته فقط
   - Trigger تلقائي ينشئ صف `profiles` عند التسجيل، ويحدد `is_admin` تلقائياً بمطابقة البريد مع القائمة الثابتة
   - Buckets تخزين: `avatars`, `attachments`, `wallpapers`
3. من **Settings > API** انسخ:
   - `Project URL` → ضعه في `js/config.js` باسم `SUPABASE_URL`
   - `anon public key` → ضعه في `js/config.js` باسم `SUPABASE_ANON_KEY`
4. من **Authentication > Providers** تأكد أن تسجيل الدخول بالبريد/كلمة المرور مُفعّل.
   (اختياري) عطّل "Confirm email" أثناء التطوير لتسريع الاختبار.
5. من **Database > Replication** تأكد أن الجداول `messages`, `typing_status`, `profiles`,
   `message_reactions` مضافة إلى `supabase_realtime` (السكربت يفعل هذا تلقائياً).

## 2. تشغيل التطبيق محلياً
التطبيق Vanilla JS بدون build step — يكفي خادم استاتيكي بسيط:

```bash
cd wa-app
python3 -m http.server 8080
# افتح http://localhost:8080
```

> ملاحظة: وحدات ES Modules (`type="module"`) لا تعمل من `file://` مباشرة، يجب تقديمها عبر خادم HTTP.

## 3. أيقونات وصوت الإشعار
المجلد `icons/` يحتاج منك إضافة:
- `icon-192.png` و `icon-512.png` (أيقونة التطبيق لتثبيت PWA)
- `notify.mp3` (صوت إشعار الرسائل الجديدة)

هذه ملفات ثنائية لم يتم توليدها هنا — أضف ملفاتك الخاصة بنفس الأسماء.

## 4. نشر التطبيق (Deploy)
يعمل على أي استضافة استاتيكة: Vercel, Netlify, GitHub Pages, Cloudflare Pages.
فقط ارفع محتوى مجلد `wa-app/` كما هو (تأكد أن `manifest.json` و `sw.js` في الجذر).

## 5. ما تم تنفيذه في هذا الإصدار
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
- **Web Push Notifications حقيقية** تصل حتى مع إغلاق المتصفح، عبر Edge Function + جدول `push_subscriptions` (تفاصيل الإعداد أدناه)

## 6. إعداد الإشعارات الحقيقية (Firebase Cloud Messaging) — تم التحويل من Web Push/VAPID
⚠️ **تغيير معماري مهم:** المشروع لم يعد يستخدم Web Push (VAPID) + Supabase Edge Function
(`supabase/functions/send-push` وجدول `push_subscriptions` أصبحا **قديمين/غير مُستخدَمين**،
تُركا في المشروع للمرجعية فقط). الإشعارات الآن بالكامل عبر **Firebase Cloud Messaging (FCM)**.

### آلية العمل الحالية
- `js/push.js`: يهيّئ Firebase (SDK نسخة 10.8.0 المعيارية)، يطلب إذن الإشعارات، ويسجّل
  `firebase-messaging-sw.js` في نطاق (scope) مخصص `./firebase-cloud-messaging-push-scope`
  **منفصل تماماً** عن `sw.js` الرئيسي لتفادي أي تعارض بين Service Workerين.
- `firebase-messaging-sw.js` (في جذر المشروع): يستقبل رسائل FCM في الخلفية (تطبيق مغلق/مصغّر)
  عبر `messaging.onBackgroundMessage()` ويعرضها بـ `registration.showNotification()`.
- عند فتح التطبيق (foreground)، `listenForForegroundMessages()` في `push.js` تُستدعى من
  `enterApp()` في `app.js`، وتعرض الإشعار أيضاً عبر `registration.showNotification()` —
  **وليس** `new Notification()` التي تُسبّب خطأ "Illegal constructor" على متصفحات الأندرويد.
- توكن كل جهاز يُحفظ في جدول `fcm_tokens` (قسم 8 في `sql/schema.sql`).

### خطوات الإعداد
1. **مشروع Firebase**: أنشئ مشروعاً على [console.firebase.google.com](https://console.firebase.google.com)،
   فعّل **Cloud Messaging**، واحصل على `firebaseConfig` من Project Settings → General → Your apps → Web app.
2. **مفتاح VAPID الخاص بـ Firebase** (مختلف عن VAPID القديم): Project Settings → Cloud Messaging →
   Web Push certificates → Generate key pair.
3. ضع نفس `firebaseConfig` **حرفياً بلا اختصار** في مكانين (يجب أن يتطابقا تماماً):
   - `js/push.js` (المتغيّر `firebaseConfig`)
   - `firebase-messaging-sw.js` (نفس المتغيّر) — هذا كان مصدر خطأ "ServiceWorker script
     evaluation failed" سابقاً بسبب نسخة مبتورة (`"...":`) من `apiKey`/`appId`.
4. ضع مفتاح VAPID في `js/push.js` بالمتغيّر `VAPID_KEY`.
5. **نفّذ قسم 8 و 9 من `sql/schema.sql`** في SQL Editor (جدول `fcm_tokens` + صلاحيات).
6. من داخل التطبيق: **الإعدادات ⚙️ → تفعيل إشعارات الجهاز**.

> ملاحظة: iOS Safari لا يدعم FCM Web Push إلا عندما يكون التطبيق **مثبّتاً كـ PWA** على
> الشاشة الرئيسية (iOS 16.4+)، تماماً كحال Web Push العادي.

## 7. صلاحيات المشرف العام (Super Admin)
حساب `almgawell17@gmail.com` يملك الآن صلاحيات مطلقة على **كل** المحادثات و**كل** المشرفين
(قراءة وكتابة/رد كامل)، وليس فقط محادثاته الخاصة — مُفعَّلة عبر عمود `profiles.is_super_admin`
وسياسات RLS في قسم 9 من `sql/schema.sql`. تظهر محادثات المشرفين الآخرين في قائمته مع شارة
صغيرة باسم المشرف الأصلي صاحب المحادثة.

لإضافة حساب مشرف عام آخر لاحقاً: نفّذ فقط سطر `update public.profiles set is_super_admin =
true, is_admin = true where email = '...';` من قسم 9 بالبريد الجديد — لا حاجة لتعديل أي كود.

## 8. المرحلة التالية (لم تُبنَ بعد — يمكن إضافتها عند الطلب)
- مزامنة صراعات التعديل (conflict resolution) عند تعديل نفس الرسالة من أكثر من جهاز أثناء العمل دون اتصال
- بحث فعلي داخل قائمة المحادثات وداخل الرسائل (الحقل موجود شكلياً فقط حالياً)
- ضغط وتصغير الصور قبل الرفع لتوفير الباندويدث
- دعم مجموعات (Group Chats) بدلاً من محادثات ثنائية فقط
