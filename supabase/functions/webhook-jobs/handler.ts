// Scheduled jobs for webhooks. pg_cron calls this every 5 minutes through pg_net, with a
// shared secret kept in Vault (see the cron migration). Three jobs, each kept simple:
//
// 1. Retry:     re-run unprocessed events, a fixed number of times, then count them as
//               dead letters. No backoff: every run retries, until the cap.
// 2. Reconcile: a held booking older than any vendor hold either got booked (its checkout
//               response and webhook were both lost) or never will. Ask the vendor once.
// 3. Silence:   bookings were confirmed but no webhook arrived, so Boulevard may have
//               disabled the subscription. Alerts are log lines for now (n8n in step 5b).
//
// It replies 202 before working: pg_net gives up on a response after a few seconds.

import type { BookingProvider } from "../_shared/booking-provider.ts";
import { constantTimeEqual } from "../_shared/boulevard-signature.ts";
import { createLogger, requestIdFrom, type Log, type Sink } from "../_shared/log.ts";
import { processEvent, type Deps as ReceiverDeps, type InboundEvent, type WebhookEventsRepo } from "../boulevard-webhook/handler.ts";

/** Tries per event before it's a dead letter. With a run every 5 minutes, about 50 minutes. */
export const MAX_ATTEMPTS = 10;
/** Leave events this young to the receiver's own background run. */
const RETRY_AFTER_MS = 2 * 60_000;
/** Boulevard holds last 30 minutes; after this, a held booking can't still be checked out. */
const STALE_HELD_MS = 45 * 60_000;
/** Silence check: bookings confirmed in this window should have produced a webhook by now. */
const SILENCE_WINDOW_MS = 60 * 60_000;
const SILENCE_GRACE_MS = 10 * 60_000;
const BATCH = 50;

export type HeldBooking = { id: string; provider: string; providerSessionId: string | null };

/** The queries these jobs need, behind an interface so tests use memory and index.ts uses Postgres. */
export type JobsStore = {
  /** Unprocessed events received before `before`, under the cap, oldest first. */
  retryableEvents(before: string, maxAttempts: number, limit: number): Promise<InboundEvent[]>;
  /** Events at the cap, split by whether they only wait for a CREATED that never came. */
  deadLetters(maxAttempts: number): Promise<{ waitingForCreated: number; failed: number }>;
  /** Held bookings created before `before` that know their vendor session, oldest first. */
  staleHeld(before: string, limit: number): Promise<HeldBooking[]>;
  /** Both only change a row that is still held. */
  confirmHeld(id: string, confirmationId: string): Promise<void>;
  expireHeld(id: string): Promise<void>;
  /** Bookings confirmed with created_at in [since, until), and webhooks received since `since`. */
  activity(since: string, until: string): Promise<{ confirmed: number; webhooks: number }>;
};

export type Deps = {
  cronSecret: string;
  store: JobsStore;
  events: Pick<WebhookEventsRepo, "recordAttempt">;
  process: ReceiverDeps["process"];
  /** Provider name (as stored on bookings) -> a client, for reconciliation. */
  providers: Record<string, (log: Log) => Pick<BookingProvider, "checkoutStatus">>;
  defer: (work: Promise<unknown>) => void;
  now?: () => number;
  sink?: Sink;
};

export function createHandler(deps: Deps): (req: Request) => Promise<Response> {
  return async (req) => {
    const log = createLogger("webhook-jobs", requestIdFrom(req), deps.sink);
    const reply = (status: number, outcome: string) => new Response(JSON.stringify({ outcome }), { status, headers: { "content-type": "application/json" } });

    if (req.method !== "POST") return reply(405, "METHOD_NOT_ALLOWED");
    if (!constantTimeEqual(req.headers.get("x-cron-secret") ?? "", deps.cronSecret)) {
      log.warn("jobs refused", { status: 401 });
      return reply(401, "UNAUTHORIZED");
    }

    deps.defer(runJobs(deps, log));
    return reply(202, "STARTED");
  };
}

async function runJobs(deps: Deps, log: Log): Promise<void> {
  const now = (deps.now ?? Date.now)();
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const summary = { retried: 0, confirmed: 0, expired: 0 };

  // Each job is guarded on its own, so a failing one doesn't stop the others.
  const guarded = async (job: string, run: () => Promise<void>) => {
    try {
      await run();
    } catch (error) {
      log.error("job failed", { job, errorName: error instanceof Error ? error.name : typeof error });
    }
  };

  await guarded("retry", async () => {
    for (const event of await deps.store.retryableEvents(ago(RETRY_AFTER_MS), MAX_ATTEMPTS, BATCH)) {
      await processEvent(deps, event, log); // never throws; the outcome lives on the row
      summary.retried++;
    }
    const dead = await deps.store.deadLetters(MAX_ATTEMPTS);
    // Bookings made outside the funnel end here by design (their CREATED is "not ours").
    if (dead.failed > 0) log.error("webhook dead letters", dead);
    else if (dead.waitingForCreated > 0) log.info("webhook dead letters", dead);
  });

  await guarded("reconcile", async () => {
    for (const booking of await deps.store.staleHeld(ago(STALE_HELD_MS), BATCH)) {
      const make = deps.providers[booking.provider];
      if (!make || !booking.providerSessionId) continue;
      try {
        const { confirmationId } = await make(log).checkoutStatus(booking.providerSessionId);
        if (confirmationId) {
          await deps.store.confirmHeld(booking.id, confirmationId);
          summary.confirmed++;
        } else {
          await deps.store.expireHeld(booking.id);
          summary.expired++;
        }
      } catch (error) {
        // Stays held; the next run asks again.
        log.warn("reconcile failed", { bookingId: booking.id, errorName: error instanceof Error ? error.name : typeof error });
      }
    }
  });

  await guarded("silence", async () => {
    const { confirmed, webhooks } = await deps.store.activity(ago(SILENCE_WINDOW_MS), ago(SILENCE_GRACE_MS));
    if (confirmed > 0 && webhooks === 0) log.error("no webhooks for recent bookings", { confirmedBookings: confirmed });
  });

  log.info("jobs finished", summary);
}
