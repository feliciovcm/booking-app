-- treatments
create table public.treatments (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  description text not null default '',
  price_cents integer not null check (price_cents >= 0),
  session_count integer not null default 1 check (session_count > 0),
  active boolean not null default true,
  sort_order integer not null default 0
);

-- Layer 1, privileges: which roles may touch the table at all.
-- Don't rely on the dashboard's auto-grant setting. Start from nothing, grant only what's needed.
revoke all on public.treatments from anon, authenticated;
grant select on public.treatments to anon, authenticated;
grant all on public.treatments to service_role;

-- Layer 2, RLS: which rows those roles see.
alter table public.treatments enable row level security;

-- Only reads, only active rows. No insert/update/delete policy = denied.
create policy "Anyone can read active treatments"
  on public.treatments
  for select
  to anon, authenticated
  using (active);

-- ============================================================
-- locations
create table public.locations (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  address text not null,
  timezone text not null, -- IANA name; slots are shown in the clinic's timezone, not the browser's
  active boolean not null default true,
  sort_order integer not null default 0
);

revoke all on public.locations from anon, authenticated;
grant select on public.locations to anon, authenticated;
grant all on public.locations to service_role;

alter table public.locations enable row level security;

-- Only reads, only active rows. No insert/update/delete policy = denied.
create policy "Anyone can read active locations"
  on public.locations
  for select
  to anon, authenticated
  using (active);

-- ============================================================
-- location_provider_mappings (internal: vendor ids never reach the browser)
-- One vendor per location at a time.
create table public.location_provider_mappings (
  location_id uuid primary key references public.locations(id) on delete cascade,
  provider text not null,
  provider_location_id text not null,
  unique (provider, provider_location_id) -- two of our locations can't share one vendor clinic
);

-- No client grants at all: the API answers "permission denied" instead of an empty list,
-- so a future bad policy can't leak this table.
revoke all on public.location_provider_mappings from anon, authenticated;
grant all on public.location_provider_mappings to service_role;

alter table public.location_provider_mappings enable row level security;
-- No policies on purpose. service_role bypasses RLS; every other role is denied.

-- ============================================================
-- bookings (private: a signed-in user reads only their own rows)
-- Written only by edge functions (service_role). Clients never insert or update.
create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null, -- null = guest checkout
  email text not null check (email ~* '^[^@\s]+@[^@\s]+$'),
  treatment_id uuid not null references public.treatments(id),
  location_id uuid not null references public.locations(id),
  slot_start timestamptz not null, -- stored in UTC, shown in the location's timezone
  status text not null default 'held'
    check (status in ('held', 'confirmed', 'cancelled', 'expired')),
  provider text not null, -- the vendor holding this booking, even if the location switches later
  provider_booking_id text,
  stripe_customer_id text,
  stripe_setup_intent_id text unique,
  idempotency_key text not null unique, -- a retried "create booking" request can't double-book
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_booking_id)
);

-- The RLS policy filters on user_id, so index it or every read scans the table.
-- Partial: guest bookings (user_id null) never match the policy, so leave them out.
create index bookings_user_id_idx on public.bookings (user_id) where user_id is not null;

-- Keep updated_at honest: a default only covers inserts, Postgres has no "on update" default.
-- moddatetime is a ready-made trigger function; it lives in the unexposed extensions schema.
create extension if not exists moddatetime schema extensions;

create trigger bookings_set_updated_at
  before update on public.bookings
  for each row execute function extensions.moddatetime(updated_at);

-- Logged-out visitors get nothing. Signed-in users may only read.
revoke all on public.bookings from anon, authenticated;
grant select on public.bookings to authenticated;
grant all on public.bookings to service_role;

alter table public.bookings enable row level security;

-- Guest bookings (user_id null) never match, so no client can see them.
-- Linking a guest booking to an account later is done by the server after
-- verifying the email, never by a policy that matches on email.
create policy "Users read their own bookings"
  on public.bookings
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- ============================================================
-- webhook_events (internal: idempotency log for Stripe, the booking vendor, etc.)
-- Recorded is not the same as processed: a retry is skipped only once processed_at is set.
create table public.webhook_events (
  provider text not null,  -- 'stripe', 'mock-scheduler'
  event_id text not null,  -- the provider's id for this delivery, e.g. evt_123
  type text not null,      -- e.g. 'setup_intent.succeeded'
  payload jsonb not null,  -- raw event, for replay and debugging; may contain personal data
  received_at timestamptz not null default now(),
  processed_at timestamptz,             -- null = not done yet, so a retry runs it again
  attempts integer not null default 0,  -- how many times we tried; high counts = dead letter
  last_error text,                      -- why the last attempt failed (no secrets or personal data)
  primary key (provider, event_id)      -- a duplicate delivery hits this and is detected
);

-- For the reconciliation job: "events received but never processed".
create index webhook_events_unprocessed_idx
  on public.webhook_events (received_at)
  where processed_at is null;

-- Server only, same as location_provider_mappings.
revoke all on public.webhook_events from anon, authenticated;
grant all on public.webhook_events to service_role;

alter table public.webhook_events enable row level security;
-- No policies on purpose.


-- ============================================================
-- consult_requests (the "Free phone consult" form: anyone can submit, nobody can read back)
create table public.consult_requests (
  id uuid primary key default gen_random_uuid(),
  full_name text not null check (char_length(full_name) between 1 and 100),
  phone text not null check (char_length(phone) between 7 and 20),
  email text check (char_length(email) <= 254),
  message text check (char_length(message) <= 1000),
  created_at timestamptz not null default now()
);

-- Insert only, for logged-out and logged-in visitors. No select: submissions hold personal data.
-- Consequence: the client must insert with return=minimal (no .insert().select()).
revoke all on public.consult_requests from anon, authenticated;
grant insert on public.consult_requests to anon, authenticated;
grant all on public.consult_requests to service_role;

alter table public.consult_requests enable row level security;

-- The grant lets the role reach the table; this policy lets the row in.
-- Validation lives in the check constraints above, so they also apply to the server.
create policy "Anyone can submit a consult request"
  on public.consult_requests
  for insert
  to anon, authenticated
  with check (true);

