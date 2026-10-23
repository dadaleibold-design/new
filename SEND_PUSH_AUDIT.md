# تقرير تدقيق إشعارات الخلفية — tayba / send-push

**التاريخ:** 2026-10-23  
**النطاق:** `send-push`، تريغرات `messages/call_rooms/profiles`، `pg_net`، المصادقة، الحمولة، وFCM.

## 1) الخلاصة التنفيذية

السبب الأوضح لفارق السجلات هو **مصادقة بوابة Edge Function ومسارات استدعاء قديمة**، وليس اختلاف حمولة رسالة `INSERT` القياسية:

- الاختبار من التطبيق يرسل `POST` مع `Authorization: Bearer <USER_JWT>` و`apikey`، لذلك يجتاز البوابة ثم يسلك مسار `test/diagnostics` وينجح.
- `UNAUTHORIZED_NO_AUTH_HEADER` يعني أن الطلب وصل إلى بوابة Edge Functions بينما كان التحقق من JWT مفعّلاً، ولم يحمل `Authorization` أو `apikey`. هذا الرفض يحدث **قبل** تنفيذ `send-push` [1].
- كود الدالة السابق كان سيعيد `405` لأي `GET` يصل إليه، وليس رمز المنصة `UNAUTHORIZED_NO_AUTH_HEADER`. لذلك فسجل `GET + 401` دليل على رفض البوابة قبل الدالة.
- لا يوجد في الواجهة أو Service Worker أي `GET` إلى `send-push`، و`net.http_post` يُنتج `POST`. أما Database Webhooks في لوحة Supabase فتدعم `GET` و`POST`؛ لذا فالهوكات القديمة هي الفئة المشتبه بها [2][3].
- تعذّر تحديد **اسم** الهوك الحي من المستودع وحده لعدم وجود اتصال Supabase فعّال في الجلسة. لهذا أُضيف تنظيف مُقيّد يزيل كل هوك `supabase_functions.http_request` يستهدف `send-push` على الجداول الثلاثة، وملف تدقيق يعرض أي اسم متبقٍ بلا كشف الأسرار.

**الحكم على الحمولة:** جسم `messages INSERT` السابق (`type/table/schema/record`) كان متوافقاً مع `normalizePayload`. الحقول المسطّحة الإضافية لم تكن تمنع المعالجة. لذلك لا يوجد دليل أن تباين الحمولة هو سبب `GET + 401`. وُجدت بدلاً من ذلك حالات طرفية غير متسقة (`record=null` في `DELETE`، JSON غير كائن، وسجل مفقود) وتم إصلاحها.

## 2) النتائج والإصلاحات

| # | الخلل | الأثر | الإصلاح |
|---|---|---|---|
| 1 | JWT مفعّل فعلياً على البوابة رغم `verify_jwt=false` في الملف | رفض طلبات الخلفية قبل الدالة عند غياب JWT/API key | توحيد `supabase/config.toml` وتوثيق/اختبار النشر بـ `supabase functions deploy send-push --no-verify-jwt` |
| 2 | هوكات قديمة محتملة بجانب تريغرات `pg_net` | `GET`، و401، وتكرار محتمل للإشعار | الهجرة تحذف فقط هوكات `supabase_functions.http_request` التي تستهدف `send-push` على الجداول الثلاثة؛ لا تحذف هوكات أخرى |
| 3 | سرّ مدمج في SQL والدالة، وقبوله حتى مع وجود `SEND_PUSH_SECRET` | سرّ مكشوف ومسار مصادقة غير قابل للتدوير بأمان | إزالة السرّ الافتراضي نهائياً؛ **يجب تدوير السرّ القديم** |
| 4 | قبول الطلب بلا سرّ إذا كان `SEND_PUSH_SECRET` غير مضبوط، وقبول Bearer/service role كبديل | fail-open ومسارات مصادقة غير حاسمة | أحداث القاعدة تقبل فقط `x-send-push-secret` مطابقاً لسرّ إلزامي طوله 32+؛ لا قيمة افتراضية ولا Bearer بديل |
| 5 | السرّ والرابط مكتوبان في SQL | تسريب وصعوبة إدارة البيئات | `public.send_push_post(jsonb)` يقرأ `send_push_url` و`send_push_secret` من Vault؛ لا قيم حساسة في Git [4] |
| 6 | `CREATE EXTENSION ... WITH SCHEMA public` مع ابتلاع فشل الإنشاء | إعداد غير متسق مع مخطط `net`، واحتمال تريغرات غير عاملة بصمت | `create extension if not exists pg_net;` بلا تغيير مخطط ولا ابتلاع خطأ؛ والهجرة تتحقق من Vault قبل التعديل |
| 7 | ثلاث دوال مرادفة لإشعار الرسالة وتعدد مسارات الإنشاء | احتمال تريغرات مكررة وصعوبة التدقيق | نقطة `send_push_post` واحدة + ثلاث دوال تريغر قانونية فقط |
| 8 | حقول مسطّحة مكررة بجانب `record` | جسم أكبر وPII مكررة واحتمال انحراف العقود مستقبلاً | جسم SQL موحد: `{type, table, schema, record, old_record}` فقط |
| 9 | `record=null` أو JSON غير كائن لا يُعالج باتساق | 400 غير واضح أو سلوك غير متوقع | `DELETE` غير المعني يعيد `ignored`، و`INSERT` بلا سجل يعيد 400 واضحاً، وكل الدخل غير الكائن مضبوط |
| 10 | `GET` يعيد 405 بسيطاً بلا `Allow` | تشخيص أصعب وتمييز غير واضح عن رفض البوابة | `405 + Allow: POST, OPTIONS`، و`OPTIONS=204`، وCORS يتضمن الترويسة المطلوبة |
| 11 | استثناء شبكة لجهاز يمكن أن يُسقط `Promise.all` | فشل الحدث كله بسبب جهاز واحد | إعادة محاولة أخطاء الشبكة، وعزل نتيجة كل جهاز، ومعالجة فشل تنظيف التوكن منفصلة |
| 12 | الهجرة تسقط `push_delivery_log` عند إعادة تنفيذها | فقدان الأدلة التشخيصية | `CREATE TABLE IF NOT EXISTS` واختبار يثبت بقاء السجل بعد إعادة الهجرة |
| 13 | التشخيص كان يعلن `secret_configured=true` دائماً | جاهزية ظاهرية كاذبة | يعكس وجود سرّ صالح فعلاً، ويوضح أن SQL Audit هو فحص القاعدة الفعلية |

## 3) العقد بعد الإصلاح

### التريغر → Edge Function

```http
POST /functions/v1/send-push
Content-Type: application/json
x-send-push-secret: <نفس SEND_PUSH_SECRET>
```

```json
{
  "type": "INSERT",
  "table": "messages",
  "schema": "public",
  "record": { "id": "...", "conversation_id": "...", "sender_id": "..." },
  "old_record": null
}
```

### Edge Function → FCM

- يشتق المستلم من صف المحادثة/الغرفة ولا يثق بمستلم قادم من الحمولة.
- يرسل `data-only` إلى كل توكنات المستلم.
- يسجل النتيجة في `push_delivery_log` بمصدر `trigger`.
- يعيد 400 للعقد غير الصالح، و401 للسرّ المخالف، و405 للmethod غير المدعوم، و503 عند نقص إعداد السرّ/Firebase.

## 4) الملفات المسلّمة

- `supabase/functions/send-push/index.ts` — المصادقة، HTTP، الاستقرار، التشخيص.
- `supabase/functions/send-push/webhook.ts` — تطبيع الحمولة والحالات الطرفية.
- `sql/migrations/2026-10-26_v3_0_database_webhooks_only.sql` — الهجرة المصححة.
- `sql/schema.sql` — نفس المعمارية في §26.
- `sql/send-push-audit.sql` — تدقيق للقراءة فقط بلا أسرار/محتوى حساس.
- `README.md` و`.env.example` — خطوات الإعداد والنشر الموحدة.

## 5) خطوات التطبيق على الإنتاج

1. دوّر السرّ القديم واضبط `SEND_PUSH_SECRET` وأسرار Firebase في Edge Secrets.
2. أنشئ/حدّث `send_push_url` و`send_push_secret` في Vault بنفس القيم المتفق عليها.
3. نفّذ الهجرة المصححة في SQL Editor.
4. انشر: `supabase functions deploy send-push --no-verify-jwt`.
5. نفّذ `sql/send-push-audit.sql`: المطلوب `canonical_trigger_count=3` و`legacy_send_push_hooks=0`.
6. أرسل رسالة حقيقية من حساب آخر والتطبيق مغلق، ثم طابق:
   - `net._http_response.status_code = 200`؛
   - `push_delivery_log.sent/total`؛
   - سجل `[push-sw]` على الجهاز.

التعليمات التفصيلية وأوامر Vault في `README.md` §7. لم تُنفّذ هذه الخطوات على المشروع الحي من الجلسة لعدم اتصال Supabase؛ إجراء الحذف مضمن في الهجرة ويحتاج تنفيذها هناك.

## 6) التحقق الآلي

- اختبار تشغيل الدالة الحقيقية: نجح، ويشمل `GET=405`، و`OPTIONS=204`، وJSON المكسور، و`null/DELETE`، ورفض Bearer البديل، والرسائل/المكالمات/المستخدمين، وانقطاع شبكة جهاز دون إسقاط الآخر.
- اختبار العزل والحمولة: نجح.
- اختبار PostgreSQL/PGlite: نجح؛ المخطط والهجرة يعملان، وإعادة الهجرة تحفظ السجل، وهوك `GET` قديم إلى `send-push` حُذف بينما بقي هوك آخر غير متعلق.
- اختبار RLS/الصلاحيات: نجح.
- `npm test`: نجحت المجموعة الكاملة.
- `npm run check` (صياغة التطبيق + ESLint + TypeScript): نجحت.

## 7) حد الضمان

لا يمكن تقنياً ضمان ظهور الإشعار على 100% من الهواتف بسبب الإذن ووضع توفير الطاقة وDND والشبكة وسياسات النظام/المتصفح. ما تم إصلاحه والتحقق منه هو عقد الخادم والحمولة والمصادقة ومعالجة الأخطاء. `200` من الدالة و`sent=1` يثبتان قبول FCM، وليس ضمان عرض النظام للإشعار.

## مراجع

[1](https://supabase.com/docs/guides/functions/error-codes) — Supabase Edge Functions error codes، ومنها `UNAUTHORIZED_NO_AUTH_HEADER`.  
[2](https://supabase.com/docs/guides/database/webhooks) — Database Webhooks، دعم GET/POST وبنيتها كتريغرات.  
[3](https://supabase.com/docs/guides/database/extensions/pg_net) — `net.http_post` وتنفيذه غير المتزامن وسجلاته.  
[4](https://supabase.com/docs/guides/database/vault) — تخزين الأسرار وتحديثها في Supabase Vault.
