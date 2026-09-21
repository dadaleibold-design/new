import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

export const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    storage: window.localStorage,
    storageKey: "wa_browser_session",
    detectSessionInUrl: false,
  },
  realtime: { params: { eventsPerSecond: 10 } },
});
