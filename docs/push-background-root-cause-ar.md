# إشعارات الخلفية/المغلق: السبب الجذري والإصلاح — SW_BUILD `2026-10-13.2`

> التاريخ: 2026-10-13 — الفرع: `arena/139967f1-new`
> يُكمّل ويُصحّح `docs/realtime-push-hardening-ar.md` (الفقرة الخاصة بـ `webpush.notification` لم تعد صحيحة).

---

## 1) الأعراض

- المقدمة: إشعار صوتي ومرئي يظهر فوراً (`onMessage`).
- الخلفية أو المغلق: لا يظهر أي إشعار.

## 2) السبب الجذري (مُتحقَّق منه بالكود والـ SDK)

**المشكلة الأساسية: ثلاثة مسارات تعرض الإشعار لدفعة واحدة، ومنع التكرار يُسقط النسخة الصحيحة.**

1. الخادم كان يرسل `webpush.notification` (حمولة عرض). بذلك يعرض **Firebase SDK** إشعاراً تلقائياً
   (`onPush` ⇒ `wrapInternalPayload(internalPayload.notification)`)، ويُبنى من حقل `notification`
   الخام — **لا** من `data` التي تعتمد عليها حمولتنا.
2. الـ SW يعرض أيضاً عبر `onBackgroundMessage` وعبر معالج `push` الخام.
3. منع التكرار كان يفحص `getNotifications` بهوية الحدث، فيجد نسخة الـ SDK ويتخطّى نسختنا الصحيحة.
   النتيجة: **ما يراه المستخدم هو ما عرضه الـ SDK فقط**، وهو يعتمد على تحويل FCM لحقل `webpush.notification`
   ولا نتحكم فيه. إن كانت النسخة ناقصة (بلا عنوان) فلا يظهر شيء مفهوم.

**تأكيد عملي:** شغّلنا الاختبار نفسه على الـ SW القديم:

```
❌ نسخة SDK ناقصة لا تُسقط نسختنا: يبقى إشعار واحد مكتمل   titles=[null]
❌ نسخة SDK متأخرة وناقصة تُستبدل بنسختنا الكاملة بعد المصالحة   titles=[null]
```

الـ SW الجديد يُظهر `titles=["أحمد"]` و`["سارة"]` في الحالتين.

### أسباب إضافية ثانوية (تم إصلاحها)

| البند | المشكلة | الإصلاح |
|---|---|---|
| تعارض `pushsubscriptionchange` | الـ SW كان يستدعي `pushManager.subscribe` بنفسه بينما SDK يدير التوكن (`onSubChange`) ⇒ اشتراك خارج FCM | نُبلغ الصفحات فقط (`PUSH_RESUBSCRIBE`) وSDK يدير التوكن |
| طابور عرض بلا مهلة | عملية عالقة (`getNotifications` لا يعود) تُجمّد كل الإشعارات اللاحقة في نسخة الـ SW | مهلة 8 ثوانٍ لكل عملية + طابور تسلسلي |
| تأخير اعتباطي 600ms | الاعتماد على التوقيت لـ«إعطاء الـ SDK فرصة أولاً» | لا تأخير؛ منع التكرار بالهوية |
| دفعة لا تُحلَّل | لا إشعار ⇒ انتهاك `userVisibleOnly` (يعرض Chrome إشعاراً عاماً، وقد يُلغي الاشتراك عند تكرار ذلك) | إشعار عام احتياطي |
| إعادة اشتراك غير لازمة في Push | دون معرفة الاشتراك الجديد | حُذفت |

## 3) ما تغيّر

### `supabase/functions/send-push/index.ts`
- **عقد الويب data-only**: الحمولة كلها في `data`، بلا `webpush.notification` ولا `notification`.
  - `webpush.headers` (Urgency/TTL) فقط.
  - حُذف `buildTag` و`buildWebPushNotification` و`buildAppLink` (الـ SW يحدد tag/renotify/actions من مصدر واحد).
- `APP_PUBLIC_URL` لم يعد مطلوباً (نقرة الإشعار تُوجَّه من نطاق الـ SW نفسه).
- **سجلات التشخيص** في Supabase Logs:
  - `[send-push] request type=…`
  - `[send-push] type=new_message sent=1/2 removed=0`
  - `[send-push] FCM rejected row=… status=… reason=…` (سبب الرفض من FCM).

### `firebase-messaging-sw.js` (أُعيد بناؤه)
- **مصدر عرض واحد**: معالج `push` الخام. يعمل مع كل دفعة، ويعرض عندما لا توجد نافذة ظاهرة.
- `onBackgroundMessage` للتسجيل فقط.
- توحيد الحمولة `fromPushPayload` (يقرأ `data` أولاً، ثم `notification` للتوافق الرجعي).
- منع التكرار بهوية الحدث + ذاكرة 60 ثانية + مهلة لكل عرض.
- **مصالحة** النسخ المتأخرة الناقصة من SDK بعد 800ms (شبكة أمان أثناء النشر).
- **سجلات `[push-sw]`**:
  - `push received` (يتضمن `fcmMessageId` و`dataKeys` و`sdkAutoDisplayCandidate`): يثبت وصول الدفعة من Google إلى الجهاز.
  - `decision: …`: قرار العرض أو تجاهل النافذة الظاهرة.
  - `duplicate skipped …`، `notification shown`، `fallback notification shown`، `display failed …`.
  - `notification clicked`، `pushsubscriptionchange …`.

### `js/push.js`
- سجلات `[FCM]` لحالة الـ SW وتسجيل التوكن على الخادم. لا تغيير وظيفي.

### `sw.js`
- `CACHE_NAME` = `wa-clone-shell-v15` ليلتقط المتصفح `push.js` الجديد.
- لا تعارض حقيقي بين `sw.js` و`firebase-messaging-sw.js`: لكل منهما نطاق ورابط مختلف، ولا يُلغي أحدهما الآخر.
  كل منهما يعالج النقرات للإشعارات التي أنشأها بنفسه.

### `tests/push-sw.mjs`
- 6 فحوصات جديدة: النسخة الناقصة من SDK، النسخة المتأخرة، الدفعة غير القابلة للتحليل،
  `pushsubscriptionchange`، والسجلات. خمسة من الستة تفشل على الـ SW القديم وتنجح على الجديد (السادس، إبلاغ الصفحات بتغيّر الاشتراك، كان يعمل من قبل).

## 4) خطوات النشر (بالترتيب)

1. **Edge Function**: `supabase functions deploy send-push` (`verify_jwt=false` مضبوط في `config.toml`).
2. **الواجهة**: انشر الملفات الثابتة (`firebase-messaging-sw.js`، `sw.js`، `js/push.js`).
   `vercel.json` يمنع كاش ملفات الـ SW.
3. **على الجهاز**: أغلق التطبيق تماماً ثم أعد فتحه مرة واحدة ليُفعَّل `SW_BUILD 2026-10-13.2`.
4. لا حاجة لأي ترحيل SQL، والتوكنات المسجّلة تعمل كما هي.

## 5) التحقق على جهاز حقيقي

| ما تتحقق منه | أين تراه |
|---|---|
| الإرسال من السيرفر | Supabase → Edge Functions → Logs: `[send-push] type=new_message sent=1/1` |
| رفض FCM | نفس السجل: `FCM rejected … status=… reason=…` |
| وصول الدفعة إلى الجهاز | الجهاز (Chrome: `chrome://inspect/#service-workers`) → Console: `[push-sw] push received` مع `fcmMessageId` |
| قرار العرض | `[push-sw] decision: background → render notification` ثم `notification shown` |
| الإشعار نفسه | إن ظهر `push received` ولم يظهر `notification shown` ⇒ مشكلة في إذن النظام/قناة الإشعارات على الجهاز |

**قراءة النتائج:**
- لا يظهر `push received` أبداً ⇒ الدفعة لم تصل من Google (تحقق من سجل `send-push` ومن `sent=`، ومن التوكن في `fcm_tokens`).
- يظهر `push received` و`notification shown` ولا تراه ⇒ الجهاز يحجب الإشعار (إعدادات الموقع/وضع عدم الإزعاج/قناة النظام).
- يظهر `decision: app window visible` ⇒ التطبيق مفتوح في نافذة ظاهرة، فالعرض من الصفحة (`onMessage`) وهذا مقصود.

**iOS/iPadOS**: الإشعارات تعمل فقط للتطبيق المُثبَّت على الشاشة الرئيسية (iOS 16.4+) مع إذن المستخدم.

## 6) ما لم يُغيَّر عمداً

- `supabase/config.toml` (`verify_jwt=false` لـ `send-push`) — صحيح لمسار الـ trigger.
- مسار الرسائل في قاعدة البيانات (`push_call_edge` / `notify_new_message`) — يرسل `message_id` و`conversation_id` و`sender_id` و`content`، وهذا يتطابق مع ما يقرأه `send-push`.
- `onTokenRefresh` معطّل في `push.js` كما في التقرير السابق (لا يوجد في Web SDK v9+ المعياري).
