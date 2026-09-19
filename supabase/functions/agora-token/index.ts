// إصدار توكن Agora قصير العمر. لا تضع App Certificate في الواجهة الأمامية.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { RtcRole, RtcTokenBuilder } from "https://esm.sh/agora-access-token@2.0.0";

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

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
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

    const appId = Deno.env.get("AGORA_APP_ID");
    const appCertificate = Deno.env.get("AGORA_APP_CERTIFICATE");
    if (!appId || !appCertificate) return json({ error: "Agora token service is not configured" }, 503);

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
