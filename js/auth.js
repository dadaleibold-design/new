import { supabase } from "./supabaseClient.js";
import { isAdminEmail } from "./config.js";

/* ============================================================
 * منطق المصادقة
 * ------------------------------------------------------------
 *  - المستخدم العادي: يسجّل ويدخل بـ (اسم المستخدم + رقم الهاتف + كلمة المرور).
 *    لا نعتمد على مزوّد SMS في Supabase؛ بل نشتق بريداً داخلياً ثابتاً من رقم
 *    الهاتف (phone.<digits>@users.local) ونستخدم مصادقة البريد/كلمة المرور
 *    تحت الغطاء. الرقم الحقيقي يُحفظ في profiles.phone وفي user_metadata.
 *  - المشرف: يسجّل ويدخل بالبريد الإلكتروني المعتمد في قائمة المشرفين فقط.
 *  - واجهة الدخول تُميّز تلقائياً: وجود "@" ⇒ بريد (مشرف)، غير ذلك ⇒ هاتف (مستخدم).
 * ============================================================ */

export const PHONE_EMAIL_DOMAIN = "users.local";

const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";

/** يحوّل الأرقام العربية/الفارسية إلى لاتينية ويُبقي الأرقام فقط */
export function normalizePhone(raw) {
  let value = String(raw || "").trim();
  if (!value) return "";
  value = value.replace(/[٠-٩]/g, (d) => String(ARABIC_DIGITS.indexOf(d)));
  value = value.replace(/[۰-۹]/g, (d) => String(PERSIAN_DIGITS.indexOf(d)));
  // 00 في البداية تعني رمز دولي
  value = value.replace(/^\s*00/, "+");
  const hasPlus = value.startsWith("+");
  const digits = value.replace(/\D/g, "");
  if (!digits) return "";
  return hasPlus ? `+${digits}` : digits;
}

export function isValidPhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  return digits.length >= 7 && digits.length <= 15;
}

/** البريد الداخلي المشتق من رقم الهاتف (يُستخدم لمصادقة Supabase فقط) */
export function phoneToAuthEmail(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  return `phone.${digits}@${PHONE_EMAIL_DOMAIN}`;
}

export function isPhoneAuthEmail(email) {
  return /^phone\.\d+@users\.local$/i.test(String(email || ""));
}

export function looksLikeEmail(value) {
  return String(value || "").includes("@");
}

function friendlyAuthError(error) {
  const msg = String(error?.message || "");
  if (/invalid login credentials/i.test(msg)) {
    return new Error("بيانات الدخول غير صحيحة — تحقق من الرقم/البريد وكلمة المرور.");
  }
  if (/user already registered|already been registered/i.test(msg)) {
    return new Error("هذا الحساب مسجّل مسبقاً — سجّل الدخول بدلاً من ذلك.");
  }
  if (/password should be at least/i.test(msg)) {
    return new Error("كلمة المرور يجب ألا تقل عن 6 أحرف.");
  }
  if (/email not confirmed/i.test(msg)) {
    return new Error("البريد غير مؤكد — راجع صندوق الوارد أو عطّل تأكيد البريد من إعدادات Supabase.");
  }
  if (/rate limit/i.test(msg)) {
    return new Error("محاولات كثيرة — انتظر قليلاً ثم أعد المحاولة.");
  }
  if (/failed to fetch|networkerror|network request failed/i.test(msg)) {
    return new Error("تعذّر الاتصال بالخادم — تحقق من الإنترنت.");
  }
  return error instanceof Error ? error : new Error(msg || "حدث خطأ غير متوقع.");
}

/**
 * إنشاء حساب.
 *  - مستخدم عادي: displayName + phone + password (email فارغ).
 *  - مشرف: displayName + email (معتمد) + password (+ phone اختياري).
 */
export async function signUp({ email, password, displayName, phone }) {
  const normalizedEmail = (email || "").trim().toLowerCase();
  const normalizedPhone = normalizePhone(phone);
  const name = (displayName || "").trim();

  if (!name) throw new Error("اسم المستخدم مطلوب.");
  if (!password || password.length < 6) throw new Error("كلمة المرور يجب ألا تقل عن 6 أحرف.");

  const adminSignup = Boolean(normalizedEmail);

  if (adminSignup && !isAdminEmail(normalizedEmail)) {
    throw new Error("البريد الإلكتروني مخصص للمشرفين المعتمدين فقط. سجّل برقم الهاتف كمستخدم.");
  }

  if (!adminSignup) {
    if (!normalizedPhone) throw new Error("رقم الهاتف مطلوب لإنشاء حساب مستخدم.");
    if (!isValidPhone(normalizedPhone)) throw new Error("رقم الهاتف غير صالح.");
  }

  const authEmail = adminSignup ? normalizedEmail : phoneToAuthEmail(normalizedPhone);

  const { data, error } = await supabase.auth.signUp({
    email: authEmail,
    password,
    options: {
      data: {
        display_name: name,
        phone: normalizedPhone || null,
        account_type: adminSignup ? "admin" : "user",
      },
    },
  });
  if (error) throw friendlyAuthError(error);

  // Supabase يعيد user بلا identities عندما يكون البريد مسجّلاً مسبقاً
  if (data?.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
    throw new Error("هذا الحساب مسجّل مسبقاً — سجّل الدخول بدلاً من ذلك.");
  }

  // الـ trigger في قاعدة البيانات ينشئ الصف؛ هذا upsert احتياطي فقط عند توفّر جلسة
  if (data?.user && data?.session) {
    await supabase
      .from("profiles")
      .upsert(
        {
          id: data.user.id,
          email: adminSignup ? normalizedEmail : null,
          display_name: name,
          phone: normalizedPhone || null,
        },
        { onConflict: "id" }
      );
  }

  return { ...data, authEmail, accountType: adminSignup ? "admin" : "user" };
}

/**
 * تسجيل الدخول.
 *  - identity يحوي "@"  ⇒ بريد مشرف ⇒ يجب أن يكون معتمداً وأن يكون الحساب is_admin.
 *  - غير ذلك ⇒ رقم هاتف ⇒ مستخدم عادي.
 * يُرجع { session, user, role }.
 */
export async function signIn({ identity, password }) {
  const value = String(identity || "").trim();
  if (!value) throw new Error("أدخل رقم الهاتف أو بريد المشرف.");
  if (!password) throw new Error("أدخل كلمة المرور.");

  const emailLogin = looksLikeEmail(value);
  let data;

  if (emailLogin) {
    const email = value.toLowerCase();
    if (!isAdminEmail(email)) {
      throw new Error("تسجيل الدخول بالبريد متاح للمشرفين المعتمدين فقط — استخدم رقم الهاتف.");
    }
    const res = await supabase.auth.signInWithPassword({ email, password });
    if (res.error) throw friendlyAuthError(res.error);
    data = res.data;
  } else {
    const phone = normalizePhone(value);
    if (!isValidPhone(phone)) throw new Error("رقم الهاتف غير صالح.");

    // المسار الأساسي: البريد الداخلي المشتق من الرقم
    let res = await supabase.auth.signInWithPassword({
      email: phoneToAuthEmail(phone),
      password,
    });

    // توافق خلفي: حسابات أُنشئت سابقاً عبر مزوّد الهاتف في Supabase
    if (res.error && /invalid login credentials/i.test(res.error.message || "")) {
      const legacy = await supabase.auth.signInWithPassword({ phone, password });
      if (!legacy.error) res = legacy;
    }

    if (res.error) throw friendlyAuthError(res.error);
    data = res.data;
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("id,is_admin,is_super_admin,is_blocked")
    .eq("id", data.user.id)
    .maybeSingle();

  if (profile?.is_blocked) {
    await supabase.auth.signOut();
    throw new Error("تم حظر هذا الحساب. تواصل مع المشرف.");
  }

  const role = emailLogin ? "admin" : "user";

  if (emailLogin && profile && !profile.is_admin && !profile.is_super_admin) {
    await supabase.auth.signOut();
    throw new Error("هذا الحساب ليس مشرفاً — لا يمكن الدخول بالبريد الإلكتروني.");
  }

  try {
    sessionStorage.setItem("wa_login_role", role);
  } catch {
    /* تجاهل */
  }

  await supabase
    .from("profiles")
    .update({ is_online: true, last_seen: new Date().toISOString() })
    .eq("id", data.user.id);

  return { ...data, role };
}

export async function signOut(userId) {
  if (userId) {
    try {
      // حضور المشرف ثابت ودائم: لا نُعلنه "غير متصل" عند الخروج، وإلا ظهر
      // للمستخدم العادي كأنه منقطع فور سكون/خروج متصفح المشرف.
      const { data: profile } = await supabase
        .from("profiles")
        .select("is_admin,is_super_admin")
        .eq("id", userId)
        .maybeSingle();

      const isAdmin = Boolean(profile?.is_admin || profile?.is_super_admin);
      if (isAdmin) {
        await supabase
          .from("profiles")
          .update({ is_online: true, last_seen: new Date().toISOString() })
          .eq("id", userId);
      } else {
        await supabase
          .from("profiles")
          .update({ is_online: false, last_seen: new Date().toISOString() })
          .eq("id", userId);
      }
    } catch {
      /* لا تمنع تسجيل الخروج */
    }
  }
  try {
    sessionStorage.removeItem("wa_login_role");
  } catch {
    /* تجاهل */
  }
  await supabase.auth.signOut();
}

export async function getCurrentProfile() {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const user = session?.user;
  if (!user) return null;
  const { data: profile } = await supabase.from("profiles").select("*").eq("id", user.id).single();
  if (profile && isPhoneAuthEmail(profile.email)) {
    // لا تعرض البريد الداخلي المشتق للمستخدم أبداً
    profile.email = null;
  }
  return profile;
}
