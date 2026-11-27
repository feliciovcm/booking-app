import { supabase } from "../lib/supabase";

// The signed-in user's bookings, read straight from Postgres. RLS ("Users read their own
// bookings") is what keeps other people's rows out; the user_id filter is still here so
// the query states its intent and Postgres can use bookings_user_id_idx instead of
// relying on the policy alone.
export async function fetchMyBookings(userId: string) {
  const { data, error } = await supabase
    .from("bookings")
    .select("id, status, slot_start, treatments(name), locations(name, timezone)")
    .eq("user_id", userId)
    // Held and expired rows are checkout attempts, not bookings.
    .in("status", ["confirmed", "cancelled"])
    .order("slot_start");
  if (error) throw error;
  return data.map((r) => ({
    id: r.id,
    status: r.status as "confirmed" | "cancelled",
    start: r.slot_start,
    // Null when RLS hides it (a treatment or clinic made inactive since).
    treatment: r.treatments?.name ?? null,
    location: r.locations?.name ?? null,
    timeZone: r.locations?.timezone ?? "UTC",
  }));
}

export type MyBooking = Awaited<ReturnType<typeof fetchMyBookings>>[number];
