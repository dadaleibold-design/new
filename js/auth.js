import { supabase } from "./supabaseClient.js";
import { isAdminEmail } from "./config.js";

export async function signUp({ email, password, displayName, phone }) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { display_name: displayName, phone: phone || null },
    },
  });
  if (error) throw error;

  if (data.user) {
    await supabase
      .from("profiles")
      .upsert(
        {
          id: data.user.id,
          email,
          display_name: displayName,
          phone: phone || null,
          is_admin: isAdminEmail(email),
        },
        { onConflict: "id" }
      );
  }
  return data;
}

export async function signIn({ email, password }) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
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
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: profile } = await supabase.from("profiles").select("*").eq("id", user.id).single();
  return profile;
}
