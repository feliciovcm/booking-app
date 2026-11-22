// A small subset of Boulevard's Client API (v2026-06), enough for the booking flow in
// their "Booking an Appointment" guide:
//
//   business.locations -> createCart -> addCartSelectedBookableItem -> cartBookableDates
//   -> cartBookableTimes -> reserveCartBookableItems -> updateCart (client info)
//   -> addCartCardPaymentMethod -> checkoutCart
//
// Field and operation names follow the docs' examples. Type names that the docs don't
// show (payloads, inputs) are approximations, so check the real schema before relying
// on them. Error codes are Boulevard's where the docs name them; codes marked "mock"
// below are invented for cases the docs don't cover.

import { buildSchema } from "graphql";
import {
  BOOKING_WINDOW_DAYS,
  SERVICES,
  VENDOR_LOCATIONS,
  dayBounds,
  formatDate,
  formatLocal,
  generateSlots,
  localDate,
  parseDate,
  parseTimeId,
} from "./slots.ts";

export type ClientInformation = { email?: string | null; firstName?: string | null; lastName?: string | null; phoneNumber?: string | null };

export type CartRecord = {
  id: string;
  locationId: string;
  itemId: string | null;
  clientInformation: ClientInformation | null;
  paymentToken: string | null;
  completedAt: Date | null;
  /** The cart's latest reservation that wasn't released, if any. */
  reservation: {
    startTime: Date;
    expiresAt: Date;
    status: "reserved" | "booked";
    appointmentId: string | null;
    clientId: string | null;
  } | null;
};

export interface BoulevardStore {
  createCart(locationId: string): Promise<CartRecord>;
  getCart(id: string): Promise<CartRecord | null>;
  /** Sets the cart's one bookable item and releases any reservation (the docs: changing items invalidates it). */
  setItem(cartId: string, itemId: string): Promise<void>;
  /** Start times (ms) of booked appointments and unexpired reservations in [from, to). */
  takenStarts(locationId: string, from: Date, to: Date): Promise<number[]>;
  /** Releases the cart's previous reservation and reserves this slot. False if someone else has it. */
  reserve(cartId: string, locationId: string, start: Date): Promise<boolean>;
  updateClient(cartId: string, info: ClientInformation): Promise<void>;
  setPaymentToken(cartId: string, token: string): Promise<void>;
  /** Turns the live reservation into an appointment. Null if it expired in the meantime. */
  checkout(cartId: string): Promise<{ appointmentId: string; clientId: string } | null>;
}

export type Context = { store: BoulevardStore; now: Date };

/** Shown to callers in Boulevard's error format: { __typename: "BlvdError", code, message, description }. */
export class BlvdError extends Error {
  readonly code: string;
  readonly description: string;
  constructor(code: string, message: string, description: string) {
    super(message);
    this.code = code;
    this.description = description;
  }
}

export const schema = buildSchema(/* GraphQL */ `
  scalar Date
  scalar DateTime
  scalar Tz

  type Query {
    business: Business!
    cart(id: ID!): Cart
    cartBookableDates(id: ID!, searchRangeLower: Date!, searchRangeUpper: Date!, tz: Tz): [CartBookableDate!]!
    cartBookableTimes(id: ID!, searchDate: Date!, tz: Tz): [CartBookableTime!]!
  }

  type Mutation {
    createCart(input: CreateCartInput!): CreateCartPayload
    addCartSelectedBookableItem(input: AddCartSelectedBookableItemInput!): AddCartSelectedBookableItemPayload
    reserveCartBookableItems(input: ReserveCartBookableItemsInput!): ReserveCartBookableItemsPayload
    updateCart(input: UpdateCartInput!): UpdateCartPayload
    addCartCardPaymentMethod(input: AddCartCardPaymentMethodInput!): AddCartCardPaymentMethodPayload
    checkoutCart(input: CheckoutCartInput!): CheckoutCartPayload
  }

  type Business { id: ID!  name: String!  locations(first: Int): LocationConnection! }
  type LocationConnection { edges: [LocationEdge!]! }
  type LocationEdge { node: Location! }
  type Location { id: ID!  name: String!  tz: Tz! }

  type Cart {
    id: ID!
    location: Location!
    availableCategories: [CartItemCategory!]!
    selectedItems: [CartBookableItem!]!
    clientInformation: CartClientInformation
    "The reserved start time, while the reservation is live."
    startTime: DateTime
    "When the reservation lapses (30 minutes after reserving)."
    expiresAt: DateTime
    completedAt: DateTime
    "What's still missing before checkout. Use these to drive navigation."
    errors: [CartError!]!
  }

  type CartItemCategory { name: String!  availableItems: [CartAvailableItem!]! }
  interface CartAvailableItem { id: ID!  name: String! }
  type CartAvailableBookableItem implements CartAvailableItem {
    id: ID!
    name: String!
    "Price in cents."
    listPrice: Int!
  }
  type CartBookableItem { id: ID!  item: CartAvailableBookableItem! }
  type CartClientInformation { email: String  firstName: String  lastName: String  phoneNumber: String }
  type CartError { code: String!  message: String!  description: String! }
  type CartBookableDate { date: Date! }
  type CartBookableTime { id: ID!  score: Float!  startTime: DateTime! }

  input CartClientInformationInput { email: String  firstName: String  lastName: String  phoneNumber: String }
  input CreateCartInput { locationId: ID!  clientInformation: CartClientInformationInput }
  input AddCartSelectedBookableItemInput { id: ID!  itemId: ID!  itemStaffVariantId: ID }
  input ReserveCartBookableItemsInput { id: ID!  bookableTimeId: ID! }
  input UpdateCartInput { id: ID!  clientInformation: CartClientInformationInput }
  input AddCartCardPaymentMethodInput { id: ID!  token: String!  select: Boolean }
  input CheckoutCartInput { id: ID! }

  type CreateCartPayload { cart: Cart! }
  type AddCartSelectedBookableItemPayload { cart: Cart! }
  type ReserveCartBookableItemsPayload { cart: Cart! }
  type UpdateCartPayload { cart: Cart! }
  type AddCartCardPaymentMethodPayload { cart: Cart! }
  type CheckoutCartPayload { cart: Cart!  appointments: [CheckoutAppointment!]! }
  type CheckoutAppointment { appointmentId: ID!  clientId: ID!  forCartOwner: Boolean! }
`);

const DAY_MS = 86_400_000;
const MAX_DATE_RANGE_DAYS = 62;

const toLocation = (id: string) => ({ id, name: VENDOR_LOCATIONS[id].name, tz: VENDOR_LOCATIONS[id].timezone });
const toItem = (service: (typeof SERVICES)[number]) => ({
  __typename: "CartAvailableBookableItem",
  id: service.id,
  name: service.name,
  listPrice: service.priceCents,
});

function liveReservation(cart: CartRecord, now: Date) {
  const r = cart.reservation;
  return r && (r.status === "booked" || r.expiresAt > now) ? r : null;
}

function cartErrors(cart: CartRecord, now: Date) {
  const errors = [];
  if (!cart.clientInformation?.email) {
    errors.push({
      code: "CART_MISSING_CLIENT_INFORMATION",
      message: "Please fill in your contact details.",
      description: "This cart is not associated with an existing client, therefore separate client information is required.",
    });
  }
  if (!liveReservation(cart, now)) {
    errors.push({
      code: "CART_MISSING_ITEM_TIME",
      message: "Please select a time for all booked items.",
      description: "One or more bookable items is missing a reserved time.",
    });
  }
  if (!cart.paymentToken) {
    errors.push({
      code: "CART_MISSING_ITEM_PAYMENT_METHOD",
      message: "Please select a payment method for all items.",
      description: "One or more cart items is missing a payment method.",
    });
  }
  return errors;
}

function toCart(cart: CartRecord, now: Date) {
  const tz = VENDOR_LOCATIONS[cart.locationId].timezone;
  const live = liveReservation(cart, now);
  const service = SERVICES.find((s) => s.id === cart.itemId);
  return {
    id: cart.id,
    location: toLocation(cart.locationId),
    availableCategories: [{ name: "Hair Restoration", availableItems: SERVICES.map(toItem) }],
    selectedItems: service ? [{ id: `${cart.id}:item:1`, item: toItem(service) }] : [],
    clientInformation: cart.clientInformation,
    startTime: live ? formatLocal(live.startTime, tz) : null,
    expiresAt: live?.status === "reserved" ? live.expiresAt.toISOString() : null,
    completedAt: cart.completedAt?.toISOString() ?? null,
    errors: cartErrors(cart, now),
  };
}

async function loadCart(ctx: Context, id: string): Promise<CartRecord> {
  const cart = await ctx.store.getCart(id);
  if (!cart) throw new BlvdError("CART_NOT_FOUND", "This booking session has expired.", `No cart with id ${id}.`); // mock code
  return cart;
}

function assertOpen(cart: CartRecord) {
  // The docs: once checkoutCart succeeds, no further changes to the cart are allowed.
  if (cart.completedAt) throw new BlvdError("CART_COMPLETED", "This booking is already complete.", "The cart was checked out."); // mock code
}

function assertHasItem(cart: CartRecord) {
  if (!cart.itemId) {
    throw new BlvdError("CART_NO_BOOKABLE_ITEMS", "Please choose a service first.", "Add a bookable item before searching for times."); // mock code
  }
}

function timezoneArg(tz: string | undefined, fallback: string): string {
  if (!tz) return fallback;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    throw new BlvdError("INVALID_TIMEZONE", "Invalid time zone.", `Unknown tz ${tz}.`); // mock code
  }
}

function dateArg(value: string, name: string) {
  const date = parseDate(value);
  if (!date) throw new BlvdError("INVALID_ARGUMENT", "Invalid date.", `${name} must be YYYY-MM-DD.`); // mock code
  return date;
}

const inWindow = (start: Date, now: Date) => start.getTime() <= now.getTime() + BOOKING_WINDOW_DAYS * DAY_MS;

/** Slots for one local day at the cart's location, minus the ones already taken. */
function freeSlots(cart: CartRecord, date: { year: number; month: number; day: number }, now: Date, taken: Set<number>) {
  return generateSlots(cart.locationId, date, now).filter((slot) => inWindow(slot.start, now) && !taken.has(slot.start.getTime()));
}

type Args<T> = { input: T };

export const rootValue = {
  business: () => ({
    id: "urn:blvd:Business:8d2a7c40-3e5f-4b91-a6c8-000000000001",
    name: "Great Many (demo)",
    locations: ({ first }: { first?: number }) => ({
      edges: Object.keys(VENDOR_LOCATIONS)
        .slice(0, first ?? 20)
        .map((id) => ({ node: toLocation(id) })),
    }),
  }),

  cart: async ({ id }: { id: string }, ctx: Context) => {
    const cart = await ctx.store.getCart(id);
    return cart && toCart(cart, ctx.now);
  },

  // Dates are the location's local dates. tz only changes how times are written.
  cartBookableDates: async (
    args: { id: string; searchRangeLower: string; searchRangeUpper: string; tz?: string },
    ctx: Context,
  ) => {
    const cart = await loadCart(ctx, args.id);
    assertHasItem(cart);
    timezoneArg(args.tz, "UTC");
    const lower = dateArg(args.searchRangeLower, "searchRangeLower");
    const upper = dateArg(args.searchRangeUpper, "searchRangeUpper");
    const tz = VENDOR_LOCATIONS[cart.locationId].timezone;

    const days: { year: number; month: number; day: number }[] = [];
    for (let t = Date.UTC(lower.year, lower.month - 1, lower.day); t <= Date.UTC(upper.year, upper.month - 1, upper.day); t += DAY_MS) {
      if (days.length === MAX_DATE_RANGE_DAYS) break;
      const d = new Date(t);
      days.push({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() });
    }
    if (days.length === 0) return [];

    // One query for the whole range instead of one per day.
    const [from] = dayBounds(days[0], tz);
    const [, to] = dayBounds(days[days.length - 1], tz);
    const taken = new Set(await ctx.store.takenStarts(cart.locationId, from, to));
    return days.filter((d) => freeSlots(cart, d, ctx.now, taken).length > 0).map((d) => ({ date: formatDate(d) }));
  },

  cartBookableTimes: async (args: { id: string; searchDate: string; tz?: string }, ctx: Context) => {
    const cart = await loadCart(ctx, args.id);
    assertHasItem(cart);
    const locationTz = VENDOR_LOCATIONS[cart.locationId].timezone;
    const tz = timezoneArg(args.tz, locationTz);
    const date = dateArg(args.searchDate, "searchDate");
    const [from, to] = dayBounds(date, locationTz);
    const taken = new Set(await ctx.store.takenStarts(cart.locationId, from, to));
    return freeSlots(cart, date, ctx.now, taken).map((slot) => ({
      id: slot.id,
      score: slot.score,
      startTime: formatLocal(slot.start, tz),
    }));
  },

  createCart: async ({ input }: Args<{ locationId: string; clientInformation?: ClientInformation }>, ctx: Context) => {
    if (!VENDOR_LOCATIONS[input.locationId]) {
      throw new BlvdError("LOCATION_NOT_FOUND", "Location not found.", `No location with id ${input.locationId}.`); // mock code
    }
    const created = await ctx.store.createCart(input.locationId);
    if (input.clientInformation) await ctx.store.updateClient(created.id, validClientInformation(input.clientInformation));
    return { cart: toCart((await ctx.store.getCart(created.id))!, ctx.now) };
  },

  addCartSelectedBookableItem: async ({ input }: Args<{ id: string; itemId: string }>, ctx: Context) => {
    const cart = await loadCart(ctx, input.id);
    assertOpen(cart);
    if (!SERVICES.some((s) => s.id === input.itemId)) {
      throw new BlvdError("ITEM_NOT_FOUND", "That service isn't available.", `No item with id ${input.itemId}.`); // mock code
    }
    await ctx.store.setItem(cart.id, input.itemId);
    return { cart: toCart(await loadCart(ctx, cart.id), ctx.now) };
  },

  reserveCartBookableItems: async ({ input }: Args<{ id: string; bookableTimeId: string }>, ctx: Context) => {
    const cart = await loadCart(ctx, input.id);
    assertOpen(cart);
    assertHasItem(cart);
    const tz = VENDOR_LOCATIONS[cart.locationId].timezone;
    const start = parseTimeId(input.bookableTimeId, tz);
    const notAvailable = () =>
      new BlvdError(
        "CART_TIME_NOT_AVAILABLE",
        "Time is no longer available, please select another.",
        `The selected time ${input.bookableTimeId} is no longer available.`,
      );
    // Only a time Boulevard offers can be reserved (not 9:17, not a busy or past slot).
    const offered = start && freeSlots(cart, localDate(start, tz), ctx.now, new Set()).some((s) => s.start.getTime() === start.getTime());
    if (!start || !offered) throw notAvailable();
    if (!(await ctx.store.reserve(cart.id, cart.locationId, start))) throw notAvailable();
    return { cart: toCart(await loadCart(ctx, cart.id), ctx.now) };
  },

  updateCart: async ({ input }: Args<{ id: string; clientInformation?: ClientInformation }>, ctx: Context) => {
    const cart = await loadCart(ctx, input.id);
    assertOpen(cart);
    if (input.clientInformation) {
      await ctx.store.updateClient(cart.id, { ...cart.clientInformation, ...validClientInformation(input.clientInformation) });
    }
    return { cart: toCart(await loadCart(ctx, cart.id), ctx.now) };
  },

  addCartCardPaymentMethod: async ({ input }: Args<{ id: string; token: string }>, ctx: Context) => {
    const cart = await loadCart(ctx, input.id);
    assertOpen(cart);
    await ctx.store.setPaymentToken(cart.id, input.token);
    return { cart: toCart(await loadCart(ctx, cart.id), ctx.now) };
  },

  checkoutCart: async ({ input }: Args<{ id: string }>, ctx: Context) => {
    const cart = await loadCart(ctx, input.id);
    const appointments = (c: CartRecord) => [
      { appointmentId: c.reservation!.appointmentId!, clientId: c.reservation!.clientId!, forCartOwner: true },
    ];
    // A retry after a lost response gets the same result. (Unverified against the real
    // API: a robust caller should read cart.completedAt before checking out again.)
    if (cart.completedAt && cart.reservation?.status === "booked") return { cart: toCart(cart, ctx.now), appointments: appointments(cart) };

    const [missing] = cartErrors(cart, ctx.now);
    if (missing) throw new BlvdError(missing.code, missing.message, missing.description);
    if (!(await ctx.store.checkout(cart.id))) {
      const lapsed = cartErrors({ ...cart, reservation: null }, ctx.now).find((e) => e.code === "CART_MISSING_ITEM_TIME")!;
      throw new BlvdError(lapsed.code, lapsed.message, lapsed.description);
    }
    const done = await loadCart(ctx, cart.id);
    return { cart: toCart(done, ctx.now), appointments: appointments(done) };
  },
};

// The docs: phoneNumber is E.164 (+13105555555). A value that can't be parsed fails the
// mutation itself, with no error code.
function validClientInformation(info: ClientInformation): ClientInformation {
  if (info.phoneNumber != null && !/^\+[1-9]\d{6,14}$/.test(info.phoneNumber)) {
    throw new Error(`Invalid PhoneNumber: ${info.phoneNumber}`);
  }
  return info;
}
