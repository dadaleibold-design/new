/*
 * اختبار صلاحيات المشرف العام الكاملة (v2.13) — فحوص ثابتة بلا قاعدة بيانات
 * -------------------------------------------------------------
 * يحمي التعديل من الانحدار:
 *   • schema.sql §19 = ملف الهجرة v2.13 حرفياً (لا انحراف بين الملفين).
 *   • سياسات الكتابة الأربع (conversations/messages/typing/reactions) موجودة
 *     ومقيّدة بـ is_super_admin_user().
 *   • توجيه إشعار ردّ المشرف العام ⇒ المستخدم صاحب المحادثة (الدالتان + الـ Edge).
 *   • ما يبقى قراءة فقط موثّق (المكالمات/إدارة المستخدمين).
 *
 * الفحوص السلوكية على PostgreSQL حقيقي: tests/rls-hardening-postgres.mjs (§3).
 * التشغيل: node tests/super-admin-write.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

let fails = 0;
const check = (name, ok, extra = "") => {
  console.log(ok ? "✅" : "❌", name, extra ? `— ${extra}` : "");
  if (!ok) fails += 1;
};

const SCHEMA = read("sql/schema.sql");
const MIGRATION_PATH = "sql/migrations/2026-10-15_v2_13_super_admin_full_write.sql";
const MIGRATION = fs.existsSync(path.join(ROOT, MIGRATION_PATH)) ? read(MIGRATION_PATH) : "";
const SEND_PUSH = read("supabase/functions/send-push/index.ts");

/* ---------- 1) الهجرة موجودة ومطابقة لقسم 19 في schema.sql ---------- */
check("هجرة v2.13 موجودة (2026-10-15)", MIGRATION.includes("Migration v2.13 (2026-10-15)"));

const section19Start = SCHEMA.indexOf("19. الإصدار v2.13");
const section20Start = SCHEMA.indexOf("20. الإصدار v2.14", section19Start);
const section20Separator = section20Start >= 0
  ? SCHEMA.lastIndexOf("-- ============================================================", section20Start)
  : -1;
const section19 = SCHEMA.slice(section19Start, section20Separator >= 0 ? section20Separator : undefined);
const marker = "-- ------------------------------------------------------------\n-- ① ";
const migBody = MIGRATION.slice(MIGRATION.indexOf(marker)).trimEnd();
const schemaBody = section19.slice(section19.indexOf(marker)).trimEnd();
check("schema.sql §19 = ملف الهجرة v2.13 حرفياً", migBody.length > 100 && migBody === schemaBody);

/* ---------- 2) سياسات الكتابة الأربع للمشرف العام ---------- */
for (const policy of [
  "conversations write superadmin",
  "messages write superadmin",
  "typing full access superadmin",
  "reactions full access superadmin",
]) {
  const re = new RegExp(`create policy "${policy}" on public\\.\\w+\\s*\\n\\s*for all using \\(public\\.is_super_admin_user\\(\\)\\)\\s*\\n\\s*with check \\(public\\.is_super_admin_user\\(\\)\\)`);
  check(`سياسة "${policy}" = FOR ALL مقيّدة بـ is_super_admin_user (في المخطط والهجرة)`,
    re.test(SCHEMA) && re.test(MIGRATION));
}

// سياسات القراءة القائمة (v2.9/v2.11) تبقى — الكتابة تُضاف بجانبها لا مكانها
check("سياسات القراءة القائمة للمشرف العام باقية (read superadmin)",
  SCHEMA.includes("conversations read superadmin") && SCHEMA.includes("messages read superadmin"));

/* ---------- 3) توجيه إشعار ردّ المشرف العام ⇒ صاحب المحادثة ---------- */
// التعريف الأخير هو المعتمد (الأقسام اللاحقة تعيد تعريف الدوال — §19 هنا)
const recipientFn = [...SCHEMA.matchAll(/create or replace function public\.conversation_direct_recipient[\s\S]*?\$\$;/g)].pop()?.[0] || "";
check(
  "conversation_direct_recipient: فرع المشرف العام ⇒ c.user_id",
  /when exists \([\s\S]*?sp\.is_super_admin[\s\S]*?\)\s*then c\.user_id/.test(recipientFn),
);
check(
  "conversation_direct_recipient: أطراف المحادثة يبقى حسابهما أولى (فرعا user/admin قبل فرع المشرف العام)",
  recipientFn.indexOf("c.user_id = p_sender_id") < recipientFn.indexOf("sp.is_super_admin"),
);

const gateFn = [...SCHEMA.matchAll(/create or replace function public\.push_recipient_allowed[\s\S]*?\nend;\n\$\$;/g)].pop()?.[0] || "";
check(
  "push_recipient_allowed: يسمح بردّ المشرف العام إلى c.user_id حصراً",
  /sp\.is_super_admin[\s\S]{0,200}c\.user_id = p_recipient/.test(gateFn),
);
check(
  "push_recipient_allowed: أزواج الأطراف الأصلية باقية (user↔admin)",
  /c\.user_id = v_sender and c\.admin_id = p_recipient/.test(gateFn) &&
    /c\.admin_id = v_sender and c\.user_id = p_recipient/.test(gateFn),
);

/* ---------- 4) الـ Edge Function يطابق بوابة قاعدة البيانات ---------- */
check(
  "send-push يقرأ is_super_admin من الملف الشخصي (مصدر الحقيقة)",
  SEND_PUSH.includes('.select("display_name, is_super_admin")'),
);
check(
  "send-push: conversationCounterpart بثلاثة وسيطات وفرع المشرف العام",
  /function conversationCounterpart\([\s\S]*?senderIsSuperAdmin = false[\s\S]*?if \(senderIsSuperAdmin\) return conversation\.user_id \|\| null;/.test(SEND_PUSH),
);
check(
  "send-push: الرفض المكتوم للمرسل غير الطرف باقٍ (غير المشرف العام)",
  SEND_PUSH.includes('refuse("sender is not a conversation party")'),
);

/* ---------- 5) حدود الصلاحية موثّقة (ما يبقى قراءة فقط) ---------- */
check(
  "توثيق القسم: المكالمات وإدارة المستخدمين تبقى قراءة فقط",
  section19.includes("يبقى قراءة فقط: غرف المكالمات وسجلاتها، وإدارة المستخدمين"),
);
check(
  "توثيق القسم: حماية الرسائل من العبث باقية",
  section19.includes("protect_message_immutable_fields"),
);

/* ---------- 6) الاختبار مُدرج في npm test ---------- */
const pkg = JSON.parse(read("package.json"));
check("npm test يشغّل اختبار صلاحيات المشرف العام", pkg.scripts.test.includes("tests/super-admin-write.mjs"));

console.log(fails ? `\n❌ SUPER ADMIN WRITE TESTS FAILED: ${fails}` : "\nSUPER ADMIN WRITE TESTS PASSED");
process.exit(fails ? 1 : 0);
