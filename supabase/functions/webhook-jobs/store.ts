// Postgres behind JobsStore. Pass a client built with the secret key (service_role):
// webhook_events and writes to bookings are server only.

import type { SupabaseClient } from "@supabase/supabase-js";
import { UNKNOWN_APPOINTMENT } from "../boulevard-webhook/process.ts";
import type { JobsStore } from "./handler.ts";

type EventRecord = { provider: string; event_id: string; type: string; payload: unknown };
type HeldRecord = { id: string; provider: string; provider_session_id: string | null };

export const createJobsStore = (admin: SupabaseClient): JobsStore => {
  /** How many rows match, without fetching them. */
  const count = async (query: PromiseLike<{ count: number | null; error: unknown }>) => {
    const { count, error } = await query;
    if (error) throw error;
    return count ?? 0;
  };
  const unprocessed = () => admin.from("webhook_events").select("*", { count: "exact", head: true }).is("processed_at", null);

  return {
    async retryableEvents(before, maxAttempts, limit) {
      // Served by webhook_events_unprocessed_idx (received_at, where processed_at is null).
      const { data, error } = await admin
        .from("webhook_events")
        .select("provider, event_id, type, payload")
        .is("processed_at", null)
        .lt("attempts", maxAttempts)
        .lt("received_at", before)
        .order("received_at")
        .limit(limit);
      if (error) throw error;
      return (data as EventRecord[]).map((r) => ({ provider: r.provider, eventId: r.event_id, type: r.type, payload: r.payload }));
    },
    async deadLetters(maxAttempts) {
      const total = await count(unprocessed().gte("attempts", maxAttempts));
      const waitingForCreated = await count(unprocessed().gte("attempts", maxAttempts).eq("last_error", UNKNOWN_APPOINTMENT));
      return { waitingForCreated, failed: total - waitingForCreated };
    },
    async staleHeld(before, limit) {
      const { data, error } = await admin
        .from("bookings")
        .select("id, provider, provider_session_id")
        .eq("status", "held")
        .not("provider_session_id", "is", null)
        .lt("created_at", before)
        .order("created_at")
        .limit(limit);
      if (error) throw error;
      return (data as HeldRecord[]).map((r) => ({ id: r.id, provider: r.provider, providerSessionId: r.provider_session_id }));
    },
    async confirmHeld(id, confirmationId) {
      const { error } = await admin.from("bookings").update({ status: "confirmed", provider_booking_id: confirmationId }).eq("id", id).eq("status", "held");
      if (error) throw error;
    },
    async expireHeld(id) {
      const { error } = await admin.from("bookings").update({ status: "expired" }).eq("id", id).eq("status", "held");
      if (error) throw error;
    },
    async activity(since, until) {
      const confirmed = await count(
        admin.from("bookings").select("*", { count: "exact", head: true }).eq("status", "confirmed").gte("created_at", since).lt("created_at", until),
      );
      const webhooks = await count(admin.from("webhook_events").select("*", { count: "exact", head: true }).gte("received_at", since));
      return { confirmed, webhooks };
    },
  };
};
