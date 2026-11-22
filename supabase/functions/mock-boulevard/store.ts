// Postgres-backed BoulevardStore, using the mock_vendor schema (see the mock_boulevard
// migration). Connects directly with SUPABASE_DB_URL because that schema is deliberately
// not exposed to the Data API.

import postgres from "postgres";
import type { BoulevardStore, CartRecord, ClientInformation } from "./schema.ts";

type CartRow = {
  id: string;
  location_id: string;
  item_id: string | null;
  client_information: ClientInformation | null;
  payment_token: string | null;
  completed_at: Date | null;
  start_time: Date | null;
  expires_at: Date | null;
  status: "reserved" | "booked" | null;
  appointment_id: string | null;
  client_id: string | null;
};

const toRecord = (row: CartRow): CartRecord => ({
  id: row.id,
  locationId: row.location_id,
  itemId: row.item_id,
  clientInformation: row.client_information,
  paymentToken: row.payment_token,
  completedAt: row.completed_at,
  reservation: row.status
    ? { startTime: row.start_time!, expiresAt: row.expires_at!, status: row.status, appointmentId: row.appointment_id, clientId: row.client_id }
    : null,
});

export function createPgStore(databaseUrl: string): BoulevardStore {
  // One connection per isolate is plenty for a mock. prepare: false keeps it safe behind
  // a transaction-mode pooler, which doesn't support prepared statements.
  const sql = postgres(databaseUrl, { prepare: false, max: 1 });

  const getCart = async (id: string) => {
    const [row] = await sql<CartRow[]>`
      select c.id, c.location_id, c.item_id, c.client_information, c.payment_token, c.completed_at,
             r.start_time, r.expires_at, r.status, r.appointment_id, r.client_id
      from mock_vendor.carts c
      left join lateral (
        select * from mock_vendor.reservations
        where cart_id = c.id and status <> 'released'
        order by id desc limit 1
      ) r on true
      where c.id = ${id}`;
    return row ? toRecord(row) : null;
  };

  return {
    getCart,

    async createCart(locationId) {
      const [row] = await sql<{ id: string }[]>`
        insert into mock_vendor.carts (location_id) values (${locationId}) returning id`;
      return (await getCart(row.id))!;
    },

    async setItem(cartId, itemId) {
      await sql.begin(async (tx) => {
        await tx`update mock_vendor.carts set item_id = ${itemId} where id = ${cartId}`;
        await tx`update mock_vendor.reservations set status = 'released' where cart_id = ${cartId} and status = 'reserved'`;
      });
    },

    async takenStarts(locationId, from, to) {
      const rows = await sql<{ start_time: Date }[]>`
        select start_time from mock_vendor.reservations
        where location_id = ${locationId}
          and start_time >= ${from} and start_time < ${to}
          and (status = 'booked' or (status = 'reserved' and expires_at > now()))`;
      return rows.map((row) => row.start_time.getTime());
    },

    async reserve(cartId, locationId, start) {
      try {
        await sql.begin(async (tx) => {
          // Reserving a new time replaces the cart's old reservation.
          await tx`update mock_vendor.reservations set status = 'released' where cart_id = ${cartId} and status = 'reserved'`;
          // A stale reservation still counts in the partial unique index until released.
          await tx`
            update mock_vendor.reservations set status = 'released'
            where location_id = ${locationId} and start_time = ${start}
              and status = 'reserved' and expires_at <= now()`;
          await tx`
            insert into mock_vendor.reservations (cart_id, location_id, start_time)
            values (${cartId}, ${locationId}, ${start})`;
        });
        return true;
      } catch (error) {
        // 23505 = unique_violation: someone else reserved or booked this slot.
        if ((error as { code?: string }).code === "23505") return false;
        throw error;
      }
    },

    async updateClient(cartId, info) {
      await sql`update mock_vendor.carts set client_information = ${sql.json(info)} where id = ${cartId}`;
    },

    async setPaymentToken(cartId, token) {
      await sql`update mock_vendor.carts set payment_token = ${token} where id = ${cartId}`;
    },

    async checkout(cartId) {
      return sql.begin(async (tx) => {
        const [booked] = await tx<{ appointment_id: string; client_id: string }[]>`
          update mock_vendor.reservations
          set status = 'booked',
              appointment_id = 'urn:blvd:Appointment:' || gen_random_uuid(),
              client_id = 'urn:blvd:Client:' || gen_random_uuid()
          where cart_id = ${cartId} and status = 'reserved' and expires_at > now()
          returning appointment_id, client_id`;
        if (!booked) return null;
        await tx`update mock_vendor.carts set completed_at = now() where id = ${cartId}`;
        return { appointmentId: booked.appointment_id, clientId: booked.client_id };
      });
    },
  };
}
