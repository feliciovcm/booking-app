// @vitest-environment node
// The booking function end to end in memory: handler -> real Boulevard adapter -> real
// mock-boulevard handler with an in-memory store. Only the mapping lookup is faked.
// A second, made-up vendor proves the handler doesn't depend on Boulevard.
import { beforeEach, describe, expect, it } from "vitest";
import { BookingError, type BookingProvider } from "../_shared/booking-provider.ts";
import { clearTokenCache, createBoulevard } from "../_shared/boulevard.ts";
import { createHandler as createMock } from "../mock-boulevard/handler.ts";
import { memoryStore } from "../mock-boulevard/memory-store.ts";
import { SERVICES, VENDOR_LOCATIONS } from "../mock-boulevard/slots.ts";
import { createHandler, type Deps, type Mapping } from "./handler.ts";

const KEY = "sb_publishable_test";
const ORIGIN = "http://localhost:5173";
const MAPPINGS: Record<string, Mapping> = {
  "noho/prp": { provider: "boulevard", vendorLocationId: Object.keys(VENDOR_LOCATIONS)[0], vendorServiceId: SERVICES[0].id },
  "atlanta/prp": { provider: "acme", vendorLocationId: "acme-atl", vendorServiceId: "acme-prp" },
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
};

let failNext: string[];
let lines: Record<string, unknown>[];
let deps: Deps;

beforeEach(() => {
  clearTokenCache();
  failNext = [];
  lines = [];
  const clock = { now: Date.parse("2026-11-24T12:00:00Z") };
  const mock = createMock({
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
    const fail = req.url.endsWith("/client") ? failNext.shift() : undefined;
    if (fail) req.headers.set("x-mock-fail", fail);
    return mock(req);
  };
  const push = (l: string) => lines.push(JSON.parse(l));
  deps = {
    publishableKeys: [KEY],
    allowedOrigins: [ORIGIN],
    resolve: async (location, service) => MAPPINGS[`${location}/${service}`] ?? null,
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
