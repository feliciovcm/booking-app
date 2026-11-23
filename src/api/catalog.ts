import { supabase } from "../lib/supabase";

// Public config, read straight from Postgres with the anon key.
// RLS already hides inactive rows; we still list columns explicitly so the
// client only depends on what it uses.

export async function fetchTreatments() {
  const { data, error } = await supabase
    .from("treatments")
    .select("id, slug, name, description, price_cents, session_count")
    .order("sort_order");
  if (error) throw error;
  return data;
}

export async function fetchLocations() {
  const { data, error } = await supabase
    .from("locations")
    .select("id, slug, name, address, timezone")
    .order("sort_order");
  if (error) throw error;
  return data;
}

export type Treatment = Awaited<ReturnType<typeof fetchTreatments>>[number];
export type Location = Awaited<ReturnType<typeof fetchLocations>>[number];
