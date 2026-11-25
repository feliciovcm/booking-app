// @vitest-environment node
// The booking function end to end in memory: handler -> real Boulevard adapter -> real
// mock-boulevard handler with an in-memory store. Only the mapping lookup is faked.
// A second, made-up vendor proves the handler doesn't depend on Boulevard.
// Step 4 adds checkout: the bookings table is faked in memory (the real one is in index.ts).
import { beforeEach, describe, expect, it } from "vitest";
import { BookingError, type BookingProvider } from "../_shared/booking-provider.ts";
import { clearTokenCache, createBoulevard } from "../_shared/boulevard.ts";
import { createHandler as createMock } from "../mock-boulevard/handler.ts";
import { memoryStore } from "../mock-boulevard/memory-store.ts";
import { SERVICES, VENDOR_LOCATIONS } from "../mock-boulevard/slots.ts";
import { createHandler, type BookingRow, type BookingsRepo, type Deps, type Mapping } from "./handler.ts";

const KEY = "sb_publishable_test";
const ORIGIN = "http://localhost:5173";
// Mappings carry our own ids too (treatments.id, locations.id): checkout needs them for the bookings row.
const MAPPINGS: Record<string, Mapping> = {
  "noho/prp": { provider: "boulevard", vendorLocationId: Object.keys(VENDOR_LOCATIONS)[0], vendorServiceId: SERVICES[0].id, treatmentId: "t-prp", locationId: "l-noho" },
  "grand-central/prp": { provider: "boulevard", vendorLocationId: Object.keys(VENDOR_LOCATIONS)[1], vendorServiceId: SERVICES[0].id, treatmentId: "t-prp", locationId: "l-gc" },
  "atlanta/prp": { provider: "acme", vendorLocationId: "acme-atl", vendorServiceId: "acme-prp", treatmentId: "t-prp", locationId: "l-atl" },
};

// A second vendor with a completely different shape behind the same contract.
const acme: BookingProvider = {
  startSession: async (location, service) => ({ sessionId: `${location}:${service}:s1` }),
  availableDates: async () => ["2026-11-26"],
  availableTimes: async () => [{ id: "acme-slot-1", start: "2026-11-26T15:00:00.000Z" }],
  hold: async (_session, slot) => {
    if (slot !== "acme-slot-1") throw new BookingError("SLOT_UNAVAILABLE", "That time just went.", "ACME_TAKEN");
    return { start: "2026-11-26T15:00:00.000Z", expiresAt: "2026-11-24T12:15:00.000Z" };
  },
  summary: async () => ({ vendorLocationId: "acme-atl", vendorServiceId: "acme-prp", hold: { start: "2026-11-26T15:00:00.000Z", expiresAt: "2026-11-24T12:15:00.000Z" } }),
  checkout: async () => {
    if (acmeCheckoutError) throw acmeCheckoutError;
    return { confirmationId: "acme-conf-1" };
  },
  checkoutStatus: async () => ({ confirmationId: null }),
};
let acmeCheckoutError: BookingError | null;

/** The bookings table, in memory. insertHeld returns the existing row when the key is taken. */
function memoryBookings() {
  const rows: BookingRow[] = [];
  const repo: BookingsRepo = {
    findByKey: async (key) => rows.find((r) => r.idempotencyKey === key) ?? null,
    insertHeld: async (row) => {
      const existing = rows.find((r) => r.idempotencyKey === row.idempotencyKey);
      if (existing) return existing;
      const created: BookingRow = { ...row, id: `b${rows.length + 1}`, status: "held", providerBookingId: null };
      rows.push(created);
      return created;
    },
    confirm: async (id, providerBookingId) => {
      Object.assign(rows.find((r) => r.id === id)!, { status: "confirmed", providerBookingId });
    },
    expire: async (id) => {
      Object.assign(rows.find((r) => r.id === id)!, { status: "expired" });
    },
  };
  return { rows, repo };
}

let failNext: string[];
let failOperation: Record<string, string>; // operation name -> x-mock-fail, applied once
let operations: string[]; // GraphQL operations the mock received, in order
let lines: Record<string, unknown>[];
let clock: { now: number };
let bookings: ReturnType<typeof memoryBookings>;
let mock: ReturnType<typeof createMock>;
let deps: Deps;

beforeEach(() => {
  clearTokenCache();
  failNext = [];
  failOperation = {};
  operations = [];
  acmeCheckoutError = null;
  lines = [];
  clock = { now: Date.parse("2026-11-24T12:00:00Z") };
  bookings = memoryBookings();
  mock = createMock({
    clientId: "app",
    clientSecret: "c2VjcmV0",
    businessId: "biz",
    store: memoryStore(clock),
    now: () => new Date(clock.now),
    random: () => 0.5,
    sleep: async () => {},
    failureRate: 0,
    maxLatencyMs: 0,
    log: () => {},
  });
  const fetchMock: typeof fetch = async (input, init) => {
    const req = new Request(input as string, init);
    const operation = req.url.endsWith("/client") ? (JSON.parse(await req.clone().text()).operationName as string) : undefined;
    if (operation) operations.push(operation);
    const byName = operation ? failOperation[operation] : undefined;
    if (byName) delete failOperation[operation!];
    const fail = byName ?? (operation ? failNext.shift() : undefined);
    if (fail) req.headers.set("x-mock-fail", fail);
    return mock(req);
  };
  const push = (l: string) => lines.push(JSON.parse(l));
  deps = {
    publishableKeys: [KEY],
    allowedOrigins: [ORIGIN],
    resolve: async (location, service) => MAPPINGS[`${location}/${service}`] ?? null,
    bookings: bookings.repo,
    providers: {
      boulevard: (log) =>
        createBoulevard(
          { baseUrl: "https://mock.test/mock-boulevard", clientId: "app", clientSecret: "c2VjcmV0", businessId: "biz", fetch: fetchMock, sleep: async () => {}, now: () => clock.now },
          log,
        ),
      acme: () => acme,
    },
    sink: { log: push, warn: push, error: push },
  };
});

async function call(body: unknown, headers: Record<string, string> = {}) {
  const res = await createHandler(deps)(
    new Request("https://x.supabase.co/functions/v1/booking", {
      method: "POST",
      headers: { apikey: KEY, "content-type": "application/json", origin: ORIGIN, ...headers },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, headers: res.headers, body: await res.json() };
}

async function start(location = "noho") {
  return (await call({ action: "start", location, service: "prp" })).body.sessionId as string;
}

describe("booking function (Boulevard behind it)", () => {
  it("starts a session, lists dates and times, and holds a time", async () => {
    const sessionId = await start();
    expect(sessionId).toMatch(/^boulevard\|urn:blvd:Cart:/);

    const dates = await call({ action: "dates", sessionId, from: "2026-11-24", to: "2026-11-30" });
    expect(dates.body.dates).toContain("2026-11-25");

    const [first] = (await call({ action: "times", sessionId, date: "2026-11-25" })).body.times;
    expect(first.start).toMatch(/Z$/);

    const held = await call({ action: "hold", sessionId, slotId: first.id });
    expect(held).toMatchObject({ status: 200, body: { start: first.start, expiresAt: "2026-11-24T12:30:00.000Z" } });
  });

  it("returns our code, not Boulevard's, when the time was taken", async () => {
    const a = await start();
    const b = await start();
    const [slot] = (await call({ action: "times", sessionId: a, date: "2026-11-25" })).body.times;
    await call({ action: "hold", sessionId: a, slotId: slot.id });

    const taken = await call({ action: "hold", sessionId: b, slotId: slot.id });
    expect(taken).toMatchObject({
      status: 409,
      body: { error: { code: "SLOT_UNAVAILABLE", message: "Time is no longer available, please select another." } },
    });
    // Boulevard's code stays in our logs for debugging.
    expect(lines.at(-1)).toMatchObject({ errorCode: "SLOT_UNAVAILABLE", vendorCode: "CART_TIME_NOT_AVAILABLE", provider: "boulevard" });
  });

  it("returns 503 UNAVAILABLE when the vendor stays down", async () => {
    const sessionId = await start();
    failNext = ["503", "503", "503"];
    expect(await call({ action: "times", sessionId, date: "2026-11-25" })).toMatchObject({ status: 503, body: { error: { code: "UNAVAILABLE" } } });
  });
});

describe("booking function is vendor-agnostic", () => {
  it("books through a second vendor with no handler changes", async () => {
    const sessionId = await start("atlanta");
    expect(sessionId).toBe("acme|acme-atl:acme-prp:s1");
    expect((await call({ action: "times", sessionId, date: "2026-11-26" })).body.times).toEqual([{ id: "acme-slot-1", start: "2026-11-26T15:00:00.000Z" }]);
    expect((await call({ action: "hold", sessionId, slotId: "acme-slot-1" })).status).toBe(200);
    expect(await call({ action: "hold", sessionId, slotId: "other" })).toMatchObject({ status: 409, body: { error: { code: "SLOT_UNAVAILABLE" } } });
  });

  it("treats a session from an unknown vendor as expired", async () => {
    const res = await call({ action: "times", sessionId: "gone-vendor|abc", date: "2026-11-26" });
    expect(res).toMatchObject({ status: 409, body: { error: { code: "SESSION_EXPIRED" } } });
  });

  it("returns 502 MISCONFIGURED for our own setup problems", async () => {
    deps.providers.acme = () => ({ ...acme, startSession: () => Promise.reject(new BookingError("MISCONFIGURED", "Booking is temporarily unavailable.", "AUTH_FAILED")) });
    expect(await call({ action: "start", location: "atlanta", service: "prp" })).toMatchObject({ status: 502, body: { error: { code: "MISCONFIGURED" } } });
  });
});

describe("requests", () => {
  it("returns 404 NOT_BOOKABLE when there's no mapping", async () => {
    expect(await call({ action: "start", location: "noho", service: "legacy-serum" })).toMatchObject({ status: 404, body: { error: { code: "NOT_BOOKABLE" } } });
  });

  it.each([
    [{ action: "start", location: "NoHo!", service: "prp" }],
    [{ action: "dates", sessionId: "boulevard|c", from: "2026-11-24", to: "2027-01-30" }],
    [{ action: "dates", sessionId: "boulevard|c", from: "2026-11-30", to: "2026-11-24" }],
    [{ action: "times", sessionId: "boulevard|c", date: "tomorrow" }],
    [{ action: "delete-everything" }],
  ])("rejects a bad request: %o", async (body) => {
    expect((await call(body)).status).toBe(400);
  });

  it("requires the publishable key", async () => {
    expect((await call({ action: "start", location: "noho", service: "prp" }, { apikey: "nope" })).status).toBe(401);
  });

  it("answers the CORS preflight, and allows only known origins", async () => {
    const preflight = await createHandler(deps)(new Request("https://x/functions/v1/booking", { method: "OPTIONS", headers: { origin: ORIGIN } }));
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(ORIGIN);

    const other = await call({ action: "start", location: "noho", service: "prp" }, { origin: "https://evil.example" });
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("logs one summary line per request with no visitor data, and forwards the request id", async () => {
    await call({ action: "start", location: "noho", service: "prp" }, { "x-request-id": "req-42" });
    expect(lines.find((l) => l.msg === "booking request")).toMatchObject({ fn: "booking", requestId: "req-42", action: "start", status: 200, provider: "boulevard" });
    expect(lines.filter((l) => String(l.msg).startsWith("boulevard ")).every((l) => l.requestId === "req-42")).toBe(true);
  });
});

// ============================================================
// Step 4: summary and checkout

const CLIENT = { firstName: "Avery", lastName: "Quinn", email: "avery.quinn@example.com", phone: "+12125550123" };
const KEY_1 = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
const KEY_2 = "0a9b8c7d-6e5f-4a3b-9c1d-2e3f4a5b6c7d";

/** A card token from the mock's Tokenization API, like the browser gets one. */
async function cardToken(): Promise<string> {
  const res = await mock(
    new Request("https://mock.test/mock-boulevard/cards/tokenize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ card: { name: "Avery Quinn", number: "4242424242424242", cvv: "123", exp_month: 12, exp_year: 2030, address_postal_code: "10012" } }),
    }),
  );
  return (await res.json()).token;
}

/** A Boulevard session with a held time, the state the checkout page starts from. */
async function held(location = "noho") {
  const sessionId = await start(location);
  const [slot] = (await call({ action: "times", sessionId, date: "2026-11-25" })).body.times;
  const hold = (await call({ action: "hold", sessionId, slotId: slot.id })).body;
  return { sessionId, hold };
}

const checkoutBody = async (sessionId: string, overrides: Record<string, unknown> = {}) => ({
  action: "checkout",
  sessionId,
  location: "noho",
  service: "prp",
  idempotencyKey: KEY_1,
  client: CLIENT,
  cardToken: await cardToken(),
  ...overrides,
});

describe("summary", () => {
  it("returns the live hold, so the checkout page survives a refresh", async () => {
    const { sessionId, hold } = await held();
    expect(await call({ action: "summary", sessionId })).toMatchObject({ status: 200, body: { hold } });
  });

  it("returns no hold before one is made, and never the vendor's ids", async () => {
    const sessionId = await start();
    const before = await call({ action: "summary", sessionId });
    expect(before).toMatchObject({ status: 200, body: { hold: null } });
    expect(JSON.stringify(before.body)).not.toContain("urn:blvd");
  });
});

describe("checkout", () => {
  it("books the held time and records it as confirmed", async () => {
    const { sessionId, hold } = await held();
    const res = await call(await checkoutBody(sessionId));

    expect(res).toMatchObject({ status: 200, body: { bookingId: "b1", start: hold.start } });
    expect(bookings.rows).toEqual([
      {
        id: "b1",
        idempotencyKey: KEY_1,
        status: "confirmed",
        email: CLIENT.email, // the only personal data we keep
        treatmentId: "t-prp",
        locationId: "l-noho",
        slotStart: hold.start, // from the vendor, not the browser
        provider: "boulevard",
        providerBookingId: expect.stringMatching(/^urn:blvd:Appointment:/),
        // The vendor's own session id (our id minus its "boulevard|" prefix), for reconciliation.
        providerSessionId: sessionId.slice("boulevard|".length),
      },
    ]);
  });

  it("returns the same booking when retried with the same key, without calling the vendor again", async () => {
    const { sessionId } = await held();
    const body = await checkoutBody(sessionId);
    const first = await call(body);
    const checkouts = operations.filter((o) => o === "CheckoutCart").length;

    const again = await call(body);
    expect(again).toEqual(expect.objectContaining({ status: 200, body: first.body }));
    expect(operations.filter((o) => o === "CheckoutCart")).toHaveLength(checkouts);
    expect(bookings.rows).toHaveLength(1);
  });

  it("keeps the row held when the vendor is down, and the retry with the same key completes it", async () => {
    const { sessionId } = await held();
    const body = await checkoutBody(sessionId);
    failOperation = { CheckoutCart: "503" }; // we can't know whether a failed mutation ran

    expect(await call(body)).toMatchObject({ status: 503, body: { error: { code: "UNAVAILABLE" } } });
    expect(bookings.rows).toMatchObject([{ id: "b1", status: "held", providerBookingId: null }]);

    expect(await call(body)).toMatchObject({ status: 200, body: { bookingId: "b1" } });
    expect(bookings.rows).toMatchObject([{ id: "b1", status: "confirmed" }]);
  });

  it("says SESSION_EXPIRED when the hold lapsed, and writes no row", async () => {
    const { sessionId } = await held();
    clock.now += 31 * 60_000;
    expect(await call(await checkoutBody(sessionId))).toMatchObject({ status: 409, body: { error: { code: "SESSION_EXPIRED" } } });
    expect(bookings.rows).toEqual([]);
  });

  it("marks the row expired when the vendor refuses for good, so a new key is needed", async () => {
    const sessionId = await start("atlanta");
    acmeCheckoutError = new BookingError("SLOT_UNAVAILABLE", "That time just went.", "ACME_TAKEN");
    const res = await call(await checkoutBody(sessionId, { location: "atlanta" }));
    expect(res).toMatchObject({ status: 409, body: { error: { code: "SLOT_UNAVAILABLE" } } });
    expect(bookings.rows).toMatchObject([{ status: "expired", providerBookingId: null }]);
  });

  it("checks the browser's location against the vendor's cart", async () => {
    const { sessionId } = await held();
    // Same vendor, other clinic: the slugs resolve, but the cart is for Noho.
    const res = await call(await checkoutBody(sessionId, { location: "grand-central" }));
    expect(res).toMatchObject({ status: 400, body: { error: { code: "INVALID_REQUEST" } } });
    // A session from one vendor with another vendor's mapping.
    const acmeMapping = await call(await checkoutBody(sessionId, { location: "atlanta", idempotencyKey: KEY_2 }));
    expect(acmeMapping).toMatchObject({ status: 400, body: { error: { code: "INVALID_REQUEST" } } });
    expect(bookings.rows).toEqual([]);
    expect(operations).not.toContain("CheckoutCart");
  });

  it("books through a second vendor with no handler changes", async () => {
    const sessionId = await start("atlanta");
    const res = await call(await checkoutBody(sessionId, { location: "atlanta" }));
    expect(res).toMatchObject({ status: 200, body: { bookingId: "b1", start: "2026-11-26T15:00:00.000Z" } });
    expect(bookings.rows).toMatchObject([{ provider: "acme", providerBookingId: "acme-conf-1", providerSessionId: "acme-atl:acme-prp:s1", locationId: "l-atl" }]);
  });

  it.each([
    ["a bad email", { client: { ...CLIENT, email: "not-an-email" } }],
    ["a phone that isn't E.164", { client: { ...CLIENT, phone: "212-555-0123" } }],
    ["a missing last name", { client: { firstName: "Avery", email: CLIENT.email } }],
    ["a key that isn't a UUID", { idempotencyKey: "1" }],
    ["no card token", { cardToken: "" }],
  ])("rejects %s before calling the vendor", async (_, overrides) => {
    const { sessionId } = await held();
    const before = operations.length;
    expect(await call(await checkoutBody(sessionId, overrides))).toMatchObject({ status: 400, body: { error: { code: "INVALID_REQUEST" } } });
    expect(operations).toHaveLength(before);
    expect(bookings.rows).toEqual([]);
  });

  it("accepts a checkout without a phone", async () => {
    const { sessionId } = await held();
    const noPhone = { firstName: CLIENT.firstName, lastName: CLIENT.lastName, email: CLIENT.email };
    expect((await call(await checkoutBody(sessionId, { client: noPhone }))).status).toBe(200);
  });

  it("never logs the visitor's details or the card token", async () => {
    const { sessionId } = await held();
    const body = await checkoutBody(sessionId);
    lines = [];
    await call(body);
    const logged = JSON.stringify(lines);
    for (const secret of [CLIENT.email, CLIENT.firstName, CLIENT.lastName, CLIENT.phone, body.cardToken as string]) expect(logged).not.toContain(secret);
    expect(lines.find((l) => l.msg === "booking request")).toMatchObject({ action: "checkout", status: 200, provider: "boulevard" });
  });
});
