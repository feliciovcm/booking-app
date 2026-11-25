// Receives Boulevard's appointment webhooks. Boulevard calls it, not our frontend, so
// verify_jwt is off in config.toml and the HMAC signature is the authentication.
//
// The order matters, because of how Boulevard delivers (webhooks guide):
// 1. Verify the signature on the raw body, before parsing anything.
// 2. Record the event in webhook_events, keyed on (provider, event id): a duplicate
//    delivery hits the primary key and is detected.
// 3. Reply 200 at once. Boulevard waits 5 to 10 s, retries only once by default, and
//    disables the subscription after hours of failures, so slow work must not hold the reply.
// 4. Process after replying (EdgeRuntime.waitUntil in index.ts). A failure is recorded
//    on the row and the event stays unprocessed, for a redelivery or the retry job.
//
// Never answer 410: Boulevard treats it as "endpoint gone" and stops sending for good.
// Answer 5xx only when we couldn't record the event, which is exactly when a retry helps.

import { z } from "zod";
import { SALT_HEADER, SIGNATURE_HEADER, verifyBoulevardWebhook } from "../_shared/boulevard-signature.ts";
import { createLogger, requestIdFrom, type Log, type Sink } from "../_shared/log.ts";

const PROVIDER = "boulevard";

/** One event as we store it. The payload is Boulevard's body, parsed. */
export type InboundEvent = { provider: string; eventId: string; type: string; payload: unknown };

/** The webhook_events table, behind an interface so tests use memory and index.ts uses Postgres. */
export type WebhookEventsRepo = {
  /** Inserts the event unless (provider, eventId) is already there. Says whether that one was processed. */
  record(event: InboundEvent): Promise<{ alreadyProcessed: boolean }>;
  /** Counts one processing try: error null marks it processed, otherwise keeps why it failed. */
  recordAttempt(provider: string, eventId: string, error: string | null): Promise<void>;
};

export type Deps = {
  /** The OAuth client secret Boulevard signs with, as the portal shows it (Base64 text). */
  secretBase64: string;
  events: WebhookEventsRepo;
  /** What an event means for our data. Throws to leave the event unprocessed. */
  process: (event: InboundEvent, log: Log) => Promise<void>;
  /** Keeps work running after the response is sent. */
  defer: (work: Promise<unknown>) => void;
  now?: () => number;
  sink?: Sink;
};

// Only what the receiver needs to file the event. What it means is the processor's job.
const Envelope = z.looseObject({ idempotencyKey: z.string().min(1).max(200), eventType: z.string().min(1).max(100) });

// Error messages from our own code are safe; cap them so one bad row can't bloat the table.
const safeError = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 500);

export function createHandler(deps: Deps): (req: Request) => Promise<Response> {
  const now = deps.now ?? Date.now;

  return async (req) => {
    const log = createLogger("boulevard-webhook", requestIdFrom(req), deps.sink);
    const fields: Record<string, string> = {};
    const reply = (status: number, outcome: string) => {
      log[status >= 500 ? "error" : status >= 400 ? "warn" : "info"]("webhook received", { status, outcome, ...fields });
      return new Response(JSON.stringify({ outcome }), { status, headers: { "content-type": "application/json" } });
    };

    if (req.method !== "POST") return reply(405, "METHOD_NOT_ALLOWED");

    // 1. The raw text, exactly as signed. Parsing first would change the bytes.
    const rawBody = await req.text();
    const verified = await verifyBoulevardWebhook({
      secretBase64: deps.secretBase64,
      salt: req.headers.get(SALT_HEADER),
      signature: req.headers.get(SIGNATURE_HEADER),
      rawBody,
      nowMs: now(),
    });
    if (!verified.ok) return reply(401, verified.reason);
    fields.deliveryId = verified.deliveryId;

    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return reply(400, "INVALID_JSON");
    }
    const envelope = Envelope.safeParse(body);
    // Signed but not an event we can file (the PING sent when a webhook is created):
    // acknowledge it, or Boulevard counts a failure against the subscription.
    if (!envelope.success) return reply(200, "IGNORED");

    const event: InboundEvent = { provider: PROVIDER, eventId: envelope.data.idempotencyKey, type: envelope.data.eventType, payload: body };
    fields.eventId = event.eventId;
    fields.eventType = event.type;

    // 2. Record it. If this fails we have nothing, so ask Boulevard to try again.
    let alreadyProcessed: boolean;
    try {
      ({ alreadyProcessed } = await deps.events.record(event));
    } catch (error) {
      fields.error = safeError(error);
      return reply(500, "STORE_FAILED");
    }
    if (alreadyProcessed) return reply(200, "DUPLICATE");

    // 4. Process after replying. A redelivery of an event that failed before runs it again.
    deps.defer(processEvent(deps, event, log));
    // 3.
    return reply(200, "ACCEPTED");
  };
}

/** Runs one event and records the try. Never throws: the outcome lives on the row. */
export async function processEvent(
  deps: { events: Pick<WebhookEventsRepo, "recordAttempt">; process: Deps["process"] },
  event: InboundEvent,
  log: Log,
): Promise<void> {
  const fields = { eventId: event.eventId, eventType: event.type };
  let error: string | null = null;
  try {
    await deps.process(event, log);
  } catch (e) {
    error = safeError(e);
  }
  try {
    await deps.events.recordAttempt(event.provider, event.eventId, error);
  } catch (e) {
    log.error("webhook attempt not recorded", { ...fields, error: safeError(e) });
    return;
  }
  if (error) log.error("webhook processing failed", { ...fields, error });
  else log.info("webhook processed", fields);
}
