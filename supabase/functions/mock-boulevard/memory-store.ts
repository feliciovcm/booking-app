// Test helper: an in-memory BoulevardStore with the same rules as the Postgres one.
// Used by the mock's own tests and by the adapter's contract tests. Never deployed:
// nothing in index.ts imports it.
import type { BoulevardStore, CartRecord, ClientInformation } from "./schema.ts";

// In-memory stand-in for the Postgres store, with the same rules: one live reservation
// per slot, reservations last 30 minutes, changing the item releases the reservation.
type Reservation = { cartId: string; locationId: string; start: number; status: string; expiresAt: number; appointmentId?: string; clientId?: string };
type Cart = { id: string; locationId: string; itemId: string | null; info: ClientInformation | null; token: string | null; completedAt: number | null };

export function memoryStore(clock: { now: number }): BoulevardStore {
  const carts = new Map<string, Cart>();
  const reservations: Reservation[] = [];
  const live = (r: Reservation) => r.status === "booked" || (r.status === "reserved" && r.expiresAt > clock.now);
  const release = (cartId: string) => reservations.filter((r) => r.cartId === cartId && r.status === "reserved").forEach((r) => (r.status = "released"));

  const getCart = async (id: string): Promise<CartRecord | null> => {
    const cart = carts.get(id);
    if (!cart) return null;
    const r = reservations.filter((x) => x.cartId === id && x.status !== "released").at(-1);
    return {
      id,
      locationId: cart.locationId,
      itemId: cart.itemId,
      clientInformation: cart.info,
      paymentToken: cart.token,
      completedAt: cart.completedAt ? new Date(cart.completedAt) : null,
      reservation: r
        ? { startTime: new Date(r.start), expiresAt: new Date(r.expiresAt), status: r.status as "reserved" | "booked", appointmentId: r.appointmentId ?? null, clientId: r.clientId ?? null }
        : null,
    };
  };

  return {
    getCart,
    async createCart(locationId) {
      const id = `urn:blvd:Cart:${carts.size + 1}`;
      carts.set(id, { id, locationId, itemId: null, info: null, token: null, completedAt: null });
      return (await getCart(id))!;
    },
    async setItem(cartId, itemId) {
      carts.get(cartId)!.itemId = itemId;
      release(cartId);
    },
    async takenStarts(locationId, from, to) {
      return reservations.filter((r) => r.locationId === locationId && r.start >= from.getTime() && r.start < to.getTime() && live(r)).map((r) => r.start);
    },
    async reserve(cartId, locationId, start) {
      release(cartId);
      if (reservations.some((r) => r.locationId === locationId && r.start === start.getTime() && live(r))) return false;
      reservations.push({ cartId, locationId, start: start.getTime(), status: "reserved", expiresAt: clock.now + 30 * 60_000 });
      return true;
    },
    async updateClient(cartId, info) {
      carts.get(cartId)!.info = info;
    },
    async setPaymentToken(cartId, token) {
      carts.get(cartId)!.token = token;
    },
    async checkout(cartId) {
      const r = reservations.find((x) => x.cartId === cartId && x.status === "reserved" && x.expiresAt > clock.now);
      if (!r) return null;
      Object.assign(r, { status: "booked", appointmentId: `urn:blvd:Appointment:${cartId}`, clientId: `urn:blvd:Client:${cartId}` });
      carts.get(cartId)!.completedAt = clock.now;
      return { appointmentId: r.appointmentId!, clientId: r.clientId! };
    },
    async findAppointment(appointmentId) {
      const r = reservations.find((x) => x.appointmentId === appointmentId && x.status === "booked");
      return r ? getCart(r.cartId) : null;
    },
    async rescheduleAppointment(appointmentId, start) {
      const r = reservations.find((x) => x.appointmentId === appointmentId && x.status === "booked");
      if (!r) return false;
      if (reservations.some((x) => x !== r && x.locationId === r.locationId && x.start === start.getTime() && live(x))) return false;
      r.start = start.getTime();
      return true;
    },
    async cancelAppointment(appointmentId) {
      const r = reservations.find((x) => x.appointmentId === appointmentId && x.status === "booked");
      if (!r) return false;
      r.status = "released";
      return true;
    },
  };
}
