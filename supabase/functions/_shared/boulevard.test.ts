// @vitest-environment node
// Contract tests: the adapter talks to the real mock-boulevard handler (with an
// in-memory store), so a change on either side that breaks the other fails here.
import { beforeEach, describe, expect, it } from "vitest";
import { createHandler } from "../mock-boulevard/handler.ts";
import { memoryStore } from "../mock-boulevard/memory-store.ts";
import { SERVICES, VENDOR_LOCATIONS } from "../mock-boulevard/slots.ts";
import { BookingError } from "./booking-provider.ts";
import { clearTokenCache, createBoulevard, waitFrom429, type BoulevardConfig } from "./boulevard.ts";
import { createLogger } from "./log.ts";

const NOHO = Object.keys(VENDOR_LOCATIONS)[0];
const PRP = SERVICES[0].id;
const BASE = "https://mock.test/functions/v1/mock-boulevard";

let clock: { now: number };
let calls: { path: string; operation?: string; status: number; requestId: string | null }[];
let failNext: string[]; // x-mock-fail values for the next API calls, in order
let sleeps: number[];
let lines: Record<string, unknown>[];
let config: BoulevardConfig;

beforeEach(() => {
  clearTokenCache();
  clock = { now: Date.parse("2026-11-24T12:00:00Z") };
  calls = [];
  failNext = [];
  sleeps = [];
  lines = [];
  const handler = createHandler({
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
  config = {
    baseUrl: BASE,
    clientId: "app",
    clientSecret: "c2VjcmV0",
    businessId: "biz",
    now: () => clock.now,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    fetch: async (input, init) => {
      const req = new Request(input as string, init);
      const isApi = req.url.endsWith("/api/2026-06/client");
      const fail = isApi ? failNext.shift() : undefined;
      if (fail) req.headers.set("x-mock-fail", fail);
      const operation = isApi ? JSON.parse(await req.clone().text()).operationName : undefined;
      const res = await handler(req);
      calls.push({ path: new URL(req.url).pathname.replace("/functions/v1/mock-boulevard", ""), operation, status: res.status, requestId: req.headers.get("x-request-id") });
      return res;
    },
  };
});

const sink = { log: (l: string) => lines.push(JSON.parse(l)), warn: (l: string) => lines.push(JSON.parse(l)), error: (l: string) => lines.push(JSON.parse(l)) };
const blvd = () => createBoulevard(config, createLogger("booking", "req-test", sink));

describe("booking flow against the mock", () => {
  it("starts a cart, lists dates and times, and reserves one", async () => {
    const b = blvd();
    const { sessionId: cartId } = await b.startSession(NOHO, PRP);
    expect(cartId).toMatch(/^urn:blvd:Cart:/);

    const dates = await b.availableDates(cartId, "2026-11-24", "2026-11-30");
    expect(dates).toContain("2026-11-25");
    expect(dates).not.toContain("2026-11-29"); // Sunday

    const times = await b.availableTimes(cartId, "2026-11-25");
    expect(times[0].start).toMatch(/^2026-11-25T\d\d:00:00\.000Z$/); // normalized to UTC
    const reserved = await b.hold(cartId, times[0].id);
    expect(reserved).toEqual({ start: times[0].start, expiresAt: "2026-11-24T12:30:00.000Z" });
  });

  it("reuses one token across calls and clients, and forwards the request id", async () => {
    const { sessionId: cartId } = await blvd().startSession(NOHO, PRP);
    await blvd().availableTimes(cartId, "2026-11-25");
    expect(calls.filter((c) => c.path === "/oauth2/token")).toHaveLength(1);
    expect(calls.every((c) => c.requestId === "req-test")).toBe(true);
  });

  it("translates Boulevard's error into ours, keeping its user-safe message and code for logs", async () => {
    const b = blvd();
    const one = await b.startSession(NOHO, PRP);
    const two = await b.startSession(NOHO, PRP);
    const [slot] = await b.availableTimes(one.sessionId, "2026-11-25");
    await b.hold(one.sessionId, slot.id);

    const error = await b.hold(two.sessionId, slot.id).catch((e) => e);
    expect(error).toBeInstanceOf(BookingError);
    expect(error).toMatchObject({ code: "SLOT_UNAVAILABLE", vendorCode: "CART_TIME_NOT_AVAILABLE", userMessage: "Time is no longer available, please select another.", retryable: false });
  });
});

describe("retries", () => {
  it("retries a query after a 503, with backoff", async () => {
    const b = blvd();
    const { sessionId: cartId } = await b.startSession(NOHO, PRP);
    failNext = ["503"];
    expect((await b.availableTimes(cartId, "2026-11-25")).length).toBeGreaterThan(0);
    expect(calls.filter((c) => c.operation === "CartBookableTimes").map((c) => c.status)).toEqual([503, 200]);
    expect(sleeps[0]).toBeGreaterThanOrEqual(250);
  });

  it("waits as long as the 429 message says, even for a mutation", async () => {
    failNext = ["429"];
    await blvd().startSession(NOHO, PRP);
    expect(calls.filter((c) => c.operation === "CreateCart").map((c) => c.status)).toEqual([429, 200]);
    expect(sleeps).toEqual([280]);
  });

  it("does not retry a mutation after a 503, because it may have run", async () => {
    failNext = ["503"];
    const error = await blvd().startSession(NOHO, PRP).catch((e) => e);
    expect(error).toMatchObject({ code: "UNAVAILABLE", vendorCode: "HTTP_503", retryable: true });
    expect(calls.filter((c) => c.operation === "CreateCart")).toHaveLength(1);
  });

  it("gives up after maxRetries", async () => {
    const b = blvd();
    const { sessionId: cartId } = await b.startSession(NOHO, PRP);
    failNext = ["503", "503", "503", "503"];
    await expect(b.availableTimes(cartId, "2026-11-25")).rejects.toMatchObject({ code: "UNAVAILABLE", vendorCode: "HTTP_503" });
    expect(calls.filter((c) => c.operation === "CartBookableTimes")).toHaveLength(3); // 1 + 2 retries
  });

  it("gets a new token once when Boulevard says 401", async () => {
    const b = blvd();
    const { sessionId: cartId } = await b.startSession(NOHO, PRP);
    // The mock's clock moves past the token's 24 h, but the adapter's clock doesn't, so the
    // adapter still trusts its cached token: the same situation as a revoked token.
    clock.now += 25 * 3600_000;
    config.now = () => Date.parse("2026-11-24T12:00:00Z");
    await createBoulevard(config, createLogger("booking", "req-test", sink)).availableTimes(cartId, "2026-11-26");
    const statuses = calls.filter((c) => c.operation === "CartBookableTimes").map((c) => c.status);
    expect(statuses).toEqual([401, 200]);
  });

  it("times out a hung call and retries it", async () => {
    const real = config.fetch!;
    let hung = false;
    config.fetch = (input, init) => {
      if (!hung && String(input).endsWith("/api/2026-06/client") && JSON.parse(String(init?.body)).operationName === "CartBookableDates") {
        hung = true;
        return new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
      }
      return real(input, init);
    };
    config.timeoutMs = 20;
    const b = blvd();
    const { sessionId: cartId } = await b.startSession(NOHO, PRP);
    expect(await b.availableDates(cartId, "2026-11-25", "2026-11-25")).toEqual(["2026-11-25"]);
    expect(lines.some((l) => l.errorCode === "UNAVAILABLE" && l.vendorCode === "TIMEOUT")).toBe(true);
  });
});

describe("logging", () => {
  it("logs each call with operation, attempt and duration, and no client data", async () => {
    await blvd().startSession(NOHO, PRP);
    const createCart = lines.find((l) => l.msg === "boulevard CreateCart");
    expect(createCart).toMatchObject({ level: "info", fn: "booking", requestId: "req-test", operation: "CreateCart", attempt: 0, ok: true });
    expect(JSON.stringify(lines)).not.toContain("c2VjcmV0"); // the client secret
  });
});

it("reads the wait from Boulevard's 429 message, capped at 5 s", () => {
  expect(waitFrom429('{"errors":[{"message":"... Please wait 280ms and try again."}]}')).toBe(280);
  expect(waitFrom429("Please wait 90000ms")).toBe(5000);
  expect(waitFrom429("nope")).toBeNull();
});
