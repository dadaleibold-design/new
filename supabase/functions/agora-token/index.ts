// إصدار توكن Agora قصير العمر. لا تضع App Certificate في الواجهة الأمامية.
//
// كل الأسرار تُقرأ حصرياً من Deno.env.get() (Supabase Edge Function secrets):
//   AGORA_APP_ID            — معرّف مشروع Agora (عام، يُستخدم لتوليد التوكن)
//   AGORA_APP_CERTIFICATE   — الشهادة السرّية (سيرفرية فقط، لا تظهر أبداً للعميل)
//   SUPABASE_URL            — يُضبط تلقائياً في بيئة Supabase
//   SUPABASE_ANON_KEY       — يُضبط تلقائياً في بيئة Supabase
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { RtcRole, RtcTokenBuilder } from "https://esm.sh/agora-access-token@2.0.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const AGORA_APP_ID = Deno.env.get("AGORA_APP_ID") ?? "";
const AGORA_APP_CERTIFICATE = Deno.env.get("AGORA_APP_CERTIFICATE") ?? "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);

    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      console.error("agora-token: SUPABASE_URL / SUPABASE_ANON_KEY are not configured");
      return json({ error: "Authentication service is not configured" }, 503);
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) return json({ error: "Unauthorized" }, 401);

    const { channelName, uid } = await req.json();
    if (!/^[a-zA-Z0-9_]{1,64}$/.test(String(channelName || ""))) {
      return json({ error: "Invalid channel" }, 400);
    }
    const numericUid = Number(uid);
    if (!Number.isInteger(numericUid) || numericUid < 1) {
      return json({ error: "Invalid uid" }, 400);
    }

    // 🔒 التفويض (v2.11): اسم القناة = "wa_<conversationId بلا شرطات>" (راجع buildAgoraChannelName).
    //    لا توكن إلا لطرف في تلك المحادثة وغير محظور. الاستعلام بعميل المستخدم نفسه،
    //    فيحصره RLS على صفوف المستخدم (لا مفتاح خدمة هنا). المشرف العام ليس طرفاً ⇒ مرفوض.
    const channelMatch = /^wa_([0-9a-fA-F]{32})$/.exec(String(channelName));
    if (!channelMatch) return json({ error: "Invalid channel" }, 400);
    const h = channelMatch[1].toLowerCase();
    const conversationId = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;

    const { data: participant, error: participantError } = await supabase
      .from("conversations")
      .select("id")
      .eq("id", conversationId)
      .maybeSingle();
    if (participantError) {
      console.error("agora-token: participant check failed", participantError.message);
      return json({ error: "Unable to verify call participation" }, 500);
    }
    if (!participant) return json({ error: "Forbidden" }, 403);

    const { data: me, error: meError } = await supabase
      .from("profiles")
      .select("is_blocked")
      .eq("id", user.id)
      .maybeSingle();
    if (meError) return json({ error: "Unable to verify account" }, 500);
    if (!me || me.is_blocked) return json({ error: "Forbidden" }, 403);

    const appId = AGORA_APP_ID;
    const appCertificate = AGORA_APP_CERTIFICATE;
    if (!appId || !appCertificate) {
      console.error("agora-token: AGORA_APP_ID / AGORA_APP_CERTIFICATE are not configured");
      return json({ error: "Agora token service is not configured" }, 503);
    }

    const expiresInSeconds = 3600;
    const privilegeExpiredTs = Math.floor(Date.now() / 1000) + expiresInSeconds;
    const token = RtcTokenBuilder.buildTokenWithUid(
      appId,
      appCertificate,
      channelName,
      numericUid,
      RtcRole.PUBLISHER,
      privilegeExpiredTs,
    );

    return json({ token, uid: numericUid, expiresAt: privilegeExpiredTs });
  } catch (error) {
    console.error("agora-token:", error);
    return json({ error: "Unable to issue Agora token" }, 500);
  }
});
