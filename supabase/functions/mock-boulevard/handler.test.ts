// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { createHandler, type Deps } from "./handler.ts";
import { memoryStore } from "./memory-store.ts";
import { SERVICES, VENDOR_LOCATIONS } from "./slots.ts";

const CLIENT_ID = "app-123";
const SECRET = "c2VjcmV0LWJ5dGVz"; // base64 text, like the developer portal shows
const BUSINESS_ID = "biz-456";
const NOHO = Object.keys(VENDOR_LOCATIONS)[0];
const PRP = SERVICES[0].id;
const FOLIX = SERVICES[1].id;
const API = "/api/2026-06/client";

let clock: { now: number };
let logs: Record<string, unknown>[];
let sleeps: number[];
let deps: Deps;

beforeEach(() => {
  clock = { now: Date.parse("2026-11-24T12:00:00Z") }; // a Tuesday
  logs = [];
  sleeps = [];
  deps = {
    clientId: CLIENT_ID,
    clientSecret: SECRET,
    businessId: BUSINESS_ID,
    store: memoryStore(clock),
    now: () => new Date(clock.now),
    random: () => 0.5,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    failureRate: 0,
    maxLatencyMs: 800,
    log: (entry) => logs.push(entry),
  };
});

function post(path: string, body: string, headers: Record<string, string> = {}) {
  return createHandler(deps)(new Request(`http://localhost/functions/v1/mock-boulevard${path}`, { method: "POST", body, headers }));
}

const tokenRequest = (params: Record<string, string>) =>
  post("/oauth2/token", new URLSearchParams(params).toString(), { "content-type": "application/x-www-form-urlencoded" });

async function serverToken(): Promise<string> {
  const res = await post(
    "/oauth2/token",
    JSON.stringify({ grant_type: "client_credentials", client_id: CLIENT_ID, client_secret: SECRET, business_id: BUSINESS_ID, resource: `https://sandbox.example${API}` }),
    { "content-type": "application/json" },
  );
  return (await res.json()).access_token;
}

let token: string;
beforeEach(async () => {
  token = await serverToken();
  logs = [];
});

async function gql(query: string, variables: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const res = await post(API, JSON.stringify({ query, variables }), { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers });
  return { status: res.status, body: await res.json() };
}

const CART_FIELDS = "id startTime expiresAt completedAt errors { code }";

async function newCartWithItem(itemId = PRP): Promise<string> {
  const created = await gql(`mutation($loc: ID!) { createCart(input: { locationId: $loc }) { cart { id } } }`, { loc: NOHO });
  const id = created.body.data.createCart.cart.id;
  await gql(`mutation($id: ID!, $item: ID!) { addCartSelectedBookableItem(input: { id: $id, itemId: $item }) { cart { id } } }`, { id, item: itemId });
  return id;
}

async function times(cartId: string, date = "2026-11-25", tz?: string) {
  const { body } = await gql(`query($id: ID!, $date: Date!, $tz: Tz) { cartBookableTimes(id: $id, searchDate: $date, tz: $tz) { id score startTime } }`, { id: cartId, date, tz });
  return body.data.cartBookableTimes as { id: string; score: number; startTime: string }[];
}

const reserve = (cartId: string, timeId: string) =>
  gql(`mutation($id: ID!, $t: ID!) { reserveCartBookableItems(input: { id: $id, bookableTimeId: $t }) { cart { ${CART_FIELDS} } } }`, { id: cartId, t: timeId });

const checkout = (cartId: string) =>
  gql(`mutation($id: ID!) { checkoutCart(input: { id: $id }) { cart { ${CART_FIELDS} } appointments { appointmentId clientId forCartOwner } } }`, { id: cartId });

async function fillClientAndCard(cartId: string) {
  await gql(`mutation($id: ID!) { updateCart(input: { id: $id, clientInformation: { email: "ana@example.com", firstName: "Ana", lastName: "Silva", phoneNumber: "+12125550100" } }) { cart { id } } }`, { id: cartId });
  await gql(`mutation($id: ID!) { addCartCardPaymentMethod(input: { id: $id, token: "tok_123", select: true }) { cart { id } } }`, { id: cartId });
}

describe("oauth2/token", () => {
  it("mints a 15-minute anonymous token for browsers, without the secret", async () => {
    const res = await tokenRequest({ grant_type: "urn:blvd:params:oauth:grant-type:anonymous", client_id: CLIENT_ID, business_id: BUSINESS_ID });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(await res.json()).toMatchObject({ token_type: "bearer", expires_in: 900 });
  });

  it("mints a 24-hour server token with client_credentials", async () => {
    expect(await serverToken()).toMatch(/^mockblvd\./);
  });

  it.each([
    [{ grant_type: "password" }, 400, "unsupported_grant_type"],
    [{ grant_type: "client_credentials", client_id: CLIENT_ID, business_id: BUSINESS_ID, client_secret: "wrong", resource: API }, 401, "invalid_client"],
    [{ grant_type: "client_credentials", client_id: CLIENT_ID, business_id: BUSINESS_ID, client_secret: SECRET }, 400, "invalid_target"],
    [{ grant_type: "client_credentials", client_id: "other-app", business_id: BUSINESS_ID, client_secret: SECRET, resource: API }, 401, "invalid_client"],
  ])("rejects %o with %i %s", async (params, status, error) => {
    const res = await tokenRequest(params as Record<string, string>);
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error });
  });

  it("refuses API calls without a valid, unexpired token", async () => {
    expect((await post(API, JSON.stringify({ query: "{ business { id } }" }))).status).toBe(401);
    const anon = await (await tokenRequest({ grant_type: "urn:blvd:params:oauth:grant-type:anonymous", client_id: CLIENT_ID, business_id: BUSINESS_ID })).json();
    token = anon.access_token;
    expect((await gql("{ business { id } }")).status).toBe(200);
    clock.now += 901_000;
    expect((await gql("{ business { id } }")).status).toBe(401);
  });
});

describe("Client API booking flow", () => {
  it("lists locations with their time zones", async () => {
    const { body } = await gql("{ business { locations(first: 20) { edges { node { id name tz } } } } }");
    expect(body.data.business.locations.edges).toHaveLength(4);
    expect(body.data.business.locations.edges[0].node).toEqual({ id: NOHO, name: "NYC Noho", tz: "America/New_York" });
  });

  it("shows the menu on a new cart, with items behind the CartAvailableBookableItem fragment", async () => {
    const { body } = await gql(
      `mutation($loc: ID!) { createCart(input: { locationId: $loc }) { cart { availableCategories { name availableItems { id name ... on CartAvailableBookableItem { listPrice } } } } } }`,
      { loc: NOHO },
    );
    const items = body.data.createCart.cart.availableCategories[0].availableItems;
    expect(items[0]).toEqual({ id: PRP, name: "PRP Hair Restoration", listPrice: 49500 });
  });

  it("books end to end: dates, times, reserve, client info, card, checkout", async () => {
    const cartId = await newCartWithItem();

    const dates = await gql(`query($id: ID!) { cartBookableDates(id: $id, searchRangeLower: "2026-11-24", searchRangeUpper: "2026-11-29", tz: "America/New_York") { date } }`, { id: cartId });
    const listed = dates.body.data.cartBookableDates.map((d: { date: string }) => d.date);
    expect(listed).toContain("2026-11-25");
    expect(listed).not.toContain("2026-11-29"); // Sunday, closed

    const [first] = await times(cartId);
    expect(first.id).toMatch(/^t_2026-11-25T/);
    expect(first.startTime).toMatch(/^2026-11-25T\d\d:00:00-05:00$/);

    const reserved = (await reserve(cartId, first.id)).body.data.reserveCartBookableItems.cart;
    expect(reserved.startTime).toBe(first.startTime);
    expect(reserved.expiresAt).toBe("2026-11-24T12:30:00.000Z");
    expect(reserved.errors.map((e: { code: string }) => e.code)).toEqual(["CART_MISSING_CLIENT_INFORMATION", "CART_MISSING_ITEM_PAYMENT_METHOD"]);

    await fillClientAndCard(cartId);
    const done = (await checkout(cartId)).body.data.checkoutCart;
    expect(done.cart.completedAt).toBeTruthy();
    expect(done.cart.errors).toEqual([]);
    expect(done.appointments).toEqual([{ appointmentId: `urn:blvd:Appointment:${cartId}`, clientId: `urn:blvd:Client:${cartId}`, forCartOwner: true }]);

    // The booked time is gone for everyone else.
    const other = await newCartWithItem();
    expect((await times(other)).map((t) => t.id)).not.toContain(first.id);
  });

  it("returns the same appointment when checkout is retried, and locks the cart", async () => {
    const cartId = await newCartWithItem();
    await reserve(cartId, (await times(cartId))[0].id);
    await fillClientAndCard(cartId);
    const first = (await checkout(cartId)).body.data.checkoutCart.appointments;
    expect((await checkout(cartId)).body.data.checkoutCart.appointments).toEqual(first);

    const change = await gql(`mutation($id: ID!) { updateCart(input: { id: $id, clientInformation: { firstName: "Bo" } }) { cart { id } } }`, { id: cartId });
    expect(change.body.errors[0].code).toBe("CART_COMPLETED");
  });

  it("refuses checkout with Boulevard's error format while something is missing", async () => {
    const cartId = await newCartWithItem();
    const { status, body } = await checkout(cartId);
    expect(status).toBe(200);
    expect(body.data.checkoutCart).toBeNull();
    expect(body.errors[0]).toMatchObject({
      __typename: "BlvdError",
      code: "CART_MISSING_CLIENT_INFORMATION",
      message: "Please fill in your contact details.",
      path: ["checkoutCart"],
    });
  });

  it("lets only one of two carts reserve the same time", async () => {
    const a = await newCartWithItem();
    const b = await newCartWithItem();
    const [slot] = await times(a);
    expect((await reserve(a, slot.id)).body.errors).toBeUndefined();

    const { body } = await reserve(b, slot.id);
    expect(body.data.reserveCartBookableItems).toBeNull();
    expect(body.errors[0]).toMatchObject({
      __typename: "BlvdError",
      code: "CART_TIME_NOT_AVAILABLE",
      message: "Time is no longer available, please select another.",
      description: `The selected time ${slot.id} is no longer available.`,
    });
  });

  it("refuses a time Boulevard doesn't offer", async () => {
    const cartId = await newCartWithItem();
    expect((await reserve(cartId, "t_2026-11-25T09:17:00")).body.errors[0].code).toBe("CART_TIME_NOT_AVAILABLE");
    expect((await reserve(cartId, "t_2026-11-29T10:00:00")).body.errors[0].code).toBe("CART_TIME_NOT_AVAILABLE"); // Sunday
  });

  it("drops the reservation after 30 minutes, so checkout sends the client back to pick a time", async () => {
    const cartId = await newCartWithItem();
    const [slot] = await times(cartId);
    await reserve(cartId, slot.id);
    await fillClientAndCard(cartId);
    clock.now += 31 * 60_000;

    expect((await checkout(cartId)).body.errors[0].code).toBe("CART_MISSING_ITEM_TIME");
    const other = await newCartWithItem();
    expect((await reserve(other, slot.id)).body.errors).toBeUndefined();
  });

  it("releases the reservation when the cart's service changes", async () => {
    const cartId = await newCartWithItem();
    const [slot] = await times(cartId);
    await reserve(cartId, slot.id);
    await gql(`mutation($id: ID!, $item: ID!) { addCartSelectedBookableItem(input: { id: $id, itemId: $item }) { cart { id } } }`, { id: cartId, item: FOLIX });

    const { body } = await gql(`query($id: ID!) { cart(id: $id) { ${CART_FIELDS} } }`, { id: cartId });
    expect(body.data.cart.startTime).toBeNull();
    expect(body.data.cart.errors.map((e: { code: string }) => e.code)).toContain("CART_MISSING_ITEM_TIME");
  });

  it("writes times in the requested tz", async () => {
    const cartId = await newCartWithItem();
    const [ny] = await times(cartId);
    const [la] = await times(cartId, "2026-11-25", "America/Los_Angeles");
    expect(la.id).toBe(ny.id);
    expect(new Date(la.startTime).getTime()).toBe(new Date(ny.startTime).getTime());
    expect(la.startTime).toMatch(/-08:00$/);
  });

  it("needs a service in the cart before searching times", async () => {
    const created = await gql(`mutation($loc: ID!) { createCart(input: { locationId: $loc }) { cart { id } } }`, { loc: NOHO });
    const { body } = await gql(`query($id: ID!) { cartBookableTimes(id: $id, searchDate: "2026-11-25") { id } }`, { id: created.body.data.createCart.cart.id });
    expect(body.errors[0].code).toBe("CART_NO_BOOKABLE_ITEMS");
  });

  it("fails an unparseable phone number with no error code, like the docs say", async () => {
    const cartId = await newCartWithItem();
    const { body } = await gql(`mutation($id: ID!) { updateCart(input: { id: $id, clientInformation: { phoneNumber: "212-555" } }) { cart { id } } }`, { id: cartId });
    expect(body.errors[0].message).toMatch(/Invalid PhoneNumber/);
    expect(body.errors[0].code).toBeUndefined();
  });
});

describe("failures", () => {
  it("forces a 429 that says how long to wait in the message, not a header", async () => {
    const { status, body } = await gql("{ business { id } }", {}, { "x-mock-fail": "429" });
    expect(status).toBe(429);
    expect(body.errors[0].message).toMatch(/Please wait 280ms and try again/);
  });

  it.each([["500"], ["503"]])("forces a %s", async (code) => {
    expect((await gql("{ business { id } }", {}, { "x-mock-fail": code })).status).toBe(Number(code));
  });

  it("forces a hang long enough for the caller to time out", async () => {
    const { status } = await gql("{ business { id } }", {}, { "x-mock-fail": "timeout" });
    expect(sleeps).toEqual([30_000]);
    expect(status).toBe(504);
  });

  it("fails randomly at the configured rate, after random latency", async () => {
    deps.failureRate = 1;
    const { status } = await gql("{ business { id } }");
    expect([429, 503]).toContain(status);
    expect(sleeps).toEqual([400]); // random() = 0.5 of maxLatencyMs 800
  });

  it("logs the operation and error codes, never variables or client details", async () => {
    const cartId = await newCartWithItem();
    logs = [];
    const res = await post(
      API,
      JSON.stringify({ operationName: "Checkout", query: `mutation Checkout($id: ID!) { checkoutCart(input: { id: $id }) { cart { id } } }`, variables: { id: cartId, email: "ana@example.com" } }),
      { authorization: `Bearer ${token}`, "content-type": "application/json" },
    );
    expect(res.status).toBe(200);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ operation: "Checkout", errorCodes: ["CART_MISSING_CLIENT_INFORMATION"], status: 200 });
    expect(JSON.stringify(logs[0])).not.toContain("ana@example.com");
  });
});
