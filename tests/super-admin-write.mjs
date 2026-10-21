/*
 * اختبار صلاحيات المشرف العام الكاملة (v2.13) — فحوص ثابتة بلا قاعدة بيانات
 * -------------------------------------------------------------
 * يحمي التعديل من الانحدار:
 *   • سياسات الكتابة الأربع (conversations/messages/typing/reactions) موجودة
 *     ومقيّدة بـ is_super_admin_user() في المخطط والهجرة.
 *   • توجيه إشعار ردّ المشرف العام ⇒ المستخدم صاحب المحادثة (recipients.ts
 *     في دالة send-push — بعد إزالة دوال الإشعارات من القاعدة في v3.0).
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

/* ---------- 1) الهجرة موجودة وتوثّق حدود الصلاحية ---------- */
check("هجرة v2.13 موجودة (2026-10-15)", MIGRATION.includes("Migration v2.13 (2026-10-15)"));

const section19Start = SCHEMA.indexOf("19. الإصدار v2.13");
const section20Start = SCHEMA.indexOf("20. الإصدار v2.14", section19Start);
const section20Separator = section20Start >= 0
  ? SCHEMA.lastIndexOf("-- ============================================================", section20Start)
  : -1;
const section19 = SCHEMA.slice(section19Start, section20Separator >= 0 ? section20Separator : undefined);
check(
  "توثيق القسم: المكالمات وإدارة المستخدمين تبقى قراءة فقط",
  section19.includes("يبقى قراءة فقط: غرف المكالمات وسجلاتها، وإدارة المستخدمين"),
);
check(
  "توثيق القسم: حماية الرسائل من العبث باقية",
  section19.includes("protect_message_immutable_fields"),
);

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

/* ---------- 3) توجيه إشعار ردّ المشرف العام ⇒ صاحب المحادثة (v3.0) ---------- */
// بعد إزالة دوال الإشعارات من القاعدة، القاعدة الوحيدة صارت في recipients.ts
const { messageRecipient } = await import("../supabase/functions/send-push/recipients.ts");
const RECIPIENTS = read("supabase/functions/send-push/recipients.ts");
const CONV = { id: "c-1", user_id: "U", admin_id: "A" };

check(
  "recipients: المشرف العام الذي يردّ في محادثة ليس طرفاً فيها ⇒ العميل (c.user_id)",
  messageRecipient(CONV, "S", true).recipientId === "U",
);
check(
  "recipients: أطراف المحادثة أولى بالحساب (user ⇒ admin، admin ⇒ user)",
  messageRecipient(CONV, "U", false).recipientId === "A" &&
    messageRecipient(CONV, "A", false).recipientId === "U",
);
check(
  "recipients: مرسل غريب ليس مشرفاً عاماً ⇒ لا إشعار",
  messageRecipient(CONV, "X", false).allowed === false,
);
check(
  "recipients: لا بث للمشرفين في مسار الرسائل (لا admin_recipient_ids)",
  !/admin_recipient_ids|loadAdminIds/.test(RECIPIENTS),
);

/* ---------- 4) دالة send-push تطبّق نفس القاعدة ---------- */
check(
  "send-push يقرأ is_super_admin من الملف الشخصي (مصدر الحقيقة)",
  SEND_PUSH.includes('.select("id, display_name, avatar_url, is_admin, is_super_admin")'),
);
check(
  "send-push يفوّض اختيار المستلم إلى recipients.ts",
  SEND_PUSH.includes("messageRecipient(") && SEND_PUSH.includes("callRecipient("),
);
check(
  "send-push: رفض مكتوم للمرسل غير الطرف (sender is not a conversation party)",
  RECIPIENTS.includes('reason: "sender is not a conversation party"'),
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
