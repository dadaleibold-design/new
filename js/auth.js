import { supabase } from "./supabaseClient.js";
import { isAdminEmail } from "./config.js";

export async function signUp({ email, password, displayName, phone }) {
  const normalizedEmail = email?.trim().toLowerCase() || "";
  const normalizedPhone = phone?.trim() || "";

  if (!normalizedPhone) {
    throw new Error("رقم الهاتف مطلوب لإنشاء حساب مستخدم.");
  }
  if (normalizedEmail && !isAdminEmail(normalizedEmail)) {
    throw new Error("البريد الإلكتروني مخصص للمشرفين المعتمدين فقط.");
  }

  const credentials = normalizedEmail
    ? { email: normalizedEmail, password }
    : { phone: normalizedPhone, password };
  const { data, error } = await supabase.auth.signUp({
    ...credentials,
    options: {
      data: { display_name: displayName, phone: normalizedPhone || null },
    },
  });
  if (error) throw error;

  if (data.user) {
    await supabase
      .from("profiles")
      .upsert(
        {
          id: data.user.id,
          email: normalizedEmail || null,
          display_name: displayName,
          phone: normalizedPhone || null,
          is_admin: Boolean(normalizedEmail),
        },
        { onConflict: "id" }
      );
  }
  return data;
}

export async function signIn({ identity, password }) {
  const value = identity?.trim() || "";
  const isEmailLogin = value.includes("@");
  if (!value) throw new Error("أدخل رقم الهاتف أو بريد المشرف.");
  if (isEmailLogin && !isAdminEmail(value)) {
    throw new Error("تسجيل الدخول بالبريد متاح للمشرفين المعتمدين فقط.");
  }

  const { data, error } = await supabase.auth.signInWithPassword(
    isEmailLogin ? { email: value.toLowerCase(), password } : { phone: value, password }
  );
  if (error) throw error;
  const { data: profile } = await supabase.from("profiles").select("is_blocked").eq("id", data.user.id).maybeSingle();
  if (profile?.is_blocked) {
    await supabase.auth.signOut();
    throw new Error("تم حظر هذا الحساب. تواصل مع المشرف.");
  }
  await supabase
    .from("profiles")
    .update({ is_online: true, last_seen: new Date().toISOString() })
    .eq("id", data.user.id);
  return data;
}

export async function signOut(userId) {
  if (userId) {
    await supabase
      .from("profiles")
      .update({ is_online: false, last_seen: new Date().toISOString() })
      .eq("id", userId);
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
  return profile;
}
