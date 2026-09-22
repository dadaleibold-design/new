# إصلاح الإشعارات في الخلفية + موثوقية Realtime + دقة عدّاد غير المقروء

> تقرير فني (عربي) يشرح ما فُحص، وما كان معطوباً فعلاً، وما تغيّر في الكود،
> وخطوات التشغيل المطلوبة منك، وكيف تتحقق من النتيجة بنفسك.
>
> التاريخ: 2026-09-21 — الفرع: `arena/01a0c608-new`

---

## 1) ملخص تنفيذي (ثلاث جمل)

1. **الإشعارات**: كانت تُسقَط عمداً حين يكون التطبيق في الخلفية (`visibilityState !== "visible"`)،
   وكانت الحمولة data-only بلا `notification` فلا تصل على iOS، وبأولوية `normal` فيمكن
   أن يؤجّلها النظام في Doze — وقد عولجت الثلاثة.
2. **Realtime والعدّادات**: أُضيفت طبقة موثوقية (قنوات تُعيد الاشتراك تلقائياً + نبضة يقظة
   watchdog + مزامنة «ما فات» عند العودة)، وأصبح عدّاد غير المقروء مصدراً واحداً للحقيقة
   يُصفَّر **فوراً** بمجرد لمس المحادثة، ويثبت على السيرفر بدالة ذرّية واحدة.
3. **نقرة الإشعار**: أُضيف موجّه مركزي يلتقط النقرة حتى لو وصلت أثناء الإقلاع (قبل جاهزية
   التطبيق)، فيفتح المحادثة الصحيحة ويمرّر الشاشة إلى الرسالة نفسها ويميّزها تمييزاً مؤقتاً.

---

## 2) فحص المشروع قبل التعديل (الهيكل + تواريخ التعديل)

الفحص شمل كل ملفات المستودع (باستثناء `node_modules` و`.git`):

| الملف | الحجم | تاريخ آخر تعديل (UTC) | الدور |
|---|---:|---|---|
| `index.html` | 9.4 KB | 2026-09-21 22:14 | هيكل التطبيق + شاشة الدخول + لوحة الإعدادات |
| `manifest.json` | 425 B | 2026-09-21 22:14 | بيانات PWA (standalone) |
| `css/style.css` | 52 KB | 2026-09-21 22:14 | كل الأنماط |
| `js/app.js` | 167.5 KB | 2026-09-21 22:14 | المنطق الرئيسي (6120 سطر) |
| `js/push.js` | 17 KB | 2026-09-21 22:14 | تهيئة Firebase + توكن FCM |
| `js/notifications.js` | 14 KB | 2026-09-21 22:14 | إذن الإشعارات + دليل الخلفية |
| `js/calls.js` | 56 KB | 2026-09-21 22:14 | مكالمات Agora + قناة الإشارات |
| `js/db.js` | 6.5 KB | 2026-09-21 22:14 | IndexedDB (كاش الرسائل + Outbox) |
| `js/supabaseClient.js` | 377 B | 2026-09-21 22:14 | إنشاء عميل Supabase |
| `js/config.js`, `js/i18n.js`, `js/media.js`, `js/ringtone.js`, `js/safety.js`, `js/auth.js` | — | 2026-09-21 22:14 | إعدادات/ترجمة/وسائط/نغمات/حماية/مصادقة |
| `sw.js` | 5.8 KB | 2026-09-21 22:14 | Service Worker الواجهة (App Shell) |
| `firebase-messaging-sw.js` | 13.7 KB | 2026-09-21 22:14 | Service Worker إشعارات FCM |
| `partials/chat-panel.html` | 3.2 KB | 2026-09-21 22:14 | لوحة الدردشة (تُحقن ديناميكياً) |
| `sql/schema.sql` | 77 KB | 2026-09-21 22:14 | المخطط الكامل + RLS + Triggers |
| `sql/migrations/*.sql` | 7–21 KB | 2026-09-21 22:14 | ترقيات v2 (العدّادات/الإشعارات/المكالمات) |
| `supabase/functions/send-push/index.ts` | 15.6 KB | 2026-09-21 22:14 | إرسال FCM HTTP v1 |
| `supabase/functions/agora-token/index.ts` | 2.4 KB | 2026-09-21 22:14 | توكن Agora |
| `tests/*` | — | 2026-09-21 22:14 | اختبارات jsdom + إعداد ESLint |

**ملاحظات على الهيكل:** لا يوجد build step (وحدات ES مباشرة)، الحِزم تُحمَّل من CDN
(`gstatic` لـ Firebase، ومصادر متعددة لـ Agora)، و`main.zip` و`--main/` و
`supabase/function/.vv` ملفات قديمة/مهملة لا يؤثر وجودها.

---

## 3) المشكلة الأولى: الإشعارات تتوقف بعد دقائق في الخلفية

### الأسباب الجذرية التي وُجدت في الكود

| # | السبب | الموضع قبل الإصلاح | الأثر |
|---|---|---|---|
| 1 | **إسقاط الإشعار عند عدم رؤية التبويب** | `js/push.js → listenForForegroundMessages()`: `if (document.visibilityState !== "visible") return;` | إن سلّم FCM الرسالة للصفحة وهي في الخلفية (وهذا يقع) يُهمَل الإشعار تماماً بلا أي سجل |
| 2 | **حمولة data-only** | `supabase/functions/send-push/index.ts` | iOS/Safari 16.4+ لا يدعم الدفع الصامت الموثوق ⇒ **لا إشعار على iPhone إطلاقاً** |
| 3 | **أولوية `normal`** | نفس الملف: `webpush.headers.Urgency = normal` | مزوّد الدفع يؤجّل الرسائل على جهاز في Doze/توفير الطاقة — وهو سبب "توقّف الإشعارات بعد ~5 دقائق" |
| 4 | **موت WebSocket بصمت** | `js/app.js` (لا شيء يعيد الاتصال) + `pagehide` يقطع Realtime | وصول الرسائل اللحظية يتوقف، ولا يظهر أي خطأ للمستخدم |
| 5 | **سقوط ملف الـ SW كاملاً** | `firebase-messaging-sw.js` يستدعي `importScripts` من gstatic بلا `try/catch` | أي انقطاع/حجب لـ gstatic = فشل تقييم الـ SW ⇒ لا مستمع `push` ولا `notificationclick` |
| 6 | **تدوير التوكن بلا إعادة تسجيل** | لا مراقبة لـ `onTokenRefresh` ولا فحص دوري | التوكن القديم يُحذف من `fcm_tokens` (404/UNREGISTERED) فتتوقف الإشعارات حتى يفتح المستخدم التطبيق من جديد |

### ما نُفِّذ

- **`js/push.js`**
  - `listenForForegroundMessages()` يعرض الإشعار **دائماً** إلا إن كان المستخدم يفتح نفس
    المحادثة على الشاشة (`shouldSuppress({ viewingThread })`) — عكس النسخة السابقة تماماً.
  - `syncPushToken({ userId, force })`: يزامن التوكن مع `fcm_tokens` عند كل دخول، وكل تدوير
    توكن، ودورياً (30 دقيقة كحدّ أقصى)، مع `onTokenRefresh` عبر `watchTokenRefresh()`.
  - العرض يستخدم تسجيل الـ SW الصحيح (`serviceWorkerRegistration`) لا `navigator.serviceWorker.ready`.
  - `isPushReady()` و`getLastTokenSyncAt()` لتشخيص سريع من الواجهة.
- **`firebase-messaging-sw.js`** (أُعيد بناءه)
  - `importScripts` داخل `try/catch` + **مستمع `push` احتياطي مستقل** يعرض الإشعار من الحمولة
    الخام إن لم يكن Firebase جاهزاً (مع فحص `getNotifications(tag)` لمنع التكرار).
  - `notificationclick` يوجّه دائماً للمحادثة الصحيحة (تفاصيل في القسم 5).
  - `pushsubscriptionchange` ⇒ إبلاغ التطبيق (`PUSH_RESUBSCRIBE`) لإعادة تسجيل التوكن.
- **`supabase/functions/send-push/index.ts`**
  - إرسال `webpush.notification` مع الحمولة (متوافق مع iOS + يضمن ظهور الإشعار) مع الحفاظ على
    `data` كاملة للتوجيه في النقر.
  - **أولوية عالية للكل** (`Urgency: high`, `apns-priority: 10`, `android.priority: high`) لتفادي
    تأجيل Doze، مع مفتاح إرجاع اختياري `PUSH_NORMAL_URGENCY=1`.
  - مكالمة منتهية/فائتة ترسل بلا إشعار تفاعلي (`withNotification:false`).
  - حقول إضافية في البيانات: `timestamp`, `messageType`, `roomId`, `senderId`.
- **`js/notifications.js`**: فحص التوكن/الصلاحية صار كل 30 دقيقة بدل 24 ساعة، و`pushStatusReport()`.
- **`js/app.js`**: `runCatchUpSync()` يزامن التوكن ويسحب ما فات عند كل عودة للمقدمة/الاتصال،
  و`beforeunload` يحدّث "آخر ظهور" بـ keepalive.
- **`sw.js`**: تحديث تلقائي للـ SW (`updateViaCache:"none"` + `SKIP_WAITING`) حتى لا يعلق
  المستخدم على نسخة قديمة تُخفي الإصلاحات.

> ملاحظة مهمة للسلوك المطلوب: نظام Android **يحتاج** استثناء التطبيق من تحسين البطارية،
> وهذا موجود لديك أصلاً — لكن الاستثناء وحده لا يكفي مع أولوية `normal`، ولهذا كان
> تغيير الأولوية ضرورياً.

---

## 4) المشكلة الثانية: موثوقية Realtime ودقة العدّادات

### ما كان يحدث
- عند تجميد التبويب (Chrome بعد ~5 دقائق مخفياً) يموت WebSocket **بصمت**: لا حدث `offline`
  ولا خطأ، وتُخنَق المؤقتات، فيبدو التطبيق "ميتاً" حتى يعود المستخدم.
- عدّاد غير المقروء كان يُحسب من عميل آخر (شارة DOM) دون مصدر حالة مركزي، فيتضارب بعد
  المزامنة أو بعد القراءة من جهاز ثانٍ.

### الطبقات الثلاث الجديدة

**(أ) قنوات مرنة — `js/realtime.js` (جديد)**
- `createResilientChannel()`: كل قناة (presence / inbox / رسائل / محادثة / مكالمات) تُعيد
  الاشتراك تلقائياً عند `CHANNEL_ERROR` / `TIMED_OUT` / `CLOSED` بخلفية تصاعدية (1.2s → 30s)
  مع jitter، مع إغلاق القناة السابقة قبل إنشاء الجديدة (تفادي تعارض نفس الـ topic).
- `diagnoseRealtime()`: تقرير حالة الاتصال + حالة كل قناة.
- `startRealtimeWatchdog()`: نبضة **متكيّفة** (20s في المقدمة / 45s في الخلفية) تكتشف
  `disconnected` أو قناة ميتة، تستدعي `connect()` ثم تُحيي الاشتراكات (`onRevive`) — بفاصل
  تهدئة 30 ثانية لمنع العواصف.

**(ب) مزامنة «ما فات» — `js/app.js`**
- عند `visible` / `pageshow` / `online` / `focus`: تحرير عمليات القراءة المؤجّلة، ثم
  `loadMessages` (تحميل تفاضلي صامت) للمحادثة المفتوحة، ثم `loadContacts` + العدّادات + شارة المكالمات.
- مؤقت مزامنة أثناء الخفاء كل دقيقتين (بقدر ما يسمح المتصفح): عدّادات + توكن + تحديث الـ SW.
- شارة أيقونة التطبيق (`navigator.setAppBadge`) تعكس الإجمالي.

**(ج) عدّاد واحد للحقيقة — `js/app.js`**
- `state.unreadByConversation` هو المصدر الوحيد؛ تتفرّع منه: شارة الصف، ترويسة قسم المشرفين،
  وشارة النظام. الإجمالي = `totalUnreadCount()`.
- **التصفير الفوري**: النقر على المحادثة ⇒ `resetUnreadFor()` **قبل** أي `await` (يختفي
  العدّاد في نفس اللحظة)، ثم `markConversationRead()` يثبّت القراءة على السيرفر.
- `markConversationRead()`: يستخدم أولاً دالة SQL ذرّية جديدة
  `mark_conversation_read(uuid)` (تُعيد عدد الرسائل المقروءة)، ويسقط تلقائياً إلى
  `UPDATE messages SET status='read'` إن لم تكن الترقية مُنفَّذة.
- **طابور قراءات دائم**: أي فشل شبكة يُخزَّن في `localStorage.wa_pending_reads` ويُعاد
  تنفيذه عند العودة للشبكة/المقدمة، فلا يبقى العدّاد عالقاً على رقم قديم.
- `refreshUnreadBadges()`: إعادة حساب من السيرفر (RPC `unread_counts` أولاً ثم عدّ صفوف
  احتياطي) عند أي تغيير أو عودة من الخلفية، مع debounce 500ms لاستقبال عدة أحداث.
- رسالة لحظية لمحادثة مفتوحة ومرئية ⇒ تُصفَّر فوراً ولا شارة؛ ولغير المفتوحة ⇒ شارة + صوت + إشعار.

---

## 5) المشكلة الثالثة: نقرة الإشعار ⇒ شاشة الدردشة الصحيحة

### الثغرة التي كانت موجودة
كان `handleDeepLinks()` يقرأ `?conversation=` من الرابط ويربط مستمع رسائل الـ SW داخل نفس
الدالة، **لكن** الاستدعاء يقع في نهاية `enterApp()`. أي نقرة إشعار تصل قبل جهوزية التطبيق
(أثناء الإقلاع، أو قبل تحميل الملف الشخصي، أو قبل ربط المستمع) **تضيع بلا أثر**، وكذلك
النقرة التي تفتح نافذة جديدة ثم يقع `openById` قبل جهوزية `state.me` فيرجع `false` بصمت.
كما لم تكن هناك أي وسيلة لتمرير معرّف الرسالة، ولا إغلاق لإشعار المحادثة بعد قراءتها.

### الحل: موجّه مركزي — `js/notification-router.js` (جديد)
- `initNotificationRouter()` تُنفَّذ **عند استيراد الوحدة** (قبل `boot`):
  1. تقرأ `?conversation` / `?message` / `?answer_call` / `?decline_call` ثم تُنظّف الرابط
     (`history.replaceState`) حتى لا يُعاد الفتح عند كل تحديث.
  2. تربط مستمع رسائل الـ SW: `OPEN_CONVERSATION`, `PUSH_DELIVERED`, `PUSH_RESUBSCRIBE`.
  3. تُخزّن الهدف في `localStorage.wa_pending_route` بصلاحية 30 دقيقة إذا لم يكن التطبيق جاهزاً.
- التطبيق يسجّل `setNotificationRouteHandler(openRouteFromNotification)` بعد جهوزيته، فتُسلَّم
  الأهداف المخزّنة فوراً (`flushPendingRoutes`) — **فلا يضيع أي نقر**.
- `openConversationById()`: ينتظر جهوزية `state.me` (3 محاولات)، يجلب المحادثة والطرف الآخر
  (من القائمة المحلية أولاً ثم الشبكة)، ثم يفتح المحادثة — مع رسائل خطأ واضحة إن حُذفت المحادثة.
- `openConversation(peer, { messageId })`: بعد الفتح يمرّر الشاشة إلى الرسالة المطلوبة
  (`scrollToMessage`) ويميّزها بـ `.flash-message` لمدة 2.4 ثانية، مع تحميل صفحات أقدم عند
  الحاجة (حتى 3 محاولات)، ويُصفّر العدّاد ويغلق إشعار تلك المحادثة.
- مسار المكالمات: `answer_call`/`decline_call` تُقرأ من الرابط أو من بيانات الإشعار،
  و`openCallFromNotification()` يفتح واجهة المكالمة فقط إن كانت الغرفة `ringing`/`active`.
- في Service Worker: الرابط يُشتق من **نطاق التسجيل** (`self.registration.scope`) فيدعم
  الاستضافة على مسار فرعي، ويُوجَّه العميل الموجود `postMessage` (مع `focus()`)، وإن لم يوجد
  عميل مناسب يُستخدم `navigate()` ثم `openWindow()` كخيار أخير.

---

## 6) الملفات المتغيّرة في هذا العمل

| الملف | الحالة | أهم ما فيه |
|---|---|---|
| `js/realtime.js` | **جديد** | قنوات مرنة + نبضة يقظة + تشخيص |
| `js/notification-router.js` | **جديد** | التقاط نقر الإشعار قبل الجهوزية + التوجيه |
| `js/app.js` | معدّل | العدّادات، المزامنة بعد الخلفية، الـ watchdog، `scrollToMessage`, `__waDiagnostics()` |
| `js/push.js` | أُعيدت كتابته | سياسة عرض الإشعارات + مزامنة التوكن + مراقبة التدوير |
| `js/notifications.js` | معدّل | فحص دوري 30 دقيقة + تقرير حالة |
| `firebase-messaging-sw.js` | أُعيدت كتابته | مسار احتياطي push + توجيه النقر + بناء SW رقم `2026-09-21.1` |
| `sw.js` | معدّل | كاش `v10` + تحديث فوري + توجيه النقر بمسار فرعي |
| `supabase/functions/send-push/index.ts` | معدّل | `webpush.notification` + أولوية عالية + تشذيب التوكنات الميتة |
| `sql/migrations/2026-09-21_v2_3_realtime_unread_push_health.sql` | **جديد** | `mark_conversation_read()` + أعمدة/فهارس فحص التوكن + `push_diagnostics()` موسّعة |
| `sql/schema.sql` | معدّل | إضافة `mark_conversation_read()` للتثبيت الجديد |
| `index.html` | معدّل | `?v=23` لتفادي الكاش |
| `tests/notification-flow.mjs` | **جديد** | 4 سيناريوهات لنقر الإشعار والعدّاد |
| `tests/check-app.sh`, `tests/push-mock.mjs` | جديد/معدّل | حماية صياغة `app.js` + وهم `push.js` |

---

## 7) الخطوات المطلوبة منك (بالترتيب)

1. **نفّذ الترقية** في SQL Editor (أو أعد تنفيذ `sql/schema.sql` كاملاً وهو idempotent):
   `sql/migrations/2026-09-21_v2_3_realtime_unread_push_health.sql`
   - تُنشئ `mark_conversation_read()`, وتوسّع `push_diagnostics()`, وتضيف فهارس فحص التوكن.
   > التطبيق يعمل بدونها (مسارات احتياطية)، لكن معها يصبح تصفير العدّاد طلباً واحداً ذرّياً.
2. **أعد نشر دالة الإشعارات:**
   `supabase functions deploy send-push`
   (لو أردت إرجاع الأولوية العادية لأي سبب: `supabase secrets set PUSH_NORMAL_URGENCY=1`).
3. **انشر ملفات الواجهة** كما هي (`index.html`, `sw.js`, `firebase-messaging-sw.js`, مجلد `js/`).
   المستخدمون سيحصلون على `sw v10` تلقائياً مع أول فتح.
4. **من الجوال**: افتح الإعدادات ⚙️ → **إرسال إشعار تجريبي**، ثم أغلق التطبيق تماماً (اسحب من
   المهام الأخيرة) واتركه دقيقتين ثم اطلب من زميل إرسال رسالة — يجب أن يصل الإشعار والنقر
   يفتح نفس المحادثة على نفس الرسالة.

---

## 8) كيف تتحقق بنفسك

**اختبارات آلية (node):**

```bash
node tests/smoke.mjs user      # القائمة، الترتيب، الشارات، فتح المحادثة
node tests/smoke.mjs admin
node tests/smoke.mjs super
node tests/notification-flow.mjs   # 4 سيناريوهات: الرابط + الهدف المخزّن + رسالة SW + العدّاد
npx eslint --config tests/eslint.config.mjs js/ *.js
```

النتائج الحالية: `ALL PASSED` للثلاثة أدوار، و`ALL SCENARIOS PASSED` للإشعارات، وESLint بلا أخطاء.

**تشخيص ميداني من وحدة تحكم المتصفح:**

```js
__waDiagnostics()
// → { online, visibility, activeConversationId, unread, pendingReads,
//      realtime: { connection, channels[], unhealthy[], healthy },
//      push: { ready, lastTokenSyncAt, foregroundListener },
//      background: { watchdogRunning, hiddenCatchUpRunning } }
```

علامات مفيدة:
- `realtime.unhealthy.length > 0` أو `connection !== "connected"` ⇒ الشبكة/Doze قطعت الاتصال
  (الـ watchdog سيُحييه خلال ≤45 ثانية، ويحدث ذلك فعلياً عند العودة للمقدمة).
- `push.lastTokenSyncAt` أقدم من 30 دقيقة مع `ready:true` ⇒ لم تحدث مزامنة بعد (طبيعي إن كان
  التطبيق مغلقاً) — افتح التطبيق مرة ليُحدَّث تلقائياً.
- `pendingReads` غير فارغة ⇒ هناك محادثات فُتحت أثناء انقطاع الشبكة وستُثبَّت عند عودتها.

---

## 9) حدود معروفة (بصراحة)

- **iOS/iPadOS**: الإشعارات تعمل فقط إذا كان التطبيق **مثبَّتاً على الشاشة الرئيسية**
  (Safari 16.4+) — هذا قيد من آبل لا علاقة له بالكود.
- **التبويب المجمّد (Frozen)**: لا يمكن لأي مؤقت أن يعمل داخل تبويب مُجمَّد؛ ولهذا نعتمد
  ثلاث طبقات: WebSocket المتجدد، ثم Push من الخادم، ثم المزامنة عند العودة.
- **متصفحات تُخنق فيها المؤقتات** في الخلفية (≥5 دقائق) تجعل النبضة أبطأ من 45 ثانية،
  لكن المزامنة عند العودة تعوّض ذلك.
- `main.zip` و`--main/` و`supabase/function/.vv` ملفات مهملة — يمكن حذفها بأمان.
