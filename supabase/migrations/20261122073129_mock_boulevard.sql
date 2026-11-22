-- Storage for the fake Boulevard (supabase/functions/mock-boulevard).
--
-- It lives in its own schema, which is NOT in the Data API's exposed schemas, so no
-- client can reach it over REST even with grants. The function connects straight to
-- Postgres (SUPABASE_DB_URL), the way a real vendor owns its own database.

create schema if not exists mock_vendor;
revoke all on schema mock_vendor from public, anon, authenticated;

-- A Boulevard cart: one location, the chosen service, client details, a card token.
-- Mock simplification: one bookable item per cart (no guests, no add-ons).
create table mock_vendor.carts (
  id                 text primary key default 'urn:blvd:Cart:' || gen_random_uuid(),
  location_id        text not null,           -- urn:blvd:Location:...
  item_id            text,                    -- urn:blvd:Service:...
  client_information jsonb,                   -- { email, firstName, lastName, phoneNumber }
  payment_token      text,                    -- from Boulevard's Tokenization API
  completed_at       timestamptz,             -- set by checkoutCart
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- A reserved time on a cart. Boulevard holds it for 30 minutes; checkout turns it into
-- an appointment. Changing the cart's item releases it.
create table mock_vendor.reservations (
  id             bigint generated always as identity primary key,
  cart_id        text not null references mock_vendor.carts (id) on delete cascade,
  location_id    text not null,
  start_time     timestamptz not null,
  status         text not null default 'reserved'
                 check (status in ('reserved', 'booked', 'released')),
  expires_at     timestamptz not null default now() + interval '30 minutes',
  appointment_id text unique,                 -- urn:blvd:Appointment:..., set on checkout
  client_id      text,                        -- urn:blvd:Client:..., set on checkout
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- The double-booking guard: one live reservation or appointment per slot. Two people
-- racing for the same time both try the insert, and Postgres lets exactly one win
-- (23505 -> CART_TIME_NOT_AVAILABLE). A partial index can't use now(), so the function
-- releases a stale reservation on that slot first.
create unique index reservations_live_slot_idx
  on mock_vendor.reservations (location_id, start_time)
  where status in ('reserved', 'booked');

create index reservations_cart_id_idx on mock_vendor.reservations (cart_id);

create trigger carts_set_updated_at
  before update on mock_vendor.carts
  for each row execute function extensions.moddatetime(updated_at);

create trigger reservations_set_updated_at
  before update on mock_vendor.reservations
  for each row execute function extensions.moddatetime(updated_at);

-- Defense in depth: even if someone later exposes this schema, no client role has access.
alter table mock_vendor.carts enable row level security;
alter table mock_vendor.reservations enable row level security;
revoke all on all tables in schema mock_vendor from public, anon, authenticated;
