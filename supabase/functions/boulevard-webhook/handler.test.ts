// @vitest-environment node
// The webhook receiver in memory: real signatures, a fake webhook_events table, and a
// processing step we control. One test sends through the mock's real webhook sender,
// so the two sides are proven to agree on the wire format.
import { describe, expect, it } from "vitest";
import { SALT_HEADER, SIGNATURE_HEADER, makeSalt, signBoulevardWebhook } from "../_shared/boulevard-signature.ts";
import { SERVICES, VENDOR_LOCATIONS } from "../mock-boulevard/slots.ts";
import { appointmentEvent, createWebhookSender, type Appointment } from "../mock-boulevard/webhooks.ts";
import { createHandler, type Deps, type InboundEvent, type WebhookEventsRepo } from "./handler.ts";

const SECRET = "cmF3LWJpbmFyeS1jbGllbnQtc2VjcmV0LWJ5dGVz";
const NOW = Date.parse("2026-11-24T12:00:00Z");
const ENDPOINT = "http://localhost/functions/v1/boulevard-webhook";

const appointment: Appointment = {
  id: "urn:blvd:Appointment:a1",
  clientId: "urn:blvd:Client:c1",
  locationId: Object.keys(VENDOR_LOCATIONS)[0],
  serviceId: SERVICES[0].id,
  start: new Date("2026-11-25T15:00:00Z"),
  client: { firstName: "Avery", lastName: "Quinn", email: "avery@example.com", phoneNumber: "+12125550100" },
  bookedByType: "CLIENT",
};
const event = (idempotencyKey = "evt-1") =>
  appointmentEvent(
    "APPOINTMENT_CREATED",
    appointment,
    { businessId: "urn:blvd:Business:b1", apiApplicationId: "urn:blvd:ApiApplication:app1", webhookId: "urn:blvd:Webhook:w1", idempotencyKey },
    new Date(NOW),
  );

async function signed(body: unknown, { secret = SECRET, at = NOW } = {}): Promise<Request> {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const salt = makeSalt("delivery-1", Math.floor(at / 1000));
  return new Request(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", [SALT_HEADER]: salt, [SIGNATURE_HEADER]: await signBoulevardWebhook(secret, salt, raw) },
    body: raw,
  });
}

type Row = InboundEvent & { processed: boolean; attempts: number; lastError: string | null };

/** webhook_events in memory, with the same "insert or keep the existing row" rule. */
function memoryEvents() {
  const rows: Row[] = [];
  const find = (provider: string, eventId: string) => rows.find((r) => r.provider === provider && r.eventId === eventId)!;
  let failRecord = false;
  const repo: WebhookEventsRepo = {
    async record(e) {
      if (failRecord) throw new Error("connection refused");
      const existing = rows.find((r) => r.provider === e.provider && r.eventId === e.eventId);
      if (!existing) rows.push({ ...e, processed: false, attempts: 0, lastError: null });
      return { alreadyProcessed: existing?.processed ?? false };
    },
    async recordAttempt(provider, eventId, error) {
      const row = find(provider, eventId);
      row.attempts++;
      row.lastError = error;
      if (error === null) row.processed = true;
    },
  };
  return { rows, repo, breakStore: () => (failRecord = true) };
}

function setup(overrides: Partial<Deps> = {}) {
  const events = memoryEvents();
  const processed: InboundEvent[] = [];
  const deferred: Promise<unknown>[] = [];
  const logs: string[] = [];
  const sink = { log: (l: string) => logs.push(l), warn: (l: string) => logs.push(l), error: (l: string) => logs.push(l) };
  const handler = createHandler({
    secretBase64: SECRET,
    events: events.repo,
    process: async (e) => {
      processed.push(e);
    },
    defer: (work) => deferred.push(work),
    now: () => NOW,
    sink,
    ...overrides,
  });
  /** Waits for the background work the handler started after replying. */
  const settle = () => Promise.all(deferred);
  return { handler, events, processed, logs, settle };
}

describe("boulevard-webhook receiver", () => {
  it("acks a signed delivery, records it, then processes it in the background", async () => {
    // Processing is held on a gate, so the reply can only arrive if it doesn't wait for it.
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const processed: InboundEvent[] = [];
    const { handler, events, settle } = setup({
      process: async (e) => {
        await gate;
        processed.push(e);
      },
    });
    const res = await handler(await signed(event()));

    expect(res.status).toBe(200);
    expect(events.rows).toMatchObject([{ provider: "boulevard", eventId: "evt-1", type: "APPOINTMENT_CREATED", processed: false }]);
    expect(processed).toEqual([]);

    open();
    await settle();
    expect(processed).toMatchObject([{ eventId: "evt-1", type: "APPOINTMENT_CREATED", payload: event() }]);
    expect(events.rows[0]).toMatchObject({ processed: true, attempts: 1, lastError: null });
  });

  it("refuses a bad signature with 401, stores nothing, and never answers 410", async () => {
    const { handler, events, processed, settle } = setup();
    const forged = await handler(await signed(event(), { secret: "b3RoZXI=" }));
    const unsigned = await handler(new Request(ENDPOINT, { method: "POST", body: JSON.stringify(event()) }));
    const replayed = await handler(await signed(event(), { at: NOW - 60 * 60_000 }));
    await settle();

    expect([forged.status, unsigned.status, replayed.status]).toEqual([401, 401, 401]);
    expect(events.rows).toEqual([]);
    expect(processed).toEqual([]);
  });

  it("acks a duplicate of a processed event without processing it again", async () => {
    const { handler, processed, settle } = setup();
    await handler(await signed(event()));
    await settle();
    const again = await handler(await signed(event()));
    await settle();

    expect(again.status).toBe(200);
    expect(processed).toHaveLength(1);
  });

  it("processes a redelivery again when the first try failed", async () => {
    let fail = true;
    const { handler, events, settle } = setup({
      process: async () => {
        if (fail) throw new Error("bookings table unreachable");
      },
    });
    expect((await handler(await signed(event()))).status).toBe(200); // the ack went out before processing failed
    await settle();
    expect(events.rows[0]).toMatchObject({ processed: false, attempts: 1, lastError: "bookings table unreachable" });

    fail = false;
    await handler(await signed(event()));
    await settle();
    expect(events.rows[0]).toMatchObject({ processed: true, attempts: 2, lastError: null });
  });

  it("answers 500 when it can't record the event, so Boulevard retries", async () => {
    const { handler, events, processed, settle } = setup();
    events.breakStore();
    const res = await handler(await signed(event()));
    await settle();

    expect(res.status).toBe(500);
    expect(processed).toEqual([]);
  });

  it("acks signed deliveries it has nothing to do with, like the setup PING", async () => {
    const { handler, events, processed, settle } = setup();
    const res = await handler(await signed({ eventType: "PING" }));
    await settle();

    expect(res.status).toBe(200);
    expect(events.rows).toEqual([]);
    expect(processed).toEqual([]);
  });

  it("refuses a signed body that isn't JSON, and methods other than POST", async () => {
    const { handler } = setup();
    expect((await handler(await signed("not json"))).status).toBe(400);
    expect((await handler(new Request(ENDPOINT, { method: "GET" }))).status).toBe(405);
  });

  it("accepts what the mock's webhook sender actually sends", async () => {
    const { handler, events, settle } = setup({ now: () => Date.now() });
    const outcomes: unknown[] = [];
    const sender = createWebhookSender({
      url: ENDPOINT,
      clientSecret: SECRET,
      fetch: (input, init) => handler(new Request(input, init)),
      log: (entry) => outcomes.push(entry),
    });
    await sender.send(event("evt-wire"));
    await settle();

    expect(outcomes).toEqual([expect.objectContaining({ attempt: 0, status: 200 })]);
    expect(events.rows[0]).toMatchObject({ eventId: "evt-wire", processed: true });
  });

  it("keeps client details out of the logs", async () => {
    const { handler, logs, settle } = setup({
      process: async () => {
        throw new Error("nope");
      },
    });
    await handler(await signed(event()));
    await settle();

    const text = logs.join("\n");
    expect(text).toContain("evt-1");
    for (const secret of ["avery@example.com", "Avery", "Quinn", "+12125550100"]) expect(text).not.toContain(secret);
  });
});
