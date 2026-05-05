// Escalates SOS alerts that have stayed "active" for >= 1 hour.
// Marks them status='escalated' so super_admin / LGU dashboards can prioritize.
// Designed to be invoked by pg_cron every minute.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.48.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );

    const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from("sos_alerts")
      .update({ status: "escalated", escalated_at: new Date().toISOString() })
      .eq("status", "active")
      .lte("created_at", cutoff)
      .select("id,user_id,location_id");

    if (error) throw error;

    return new Response(JSON.stringify({ escalated: data?.length ?? 0, ids: data ?? [] }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
