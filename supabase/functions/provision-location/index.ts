// LGU "Create new trailhead + admin + guides" wizard.
// Called by an authenticated super_admin / central LGU user.
// Creates: a `locations` row, an admin auth user (with user_locations mapping),
// and N guide auth users (each with `guides` row + user_locations).
//
// Body shape:
// {
//   location: { name, slug, lgu, region, address, description,
//               center_lat, center_lng, entry_fee, default_guide_fee },
//   admin: { email, password, full_name, phone },
//   guides: [{ email, password, full_name, per_trip_fee, languages, specialty }]
// }

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.48.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const auth = req.headers.get("Authorization") ?? "";
    if (!auth.startsWith("Bearer ")) {
      return json({ error: "Unauthorized" }, 401);
    }
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

    // Verify caller is super_admin
    const callerClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: auth } },
      auth: { persistSession: false },
    });
    const { data: { user }, error: userErr } = await callerClient.auth.getUser();
    if (userErr || !user) return json({ error: "Invalid token" }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
    const { data: roleRow } = await admin
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .eq("role", "super_admin")
      .maybeSingle();
    if (!roleRow) return json({ error: "Only Central LGU can provision locations" }, 403);

    const body = await req.json();
    const loc = body.location ?? {};
    const adminPayload = body.admin ?? {};
    const guides: any[] = Array.isArray(body.guides) ? body.guides : [];

    if (!loc.name || !loc.slug) return json({ error: "Location name and slug required" }, 400);
    if (!adminPayload.email || !adminPayload.password) return json({ error: "Admin email/password required" }, 400);

    // 1. Create location
    const { data: locRow, error: locErr } = await admin
      .from("locations")
      .insert({
        name: loc.name,
        slug: loc.slug,
        lgu: loc.lgu ?? "",
        region: loc.region ?? "",
        address: loc.address ?? "",
        description: loc.description ?? "",
        center_lat: Number(loc.center_lat) || 14.1475,
        center_lng: Number(loc.center_lng) || 121.3454,
        entry_fee: Number(loc.entry_fee) || 0,
        default_guide_fee: Number(loc.default_guide_fee) || 0,
        status: "active",
      })
      .select()
      .single();
    if (locErr) return json({ error: `Location: ${locErr.message}` }, 400);

    const locationId = locRow.id;
    const created: any = { location: locRow, admin: null, guides: [] };

    // 2. Create admin user
    const { data: adminUser, error: adminUserErr } = await admin.auth.admin.createUser({
      email: adminPayload.email,
      password: adminPayload.password,
      email_confirm: true,
      user_metadata: { full_name: adminPayload.full_name ?? "Trailhead Admin" },
    });
    if (adminUserErr || !adminUser.user) return json({ error: `Admin user: ${adminUserErr?.message}` }, 400);

    await admin.from("user_roles").upsert(
      { user_id: adminUser.user.id, role: "admin" } as any,
      { onConflict: "user_id,role" } as any,
    );
    await admin.from("user_locations").insert({
      user_id: adminUser.user.id,
      location_id: locationId,
      role: "admin",
    } as any);
    created.admin = { id: adminUser.user.id, email: adminPayload.email };

    // 3. Create guide users
    for (const g of guides) {
      if (!g.email || !g.password || !g.full_name) continue;
      const { data: gUser, error: gErr } = await admin.auth.admin.createUser({
        email: g.email,
        password: g.password,
        email_confirm: true,
        user_metadata: { full_name: g.full_name },
      });
      if (gErr || !gUser.user) {
        created.guides.push({ email: g.email, error: gErr?.message });
        continue;
      }
      await admin.from("user_roles").upsert(
        { user_id: gUser.user.id, role: "guide" } as any,
        { onConflict: "user_id,role" } as any,
      );
      await admin.from("user_locations").insert({
        user_id: gUser.user.id,
        location_id: locationId,
        role: "guide",
      } as any);
      await admin.from("guides").insert({
        user_id: gUser.user.id,
        location_id: locationId,
        full_name: g.full_name,
        per_trip_fee: Number(g.per_trip_fee) || Number(loc.default_guide_fee) || 500,
        languages: g.languages ?? "English, Filipino",
        specialty: g.specialty ?? "",
        is_active: true,
      } as any);
      created.guides.push({ id: gUser.user.id, email: g.email });
    }

    return json({ ok: true, ...created });
  } catch (e) {
    console.error(e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

function json(b: unknown, status = 200) {
  return new Response(JSON.stringify(b), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
