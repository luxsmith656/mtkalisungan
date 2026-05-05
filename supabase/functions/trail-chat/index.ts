import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.48.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const SYSTEM_PROMPT = `You are the Mount Kalisungan Trail AI Assistant — an expert guide for Mount Kalisungan (622m) in Calauan, Laguna, Philippines.

GENERAL FACTS:
- Elevation: 622m. Beginner-to-moderate difficulty.
- Best season: November–May (dry). Avoid June–October typhoon season.
- Typical summit time: 2–4 hours.
- Always register at the trailhead. Bring 2L water, sun protection, rain gear, and a fully charged phone.
- For real emergencies, instruct the hiker to use the in-app SOS and call local PNP/BFP/PDRRMO immediately.

When the user is in the BOOKING flow, help them choose a date, start time, group size, preferred guide, and answer trail-condition / safety questions.

If structured "LIVE TRAIL CONTEXT" is supplied below, treat it as the most reliable source for trail status, checkpoints, fees, and capacity at the chosen starting location. Always prefer it over generic knowledge and clearly say when info comes from live data.

Keep responses helpful, concise (under ~180 words), and safety-focused.`;

async function buildLocationContext(locationId: string | null) {
  if (!locationId) return "";
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) return "";

  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const [{ data: loc }, { data: checkpoints }, { data: surveys }, { data: zones }, { data: events }] = await Promise.all([
    supabase.from("locations").select("name,lgu,description,entry_fee,default_guide_fee,status,center_lat,center_lng").eq("id", locationId).maybeSingle(),
    supabase.from("checkpoints").select("name,description,order_index,latitude,longitude").eq("location_id", locationId).order("order_index"),
    supabase.from("checkpoint_surveys").select("experience,notes,created_at").eq("location_id", locationId).order("created_at", { ascending: false }).limit(8),
    supabase.from("trail_zones").select("name,difficulty,elevation_meters,max_capacity,status,description").eq("location_id", locationId).limit(10),
    supabase.from("events_calendar").select("title,event_type,effect,start_date,end_date,notes").or(`location_id.eq.${locationId},location_id.is.null`).gte("end_date", new Date().toISOString().slice(0, 10)).limit(5),
  ]);

  if (!loc) return "";

  const lines: string[] = [];
  lines.push(`LIVE TRAIL CONTEXT — ${loc.name} (${loc.lgu})`);
  lines.push(`Status: ${loc.status}. Entry fee: ₱${loc.entry_fee}. Default guide fee: ₱${loc.default_guide_fee}.`);
  if (loc.description) lines.push(`Notes: ${loc.description}`);

  if (checkpoints?.length) {
    lines.push("\nCheckpoints (in order):");
    checkpoints.forEach((c: any) => {
      lines.push(`  ${c.order_index ?? "?"}. ${c.name}${c.description ? ` — ${c.description}` : ""}`);
    });
  }

  if (zones?.length) {
    lines.push("\nTrail zones:");
    zones.forEach((z: any) =>
      lines.push(`  - ${z.name} [${z.difficulty}, ${z.elevation_meters}m, cap=${z.max_capacity}, ${z.status}] ${z.description ?? ""}`),
    );
  }

  if (surveys?.length) {
    const concerns = surveys.filter((s: any) => s.experience !== "good");
    lines.push(`\nRecent hiker trail-condition reports (latest ${surveys.length}):`);
    surveys.forEach((s: any) =>
      lines.push(`  - ${new Date(s.created_at).toISOString().slice(0, 10)} • ${s.experience}${s.notes ? ` — ${s.notes}` : ""}`),
    );
    if (concerns.length) lines.push(`  ⚠ ${concerns.length}/${surveys.length} reports flagged concerns; mention this if asked about trail conditions.`);
  }

  if (events?.length) {
    lines.push("\nUpcoming events / calendar effects:");
    events.forEach((e: any) =>
      lines.push(`  - ${e.start_date}→${e.end_date}: ${e.title} (${e.event_type}, ${e.effect}) ${e.notes ?? ""}`),
    );
  }

  return lines.join("\n");
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const body = await req.json();
    const messages = body.messages ?? [];
    const locationId: string | null = body.location_id ?? body.locationId ?? null;
    const bookingContext = body.booking_context ?? null; // { date, hike_type, group_size, preferred_guide_name }

    const AI_API_KEY = Deno.env.get("AI_API_KEY") ?? Deno.env.get("LOVABLE_API_KEY");
    if (!AI_API_KEY) throw new Error("AI_API_KEY is not configured");
    const AI_GATEWAY_URL = Deno.env.get("AI_GATEWAY_URL") ?? "https://ai.gateway.lovable.dev";
    const AI_MODEL = Deno.env.get("AI_MODEL") ?? "google/gemini-3-flash-preview";

    const ragContext = await buildLocationContext(locationId);

    const sysMessages: { role: string; content: string }[] = [
      { role: "system", content: SYSTEM_PROMPT },
    ];
    if (ragContext) {
      sysMessages.push({
        role: "system",
        content: `Use this fresh data as ground truth:\n\n${ragContext}`,
      });
    }
    if (bookingContext) {
      sysMessages.push({
        role: "system",
        content:
          `The user is currently booking. Context: date=${bookingContext.date ?? "?"}, ` +
          `hike_type=${bookingContext.hike_type ?? "?"}, group_size=${bookingContext.group_size ?? "?"}` +
          (bookingContext.preferred_guide_name ? `, preferred_guide=${bookingContext.preferred_guide_name}` : "") +
          `. Tailor advice (timing, gear, guide, fees) to this booking.`,
      });
    }

    const response = await fetch(`${AI_GATEWAY_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${AI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: AI_MODEL,
        messages: [...sysMessages, ...messages],
        stream: true,
      }),
    });

    if (!response.ok) {
      if (response.status === 429) {
        return new Response(JSON.stringify({ error: "Rate limit exceeded. Please try again in a moment." }), {
          status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (response.status === 402) {
        return new Response(JSON.stringify({ error: "AI usage limit reached. Please add credits." }), {
          status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const t = await response.text();
      console.error("AI gateway error:", response.status, t);
      return new Response(JSON.stringify({ error: "AI service error" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(response.body, {
      headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
    });
  } catch (e) {
    console.error("chat error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
