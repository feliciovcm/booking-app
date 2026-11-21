import { useQuery } from "@tanstack/react-query";
import { supabase } from "./supabase";

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

// Config changes rarely, so cache it for the whole visit instead of refetching per step.
const CONFIG_STALE_TIME = 10 * 60 * 1000;

export const useTreatments = () =>
  useQuery({ queryKey: ["treatments"], queryFn: fetchTreatments, staleTime: CONFIG_STALE_TIME });

export const useLocations = () =>
  useQuery({ queryKey: ["locations"], queryFn: fetchLocations, staleTime: CONFIG_STALE_TIME });

export const formatPrice = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(
    cents / 100,
  );
