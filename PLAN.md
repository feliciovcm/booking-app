# Plan: mini Great Many booking funnel (interview prep)

Read this first in a new session. It's the plan we're executing, what's done, the decisions behind it, and exactly where to pick up.

**Start new sessions from this folder** (`~/projects/great-many-demo`), so the Supabase skills in `.claude/skills/` load automatically.

## Goal

Prepare for the final interview for a **Lead Developer** role at **Great Many** (a hair-growth clinic chain, hiring through Devlane), working with the CTO.
- **Their stack:** React + TypeScript, PostgreSQL, serverless/edge functions, booking/payments/CRM integrations, GTM, Klaviyo, and AI coding tools.
- **The role, from their notes:**
  - the custom booking flow, the Treatment Plan Builder and the Consult App (Appointment 2.0, Comms 2.0)
  - owning the **Boulevard** integration (reliable, observable, documented)
  - moving off Zapier to custom code, n8n and **Cloudflare Workers**, with **Segment** as the single source of truth for events
  - AI-driven development: guardrails and review so less technical teammates can build in a playground, then turning experiments into production code
  - engineering standards: reviews, branching and releases, staging vs production, testing, secrets, docs, Linear

This repo is a small copy of their booking funnel, used to learn that stack hands-on and talk about it with real examples.
- **What I saw on their site:** the marketing site runs on Framer with GTM, Segment, Klaviyo and Intercom. The booking app (`start.greatmany.com`) is a custom SPA on **Supabase**, reading tables such as `treatments`, `booking_config` and `location_mappings`.
- **Interview prep notes** live in [INTERVIEW.md](INTERVIEW.md): answers to rehearse, trade-offs, and questions to ask. Add to it as each step teaches something worth saying.

## How we work
- **Build in small steps.** Discuss before building.
- **The user writes the parts they want to learn:** SQL, RLS, edge functions, Stripe and Klaviyo calls. Claude writes the React/Vite plumbing and reviews and tests the user's code. The user often asks Claude to write or fix the parts too.
- **Every step ends with checks that pass,** plus notes for INTERVIEW.md.
- **The user commits themselves.** Never commit or push without being asked.
- **Text rules** (from the user's global CLAUDE.md): no em dashes, no filler, no AI mentions in commits or PRs.

## Architecture

```
React app ──(publishable key, grants + RLS)──► Supabase Postgres   (reads: treatments, locations, own bookings)
    │
    └──► Edge functions (hold secrets, use service_role)
           ├─ booking (cart, dates, times, reserve) ──► mock-boulevard   (fake Boulevard Client API: OAuth2 + GraphQL)
           ├─ checkout ─────────────────────────────► mock-boulevard   (client info, card token, checkoutCart)
           └─ boulevard-webhook ◄─────────────────── Boulevard          (HMAC check, idempotent via webhook_events,
                  │                                                      settle bookings, reconcile, forward to Segment)
                  └──► n8n (self-hosted in Docker, via a tunnel)         (ops flows: e.g. cancellation -> Slack)
Browser ──► Segment (consent-gated) ──┐
Server events (checkout, webhooks) ───┴──► Segment ──► Klaviyo, GA4      (Segment is the single source of truth)
```

Great Many's vendor is **Boulevard** (confirmed). `mock-boulevard` copies a subset of its Client API v2026-06, so swapping to Boulevard's sandbox is a base URL and credentials. Notes from their docs are in INTERVIEW.md, "Boulevard".

### Key decisions (and why)
- **Card on file, not a deposit.** Great Many shows "$0 due today". Boulevard holds the card itself (Tokenization API, then `addCartCardPaymentMethod`), so Stripe is probably not part of booking. Ask in the interview where Stripe fits (packages? Treatment Plan Builder?).
- **Boulevard's rules shape the flow:**
  - availability belongs to a cart, so the funnel creates a cart after location and service and keeps `cartId` for the session (not in the URL)
  - never cache times on the server
  - query dates before times, one query at a time
  - a reservation lasts 30 minutes and is lost if the cart changes
  - drive navigation from `cart.errors`
- **Reads may go browser to Boulevard directly** (an anonymous token is meant for that). Checkout and webhooks go through our server, for logging, Segment events and idempotency.
- **The provider name is the vendor (`boulevard`), not the environment.** The mock, the sandbox and production differ only by config.
- **Hosted Supabase project for now** (`oacvxfhapwwebaodjheh`). We'll move to a local Docker stack later, with seed data moving from a migration into `supabase/seed.sql`.
- **Least-privilege access in every migration:**
  - Start with `revoke all`, then grant per table. Enable RLS explicitly. Since 2026-10-30 Supabase no longer auto-exposes new tables to the API.
  - `service_role` gets explicit grants, because it bypasses RLS but not grants.
  - Write policies per operation.
- **Clients never write bookings directly.** Edge functions do, so they can check the vendor and Stripe and log what happened.
- **Vendor ids live in `location_provider_mappings`,** which is server only. Bookings store `provider`, so a studio can switch vendors (see INTERVIEW.md).
- **Funnel state is in the URL** (`?service=prp&location=noho`), so deep links, refresh and back all work.
- **The back button goes to the previous step's URL, not browser history,** because deep-linked visitors have no history in the app.
- **`updated_at` uses `moddatetime`,** because Postgres has no "on update" default.
- **Webhook receiver is a Supabase edge function, not a Cloudflare Worker** (decided 2026-11-23). It's free, there's no second platform holding secrets, and the logic sits next to the data. Supabase is reliable enough for Boulevard's 5 to 10 second ack. If we later have several webhook sources, or want n8n behind a verified front door, the intake moves to a Worker and the processing code stays the same. Calling Supabase REST from a Worker was rejected: it would put the secret key, which bypasses RLS, in Cloudflare. See INTERVIEW.md, "Do we need a Worker at all?".
- **n8n only sees clean events.** Our function verifies, dedupes and strips personal data, then forwards to n8n. n8n never handles raw vendor webhooks or credentials for our database.
- **Dependencies are on their latest majors,** with supabase-js pinned exactly (`2.119.2`), as Supabase's guidance recommends.

## Status

| Step | What | Who | Status |
|---|---|---|---|
| 1 | Schema, grants, RLS, pgTAP tests, attacker probe | User + Claude | **Done**, pushed to hosted, all checks green |
| 2 | Funnel shell: services, location, slot placeholder, free consult form | Claude | **Done**, merged to `main` |
| 3 | Availability: `mock-boulevard` (Claude) + `_shared/log.ts`, the Boulevard adapter and the `booking` function (user) + SlotStep (Claude) | Both | **Done**, merged into `main`. Then the frontend was reorganized into layers on `refactor-layers` (see Frontend layout) |
| 4 | Checkout: client info, card token, `checkoutCart`, our `bookings` row with idempotency key | Both | **Done**, merged into `main` (`175500f`): server deployed, UI checked in the browser |
| 5 | `boulevard-webhook` **edge function**: HMAC check, `webhook_events`, settle `held` bookings, reschedules and cancellations, reconciliation job, an optional forward to automations | Claude (step by step, tests first) | **Done**, deployed 2026-11-25 (branches `step-5-webhooks`, `step-5-retries`) |
| 5b | **n8n**: self-hosted in Docker, reached through a Cloudflare quick tunnel, one ops flow fed by step 5's forward, workflow JSON in git | User (guided) | **Done** 2026-11-27 |
| 6 | Auth (6-digit email code) + "My bookings" page (RLS: own rows), bookings linked at checkout and claimed by verified email | Claude (step by step) | In progress |
| 7 | **Segment**: typed `track()` with consent gate in the browser, server-side events from checkout and webhooks, event spec | Both | To do |
| 8 | Klaviyo as a **Segment destination**: "Booking Completed" flow, reminders (Comms 2.0) | User | To do |
| 9 | Wrap-up: CI with all checks, README, CLAUDE.md with guardrails, "playground to production" checklist and review guide, staging vs production (Boulevard sandbox, second Supabase project), secrets rules, final talking points | Claude | To do |

### Frontend layout (layers, from the `refactor-layers` branch)
Folders in `src/` are layers. Within each layer, one file per domain.
- `lib/`: the Supabase client and generated DB types. Only `api/` imports them.
- `api/`: calls to the backend, with no React (`booking.ts`, `catalog.ts`, `consult.ts`).
- `hooks/`: TanStack Query and router hooks, one file per domain (`booking.ts`, `catalog.ts`, `funnel.ts`).
- `routes/`: the route tree (`index.tsx`) and the funnel's URL helpers (`funnel.ts`).
- `layouts/`: `BookingLayout`. `components/`: shared pieces (`QueryState`). `pages/booking/`: the steps and the consult page.
- `utils/`: pure helpers (`time.ts`, `format.ts`).
- `__tests__/`: tests mirroring `src`, with shared helpers in `__tests__/helpers/` (fake booking function, `renderAt`, setup). Edge function tests stay beside their files in `supabase/functions`.
- Dependencies point one way: pages use hooks, hooks use api, api uses lib.

### Step 1 details (done)
- **Migrations** in `supabase/migrations/`:
  - `..._step1_schema_and_rls.sql`: 6 tables (treatments, locations, location_provider_mappings, bookings, webhook_events, consult_requests).
  - `..._step1_seed_demo_data.sql`: demo rows. This should move to `seed.sql` when we go local.
  - `..._revoke_rls_auto_enable_execute.sql`: fixes an advisor warning about a function created by the dashboard setting.
  - `..._index_bookings_foreign_keys.sql`: from the audit against the Supabase skills.
- **Tests:** `supabase/tests/rls.test.sql`, 22 pgTAP tests.
- **Probe:** `scripts/probe-rls.mjs`, which acts as an attacker using the publishable key.
- **Spec:** `docs/step-1-schema-rls.md`.

### Step 2 details (done)
- **Data and client:** `src/lib/` holds the typed client (`supabase.ts`), catalog queries with TanStack Query (`catalog.ts`), the insert-only consult request (`consult.ts`), and generated types.
- **Funnel:** the URL state (`routes/funnel.ts`, `hooks/funnel.ts`), the layout with its back link, the steps, the consult page, and the tests (14). These lived in `src/funnel/` until the layers refactor.
- **Review fixes:** the slot step now validates the treatment, and the back button no longer uses browser history.

## Current repo state (when this was written)
- **Branch:** `step-5-webhooks`, cut from `main` at `175500f` (step 4 merged).
- **Not committed:** doc updates (PLAN.md, INTERVIEW.md, PROGRESS.md, `docs/`).

## Checks (run all before calling a step done)

```bash
npm run lint
```
```bash
npm run typecheck
```
```bash
npm test
```
```bash
npm run build
```
```bash
npm run probe:rls
```
```bash
npx supabase db advisors --remote
```
```bash
bash scripts/smoke-mock-boulevard.sh
```
```bash
bash scripts/smoke-booking.sh
```
```bash
npx supabase test db --remote --yes
```

## Gotchas already solved (don't rediscover them)
- **Supabase CLI v3** (3.2.0) treats the hosted project as "production". `db push`, `test db` and `gen types` against it ask for confirmation, and in an agent run they fail without `--yes`.
  - **Ask the user before using `--yes`.** They approved it for `test db`. `db push` should keep asking.
  - The npm scripts use `--remote`.
- **pgTAP against the hosted DB** runs as a temporary `cli_login_postgres` role that can't use the `extensions` schema. The test file starts with `set local role postgres` and sets the search path, and switches back with `set local role postgres`, never `reset role`.
- **`.env.local` holds `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`** (a publishable key, not the legacy anon key). Never put the secret or service key in a `VITE_` variable.
- **Don't edit a pushed migration.** Add a new one with `npx supabase migration new <name>`.
- **`consult_requests` is insert-only,** so the client must use `.insert()` without `.select()`. A test guards this.
- **Read the Supabase skills** in `.claude/skills/` before writing Supabase code, and check `https://supabase.com/changelog.md` for breaking changes.
- **Boulevard's docs (developers.joinblvd.com) are a JavaScript app,** so a plain fetch returns an empty page. Read them with a real browser (gstack `$B`, taking the main article's `innerText`).
- **Edge function code split:** the runtime-agnostic files (`slots.ts`, `schema.ts`, `tokens.ts`, `handler.ts`) are tested by Vitest and typechecked by `tsconfig.functions.json`. `index.ts` and `store.ts` use Deno globals and npm packages, so only Deno checks them, at deploy time. Bare imports (`graphql`, `postgres`) resolve through `deno.json` in Deno and through node_modules in Vitest.
- **Secret names can't start with `SUPABASE_`.** Edge functions get `SUPABASE_URL`, `SUPABASE_DB_URL`, `SUPABASE_SECRET_KEYS` and others by default.

## Step 3 (availability, done)

1. **Done: `supabase/functions/mock-boulevard/`** (Claude), a subset of Boulevard's Client API:
   - `POST /oauth2/token`: the anonymous grant (15 minutes, CORS) and client_credentials (24 hours)
   - `POST /api/2026-06/client` (GraphQL): `business.locations`, `cart`, `createCart`, `addCartSelectedBookableItem`, `cartBookableDates`, `cartBookableTimes`, `reserveCartBookableItems`, `updateCart`, `addCartCardPaymentMethod`, `checkoutCart`
   - errors in Boulevard's `BlvdError` format, 30-minute reservations, and a Postgres double-booking guard (`mock_vendor` schema)
   - failures forced with `x-mock-fail: 429|500|503|timeout` or random at `MOCK_FAILURE_RATE`
   - 35 Vitest tests
   - The files: `slots.ts` (catalog, slot engine, time zones), `schema.ts` (GraphQL schema and resolvers), `tokens.ts`, `handler.ts` (HTTP), `store.ts` (Postgres), `index.ts` (Deno entry), `deno.json` (import map)
2. **Done: pushed and deployed** (2026-11-22).
   - Both migrations are pushed.
   - The secrets were generated into `supabase/functions/.env` (gitignored) and set with `supabase secrets set --env-file`.
   - The function is deployed.
   - `bash scripts/smoke-mock-boulevard.sh` passes 11 of 11, covering the whole flow, the double-booking race, a checkout retry, the forced 429, a timeout, and random failures (about 10%).
   - `mock_vendor` is not reachable over REST (PGRST106).
   - Header `x-mock-fail: none` turns off random failures for one request.
3. **Done: `supabase/functions/_shared/log.ts`** (written by the user, fixed by Claude, 7 tests): structured JSON logs carrying request ids and no personal data (example in INTERVIEW.md, "Edge functions").
4. **Done: the Boulevard adapter** (`_shared/boulevard.ts`, Claude, 11 contract tests against the mock handler):
   - fetch and cache a client_credentials token (24 hours)
   - send GraphQL
   - map `BlvdError` codes to our errors
   - use an `AbortController` timeout
   - retry only on 429/503, with backoff, reading "wait Nms" from the 429 message
5. **Written, not deployed: the `booking` function** (Claude, 15 tests that run end to end in memory through the adapter and the mock, plus a made-up second vendor):
   - **Vendor-agnostic.** `booking/handler.ts` never mentions Boulevard. It depends on the `BookingProvider` contract in `_shared/booking-provider.ts`: `startSession`, `availableDates`, `availableTimes`, `hold`, and our `BookingError` codes (`SLOT_UNAVAILABLE`, `SESSION_EXPIRED`, `INVALID`, `UNAVAILABLE`, `MISCONFIGURED`).
   - **Composition root.** `booking/index.ts` is the only file that knows vendors exist: `providers: { boulevard: (log) => createBoulevard(...) }`. Adding a vendor means writing its adapter, registering it there, and pointing mapping rows at its name.
   - **The adapter translates.** Boulevard's codes become ours (`CART_TIME_NOT_AVAILABLE` becomes `SLOT_UNAVAILABLE`), and Boulevard's code is kept as `vendorCode` for the logs only.
   - **The session id records its vendor:** `"<provider>|<vendor session id>"`, opaque to the browser. Follow-up calls reach the same vendor without the frontend knowing vendors exist.
   - **Actions:** `start` returns a `sessionId`, then `dates`, `times` and `hold`. Bodies are validated with zod. Times aren't cached on the server.
   - **Mapping:** a new `service_provider_mappings` table (migration `20261123075411`) maps treatments to vendor service ids. It's server only, and the probe and pgTAP (now 23 tests) check that.
   - **Auth:** `verify_jwt = false`, and the function checks the `apikey` header against `SUPABASE_PUBLISHABLE_KEYS` itself. That's Supabase's recommendation for publishable-key functions.
   - **CORS:** origins come from `BOOKING_ALLOWED_ORIGINS`.
   - **Errors:** `{ error: { code, message } }`. 409 for `SLOT_UNAVAILABLE` and `SESSION_EXPIRED`, 400 for `INVALID`, 503 for `UNAVAILABLE`, 502 for `MISCONFIGURED`, 404 for `NOT_BOOKABLE`.
   - **To deploy:**
     - `db push`
     - `secrets set` for `BOULEVARD_BASE_URL` (`<SUPABASE_URL>/functions/v1/mock-boulevard`), `BOULEVARD_CLIENT_ID`, `BOULEVARD_CLIENT_SECRET` and `BOULEVARD_BUSINESS_ID` (the same values as the mock's), plus `BOOKING_ALLOWED_ORIGINS`
     - `functions deploy booking`
     - then curl it, and run pgTAP, the probe and `db:types`
   - **Deployed 2026-11-23** by the user. `bash scripts/smoke-booking.sh` passes 13 of 13 (CORS, start, dates, times, hold, a double hold returning 409 `SLOT_UNAVAILABLE`, `NOT_BOOKABLE`, `SESSION_EXPIRED`, 400, 401). pgTAP passes 23 of 23, the probe and advisors are clean, and the types are regenerated.
6. **Done: `SlotStep`** (Claude, 10 tests in `src/__tests__/pages/slot-step.test.tsx` plus 4 in `src/__tests__/utils/time.test.ts`):
   - **`src/api/booking.ts` and `src/hooks/booking.ts`:** a client for the `booking` function (plain `fetch` with the publishable key and an `x-request-id`), a `BookingApiError` carrying our codes, and the hooks `useBookingSession`, `useAvailableDates`, `useAvailableTimes` and `useHold`.
   - **The session** is a TanStack *query*, not a mutation, so React's double render in dev starts it once. It's kept in sessionStorage per treatment and clinic, so a refresh reuses it. `SESSION_EXPIRED` clears it and starts a new one.
   - **Dates, then times.** Two weeks of days in the clinic's time zone. Times load only after the visitor picks a day. The day goes in the URL (`&date=`, using replace), and changing the treatment or clinic clears it.
   - **Retries:** `UNAVAILABLE` and `NETWORK` are retried twice. Other errors show the server's message, and `NOT_BOOKABLE` or "no openings" offer the call form.
   - **Holding a time** shows "Held for you … until …". On `SLOT_UNAVAILABLE` it shows the message and refetches the times. The "Continue" button stays disabled until step 4.
   - **`src/__tests__/helpers/fake-booking.ts`:** a fake of the booking function behind global `fetch`, used by the funnel tests.
   - **Browser check passed (2026-11-23) against the deployed function:**
     - two weeks of days, with Sundays missing
     - picking a day sets `&date=` and shows times in New York time
     - holding a time shows the card, which now says "for 30 minutes" instead of a clock time in the clinic's zone
     - when another session takes a time first, the browser shows "Time is no longer available, please select another." and the list drops that time
7. **Done: adapter and dependency-injection talking points are in INTERVIEW.md.**

## Step 4 (checkout, done)

**Decisions (2026-11-23):**
- **Split like step 3.** The user writes the server side (contract, adapter, handler, `index.ts`). Claude writes the migration, the mock's tokenize endpoint, the tests (first, so they define "done") and the UI, and reviews the user's code.
- **Card:** the browser posts the card straight to the vendor's Tokenization API and only the token reaches our function, so card data never touches our servers (PCI scope stays with Boulevard). Test card: `4242 4242 4242 4242`, any future expiry, any CVC.
- **Bookings row before and after checkout,** keyed by an idempotency key the browser generates. A retry never books twice, and a crash between the vendor confirming and our update leaves a `held` row for step 5's webhook to reconcile.
- **Stripe columns dropped** from `bookings`: Boulevard holds the card.
- **We store only the email** (already in `bookings`). Name and phone go to the vendor and nowhere else, logs included.

**Real Tokenization API (read 2026-11-23):** `POST https://pci.boulevard.app/cards/tokenize` (sandbox: `https://vault-sandbox.joinblvd.com`), body `{ card: { name, number, cvv, exp_month, exp_year, address_postal_code } }`, all required, returns `{ success: true, token: "<uuid>" }`. No bearer token. Failures aren't documented.

1. **Done: migration** `20261123123547_drop_bookings_stripe_columns.sql` (Claude). **Pushed 2026-11-23** (`npx supabase db push --remote`: CLI 3.x targets the local stack without `--remote`), types regenerated.
2. **Done: `POST /cards/tokenize` in the mock** (Claude). Checks the fields, the Luhn digit and the expiry, keeps nothing and returns a random UUID. The error shape `400 { success: false, error }` is mock-only. 3 tests, 2 smoke checks. **Deployed 2026-11-23**; `smoke-mock-boulevard.sh` passes 13 of 13.
3. **Done: contract** (user, reviewed), in `_shared/booking-provider.ts`:
   ```ts
   export type Hold = { start: string; expiresAt: string }; // UTC ISO, also what hold() returns
   export type Client = { firstName: string; lastName: string; email: string; phone?: string }; // phone in E.164
   summary(sessionId: string): Promise<{ vendorLocationId: string; vendorServiceId: string; hold: Hold | null }>;
   checkout(sessionId: string, client: Client, cardToken: string): Promise<{ confirmationId: string }>; // safe to retry
   ```
   `summary` lets our UI show the held time after a refresh, and lets the handler check the browser's claims against the vendor. `hold` is null when there's no live reservation. `confirmationId` is vendor-neutral and goes in `bookings.provider_booking_id`. Phone is optional until we know whether Great Many needs it for SMS reminders.
4. **Done: Boulevard adapter** (Claude, explained step by step), in `_shared/boulevard.ts`. All 19 adapter tests pass. `summary` requires exactly one selected item (`CART_ITEM_COUNT` otherwise). `checkout` first reads `completedAt`: a completed cart refuses changes, so a retry goes straight to `checkoutCart`, which returns the same appointment in the mock. **Confirm that on Boulevard's sandbox.**
   - `summary`: the `cart(id)` query for `location { id }`, `selectedItems { item { id } }`, `startTime` and `expiresAt`. Normalize times to UTC ISO like `hold` does.
   - `checkout`: `updateCart` (clientInformation) -> `addCartCardPaymentMethod` (token, `select: true`) -> `checkoutCart`. Return the first appointment's `appointmentId` as `confirmationId`. Send `phoneNumber` only when `phone` is set.
   - New entries in `ERROR_MAP`: `CART_MISSING_ITEM_TIME` is already SESSION_EXPIRED (the hold lapsed). `CART_MISSING_CLIENT_INFORMATION` and `CART_MISSING_ITEM_PAYMENT_METHOD` stay INVALID (our bug if they ever happen). A non-BlvdError GraphQL error on `updateCart` (bad phone) is MISCONFIGURED by the current rule, so validate the phone in the handler first.
5. **Done: handler and `index.ts`** (Claude, explained step by step). All 31 handler tests pass. `index.ts` has the Postgres bookings repo (`upsert` with `ignoreDuplicates` on `idempotency_key`, then a select; `expire` only touches `held` rows) and `resolve` returns our `treatmentId` and `locationId`. A reused key whose row is `expired` gets 409 SESSION_EXPIRED. **Deployed 2026-11-23.** Spec as written:
   - `summary` action: `{ action: "summary", sessionId }` -> `{ hold: { start, expiresAt } | null }` (no vendor ids to the browser).
   - `checkout` action: `{ action: "checkout", sessionId, location, service, idempotencyKey (uuid), client, cardToken }` -> `{ bookingId, start }`.
     1. Look up the row by `idempotencyKey`. If it's `confirmed`, return it without calling the vendor. If it's `held`, skip step 3 and go straight to checkout: a lost response may mean the vendor already booked, and then `summary` shows no live hold (`expiresAt` is null once checked out). `checkout` is safe to retry, so it gives the right answer either way.
     2. Resolve the slugs (extend `resolve` to also return our `treatmentId` and `locationId`), and check that the session's provider matches. A mismatch is 400 `INVALID_REQUEST`.
     3. Call `summary` and check that its location and service match the mapping, A mismatch is 400 `INVALID_REQUEST`. No live `hold` is 409 SESSION_EXPIRED, and no row gets written. We trust the vendor, not the browser. Use `hold.start` for `slot_start`.
     4. Insert a `held` row (email, treatment, location, `slot_start`, provider, idempotency key). If the key already exists, carry on.
     5. Call `checkout`. On success, set the row to `confirmed` with `provider_booking_id`. On SLOT_UNAVAILABLE or SESSION_EXPIRED, mark it `expired`. On UNAVAILABLE, leave it `held`, because we can't tell whether the vendor booked; the browser retries with the same key.
   - New dep, injected like `resolve`. Export these types from `handler.ts`, since the tests import them:
     ```ts
     export type Mapping = { provider; vendorLocationId; vendorServiceId; treatmentId: string; locationId: string }; // our ids added
     export type BookingRow = {
       id: string; idempotencyKey: string; status: "held" | "confirmed" | "cancelled" | "expired";
       email: string; treatmentId: string; locationId: string; slotStart: string; provider: string; providerBookingId: string | null;
     };
     export type BookingsRepo = {
       findByKey(key: string): Promise<BookingRow | null>;
       insertHeld(row: Omit<BookingRow, "id" | "status" | "providerBookingId">): Promise<BookingRow>; // returns the existing row if the key is taken
       confirm(id: string, providerBookingId: string): Promise<void>;
       expire(id: string): Promise<void>;
     };
     // Deps gains: bookings: BookingsRepo
     ```
     The real repo in `index.ts` uses the admin client, with `insert ... on conflict (idempotency_key) do nothing` and then a select. `resolve` also selects `treatments.id` and `locations.id`.
   - Zod: email, first and last name 1 to 100 characters each, optional phone `^\+[1-9]\d{6,14}$`, a UUID for the key, and a token 1 to 200 characters. Never log the `client` fields.
6. **Done: tests first** (Claude). 18 new tests fail until steps 4 and 5 are written. Two more pass early only because the handler rejects the unknown `checkout` action; they become real once it exists.
   - `_shared/boulevard.test.ts` (8): `summary` before a hold, during it and after it lapses. `checkout` books (checked by reading the mock's cart directly), works without a phone, is safe to retry, returns SESSION_EXPIRED on a lapsed hold, and never logs client data or the token. Operation names follow Boulevard's (`CheckoutCart`, ...).
   - `booking/handler.test.ts` (12, plus the 5-case `it.each`): `summary`, confirmed row contents, retry with the same key (no second `CheckoutCart`), a 503 on `CheckoutCart` leaving the row `held` and the retry completing it, a lapsed hold writing no row, a definitive refusal marking it `expired`, a tampered location and a cross-vendor mapping (400, no vendor call), the acme vendor, bad input (400, no vendor call), no phone, and no client data in logs.
   - Run them with `npx vitest run supabase/functions`.
7. **Done: UI** (Claude), 12 new tests (9 checkout, 3 phone).
   - `api/cards.ts`: `tokenizeCard` posts the card straight to the vendor's tokenizer (`VITE_CARD_TOKENIZE_URL`, defaulting to the mock). This is the one place the browser talks to the vendor, because PCI requires it. Card data never goes into a mutation's variables, the query cache, or our function.
   - `api/booking.ts` gains `summary` and `checkout`. `hooks/booking.ts` gains `useHoldSummary`, `useCheckout` and `useForgetBookingSession`.
   - **Idempotency key:** one per attempt, in sessionStorage (`booking-checkout:<sessionId>`). Checkout is the one mutation that retries on UNAVAILABLE or NETWORK, because the same key can't book twice. SLOT_UNAVAILABLE and SESSION_EXPIRED drop the key, so the next attempt gets a new one. Success drops the key and the session.
   - **Pages:**
     - `pages/booking/CheckoutStep.tsx`: the held time from `summary` (it survives a refresh), contact details (phone optional, typed US numbers become E.164 via `utils/phone.ts`), and the card form, with `autoComplete="off"` so a saved real card can't fill in.
     - `pages/booking/ConfirmedPage.tsx`: reads `?service&location&at`, with no personal data in the URL.
   - **Masked card fields** (`components/MaskedField.tsx`, formatters in `utils/card.ts`): digits only, as typed or pasted. The number is grouped by brand (Amex 4-6-5 with 15 digits, Diners 4-6-4 with 14, others 4-4-4-4 with 16; 19-digit cards aren't accepted). The expiry becomes `MM/YY`, with a leading zero for months 2 to 9, and the slash appears only once a year digit is typed, so backspace works. The CVC is 3 digits, or 4 on an Amex. The caret stays put when editing mid-field. The schema checks exact lengths and rejects an expired card. Checked in the browser.
   - `FUNNEL_STEPS` adds `checkout`, the slot step's Continue links to it, there's no back link on the confirmation, and `Field` moved to `components/`.
   - **Browser run passed (2026-11-23)** against the deployed functions: hold Thu Nov 26 at 1:00 PM, Continue, a reload keeps the hold, fill in the form with the test card, Book, then the confirmation, which survives a reload, with sessionStorage cleared. No console errors.
   - **Seen in that run:** the checkout call took about 10 s. It makes five vendor calls (summary, completedAt, updateCart, card, checkoutCart), each with the mock's random latency, plus any retries. Worth measuring against Boulevard's sandbox. Possible trims: drop the extra `completedAt` read on first attempts by passing whether the row is a retry, and show progress text while it runs.
8. **Server checks passed (2026-11-23):** `smoke-booking.sh` passes 19 of 19, now including summary, tokenize, checkout, a same-key retry returning the same booking, no live hold after checkout, and another clinic's slug refused. Each run writes one `confirmed` row with `smoke-test@example.com`. pgTAP passes 23 of 23, and the probe and advisors are clean. **Still to do:** the UI (item 7) and a browser run with the test card.

## Next: step 5 (Boulevard webhooks)

**Decisions (2026-11-23):**
- **Platform:** a Supabase edge function, `boulevard-webhook` (see Key decisions).
- **Who:** Claude, step by step with tests first, explaining each part (as with the adapter and handler).
- **Events acted on:** `APPOINTMENT_CREATED`, `APPOINTMENT_RESCHEDULED` and `APPOINTMENT_CANCELLED`. Other types are stored and acknowledged, nothing more.
- **n8n:** an optional forward (`AUTOMATIONS_WEBHOOK_URL`, unset by default), wired up in step 5b.

**Boulevard's webhook contract (read 2026-11-23, Admin API docs):**
- **Headers:** `x-blvd-oauth-hmac-salt` = `blvd-webhook-oauth-v1:<delivery id>:<unix timestamp>`, and `x-blvd-oauth-hmac-sha256` = Base64 HMAC-SHA256 of `salt + ":" + raw body`, keyed with the **Base64-decoded** client secret. Verify the raw bytes before parsing, and reject old timestamps.
- **Payload:** `{ idempotencyKey, eventType, event, resource, timestamp, webhookId, businessId, apiApplicationId, data: { node } }`. For appointments, `node` has `id`, `startAt`, `endAt`, `locationId`, `appointmentServices[].serviceId`, `client { email, firstName, ... }`, `cancellation` and `bookedByType`.
- **Delivery rules:** reply 2xx within 5 to 10 seconds, so store first, then process in the background. Retries default to 1 (maximum 10). A **410 disables the subscription immediately**, so never return it. Failing for 8 hours with 15 or more attempts also disables it. **429 doesn't count as a failure.** Events can arrive late, twice or out of order.
- **Setup:** webhooks are created per location with the Admin API's `createWebhook`, which sends a `PING` first. The mock will fake the sending side.

**Planned pieces:**
1. **Done: mock sends webhooks** (`mock-boulevard/webhooks.ts`, 9 tests). The first `checkoutCart` emits `APPOINTMENT_CREATED`; retries don't. `mockStaffRescheduleAppointment` and `mockStaffCancelAppointment` stand in for front desk staff and need a server token. Delivery goes to `MOCK_WEBHOOK_URL` (unset: none sent) in `EdgeRuntime.waitUntil`, signed like Boulevard, with a 10 s timeout, 1 retry, and a 410 that stops all further sends. The receiver's reply codes are the failure switch in tests. The Postgres store's new methods are only covered once deployed (smoke test).
2. **Done: `_shared/boulevard-signature.ts`** (7 tests). `signBoulevardWebhook` and `verifyBoulevardWebhook` use Web Crypto, a constant-time compare, the signature checked before the timestamp, and a 5-minute window. Expected values were computed with `openssl`, independently of our code, including the wrong-key trap (Base64 text instead of decoded bytes).
3. **Done: `boulevard-webhook` function** (`handler.ts`, 9 tests; `index.ts`; migration `20261123190833_record_webhook_attempt.sql`; `verify_jwt = false`). Order: verify the raw body, record in `webhook_events` (`event_id` = Boulevard's `idempotencyKey`, upsert with `ignoreDuplicates`), reply 200, then process in `EdgeRuntime.waitUntil`. Replies: 401 bad or stale signature, 400 signed but not JSON, 200 `IGNORED` for signed bodies without an event id (the setup `PING`), 200 `DUPLICATE` once processed, 500 only when recording fails, never 410. A redelivery of an unprocessed event runs it again. `processEvent` counts each try through the `record_webhook_attempt` SQL function (`attempts + 1` in one statement, `processed_at` on success, `last_error` otherwise; execute granted to `service_role` only), and the retry job in piece 5 reuses it. One test sends through the mock's real sender, proving both sides agree on the wire format. To do before deploy: `db push --remote` for the migration, a pgTAP check that `anon`/`authenticated` can't execute the function, then deploy the function and set `MOCK_WEBHOOK_URL` on the mock.
4. **Done: processing** (decided 2026-11-23). `_shared/boulevard-events.ts` (5 tests, against the mock's real payloads) is the only code that reads Boulevard's payload: it returns a vendor-neutral `AppointmentChange { kind, vendorAppointmentId, vendorLocationId, start, email, occurredAt }` (times in UTC), `null` for types we don't act on, and throws on a malformed payload of a type we do (issue paths only, no values). `boulevard-webhook/process.ts` (12 tests) applies it:
   - **created:** a row found by `provider_booking_id` is confirmed only if still `held` (usually checkout confirmed it already; cancelled or expired rows are never revived). With no such row, a `held` row with the same location, start and email (case-insensitive) is a lost checkout response and gets confirmed. Otherwise it was booked outside the funnel: nothing changes (recorded for Segment in step 7).
   - **rescheduled:** moves `slot_start`, unless the row is cancelled or the event is older than `vendor_updated_at` ("stale").
   - **cancelled:** final, so it applies even when older; `vendor_updated_at` keeps the newest time.
   - **Unknown appointment** on a reschedule or cancel: throws, so it's retried until the cap (user's choice over a grace window). This dead-letters reschedules and cancels of bookings made outside the funnel; the retry job should treat those dead letters as expected, not alarming. A cheap refinement, if wanted: skip once a CREATED for that appointment id was processed as "not ours".
   - New column `bookings.vendor_updated_at` (migration `20261123215634_bookings_vendor_updated_at.sql`). The Postgres updates in `index.ts` repeat the checks in their `where` clause (status, and the timestamp for reschedules), so concurrent deliveries can't overwrite each other. `findHeld` maps the vendor location through `location_provider_mappings` and escapes `%` and `_` for `ilike`.
   - **Before deploy:** `db push --remote` for both migrations, then `npm run db:types`. The Postgres repo is only covered once deployed (smoke test in piece 7).
5. **Done: retries, reconciliation, silence check** (decided 2026-11-24: simplest version of each, as a demo; separate function; reconciliation with a stored vendor session; alerts as logs, n8n in 5b). New function `webhook-jobs` (`handler.ts`, 9 tests; `store.ts`; `index.ts`; `verify_jwt = false`), called every 5 minutes by `pg_cron` through `pg_net` with an `x-cron-secret` header. It replies 202 at once and works in `EdgeRuntime.waitUntil`, because pg_net times out after a few seconds. Each job is guarded on its own:
   - **Retry:** unprocessed events older than 2 minutes and under 10 attempts, 50 per run, through the receiver's `processEvent`. Dead letters are logged as an error, except those that only wait for a CREATED (`UNKNOWN_APPOINTMENT`, the expected end for phone bookings), which are logged as info.
   - **Reconcile:** held bookings older than 45 minutes (holds last 30) are checked with the new provider method `checkoutStatus` (Boulevard: `CartCompletedAt`, then `checkoutCart` on a completed cart, which returns its appointment without booking anything). Booked means confirmed with that appointment id; not booked means expired. A vendor error leaves the row held for the next run. Checkout now stores `bookings.provider_session_id` (the cart id).
   - **Silence:** bookings confirmed between 60 and 10 minutes ago, but no webhook in the last hour, logs an error. This catches a subscription Boulevard disabled without false alarms when nobody books.
   - **Migration** `20261124174813_webhook_jobs_schedule.sql`: `pg_cron` (schema `pg_catalog`), `pg_net` (schema `extensions`), `bookings.provider_session_id`, a partial index on held rows, and `cron.schedule('webhook-jobs', '*/5 * * * *', ...)`. The URL and secret come from Vault at run time (`project_url`, `webhook_jobs_secret`); the function reads the same secret from `WEBHOOK_JOBS_SECRET`. A dedicated secret instead of the project key, since pg_net keeps headers in `net.http_request_queue` until sent.
   - **Refactor:** the receiver's Postgres repos moved to `boulevard-webhook/store.ts` so both functions share them (now typechecked too); `processEvent` needs only `recordAttempt`.
   - **Trade-offs of the simple version (interview talking points):** no backoff, so a broken dependency is hit every 5 minutes for about 50 minutes; a fixed cap instead of per-error rules; batch limits without locking, so two overlapping runs could process the same event twice (safe, since processing is idempotent, but wasted work; production would use `for update skip locked` or a queue like `pgmq`); alerts are log lines nobody is paged for; the silence window is tuned for a busy clinic chain and too coarse for low traffic; `cron.job_run_details` and `net._http_response` grow and need cleanup; reconciliation only covers held rows, not confirmed bookings changed in Boulevard while every webhook was lost.
   - **Before deploy:** create both Vault secrets, `supabase secrets set WEBHOOK_JOBS_SECRET=...`, `db push --remote`, `npm run db:types`, deploy `booking`, `boulevard-webhook` and `webhook-jobs`. Check runs in `cron.job_run_details`.
6. **Done: forward to automations** (decided 2026-11-25: every booking change from every path; one try, failures only logged; alerts through the same sender). `_shared/automations.ts` (4 tests): `createAutomations({ url, secret })` returns `send(event, log)`, one POST with `x-automations-secret` and a 5 s timeout, adding `id` (for dedup in the workflow) and `sentAt`. It never throws, and does nothing when `AUTOMATIONS_WEBHOOK_URL` is unset (a URL without `AUTOMATIONS_SECRET` fails at startup). Events carry ids, our slugs and UTC times only, never client data or vendor ids:
   - `booking.confirmed` from checkout (first confirmation only, sent in `waitUntil` so checkout never waits), from webhook processing (lost-response case) and from reconciliation
   - `booking.rescheduled` and `booking.cancelled` from webhook processing, only when it changed a row (not for "unchanged", "stale", "not ours" or redeliveries); `describe(id)` reads the slugs and current start
   - `alert.dead_letters` (real failures only) and `alert.webhooks_silent` from `webhook-jobs`; they repeat every run while the problem lasts, and the workflow decides how often to notify
   - **Trade-off:** an automation can miss an event (n8n down, tunnel closed), and event retries can't resend it because re-processing changes nothing. Production answer: an outbox table written with the change, delivered and retried by a job.
7. **Done: checks.** Unit and contract tests cover every piece (206 Vitest tests). New for deploy:
   - **`supabase/tests/webhooks.test.sql`** (pgTAP, 14 checks, runs with `npm run db:test`): the new columns and index; `record_webhook_attempt` refused for `anon` and `authenticated`, counting failed and successful tries for `service_role`, with an empty `search_path`; `pg_cron` and `pg_net` enabled; the `webhook-jobs` job every 5 minutes, owned by `postgres`, reading its secret from Vault; and both Vault secrets present (fails until deploy step 2).
   - **`scripts/smoke-webhooks.sh`**: books through `booking`, waits for the CREATED webhook to be recorded and processed once, has "staff" reschedule then cancel in the mock and checks the booking follows (new `slot_start`, `vendor_updated_at` set, then `cancelled`), and checks an unsigned delivery and a call without the cron secret get 401. Rows are read with `supabase db query --remote --read-only` (no prompt). Queries were dry-run against the hosted database before deploy.
   - **Fix found while writing the runbook:** pg_cron runs a job as the role that scheduled it, and the CLI may connect as a temporary login role, so the migration schedules under `set role postgres` and pgTAP asserts the owner.
   - Not covered end to end: reconciliation and the retry job (they need a lost response or a failing database); unit tests cover them, and `cron.job_run_details` shows the schedule running.

### Step 5 deploy runbook (in this order)
**Deployed 2026-11-25:** migrations pushed (cron job owned by `postgres`), the four functions deployed (two retried after a Management API 502), pgTAP 37/37, smoke tests booking 19/19, mock 13/13, webhooks 14/14, and the cron's 08:10 UTC run got `202 STARTED`. Afterwards: 5 Boulevard events, all processed, no dead letters, no held bookings.

1. **Database:** `npm run db:push` (three migrations: `record_webhook_attempt`, `bookings_vendor_updated_at`, `webhook_jobs_schedule`), then `npm run db:types`.
2. **Secrets, from one value so they can't differ** (lesson from the first deploy: a paste mismatch gave the cron 401s). In a terminal, from the project folder:
   `S=$(openssl rand -hex 32) && printf %s "$S" | pbcopy && npx supabase secrets set WEBHOOK_JOBS_SECRET="$S"; unset S`
   Then in the SQL editor, pasting over the whole `<paste>`: `select vault.create_secret('<paste>', 'webhook_jobs_secret');` (or `vault.update_secret((select id from vault.secrets where name = 'webhook_jobs_secret'), '<paste>')` to replace it), plus `select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');`. Clear the clipboard after.
3. **Mock webhook target:** `npx supabase secrets set MOCK_WEBHOOK_URL=https://<project-ref>.supabase.co/functions/v1/boulevard-webhook`. `BOULEVARD_*` are already set for `booking`. `AUTOMATIONS_*` stay unset until step 5b.
4. **Functions:** `npx supabase functions deploy booking`, then `mock-boulevard`, `boulevard-webhook`, `webhook-jobs` (`verify_jwt = false` comes from `config.toml`).
5. **Checks:** `npm run db:test` (both pgTAP files), then `bash scripts/smoke-booking.sh`, `bash scripts/smoke-mock-boulevard.sh` and `bash scripts/smoke-webhooks.sh`.
6. **After 5 minutes,** confirm the schedule runs: `select status, return_message, start_time from cron.job_run_details order by start_time desc limit 5;` and `select status_code, timed_out, error_msg, created from net._http_response order by created desc limit 5;` (expect `succeeded` and `202`), and the function logs show "jobs finished".

## Step 5b (n8n, self-hosted): done 2026-11-27

**Result:** a real chain works end to end. `smoke-webhooks.sh` books, the mock's "staff" reschedule then cancel, and n8n shows three runs (confirmed, rescheduled, cancelled); the cancellation becomes a message in the clinic's local time, using the rescheduled start. The workflow is in `automations/n8n/booking-events.json` (no secret, no tunnel URL, owner block removed) with an import guide in `automations/n8n/README.md`.

**Decisions:** quick tunnel (no domain to buy; the named tunnel plus Cloudflare Access is the production answer, in INTERVIEW.md), self-hosted rather than n8n Cloud (free, no trial clock, the setup was the point), and no external notifier: messages are read in the Executions list (swap in Slack or Discord with one node).

**Restart routine** (the quick tunnel URL changes every time):
1. Start Docker Desktop.
2. Tab A: `cloudflared tunnel --url http://localhost:5678`, then copy the new URL.
3. Tab B: `docker run -it --rm --name n8n -p 5678:5678 -v n8n_data:/home/node/.n8n -e WEBHOOK_URL=<url>/ -e N8N_PROXY_HOPS=1 -e GENERIC_TIMEZONE=America/New_York docker.n8n.io/n8nio/n8n`
4. `npx supabase secrets set AUTOMATIONS_WEBHOOK_URL=<url>/webhook/booking-events`. Until then, events are logged as "automation not delivered" and lost (by design: one try).

**Lessons from the setup:**
- Keep shared secrets in a file (`AUTOMATIONS_SECRET` in the ignored `supabase/functions/.env`), not the clipboard: copying a command afterwards replaced the secret, and n8n answered "Authorization data is wrong!".
- Test URLs (`/webhook-test/`) take one call per "Execute workflow" click; production URLs (`/webhook/`) need the workflow active and log runs under Executions.
- A 404 after the auth fix meant "not listening", not "wrong secret": auth passed.

### Original plan

**Goal:** learn n8n by running it locally and building one real ops flow on top of step 5's forward.

1. **Run n8n in Docker** (the data survives restarts in a volume):
   ```bash
   docker run -it --rm --name n8n -p 5678:5678 -v n8n_data:/home/node/.n8n docker.n8n.io/n8nio/n8n
   ```
   Open http://localhost:5678 and create the owner account. It's local and the credentials stay on your machine.
2. **Expose it** so the hosted edge function can reach it. A Cloudflare quick tunnel needs no account (`brew install cloudflared`), and it's a small, real use of Cloudflare:
   ```bash
   cloudflared tunnel --url http://localhost:5678
   ```
   It prints a random `https://<name>.trycloudflare.com` URL, which changes on every run. Restart n8n with `-e WEBHOOK_URL=<that url>` so its webhook nodes show the public address.
3. **Build the flow:** Webhook trigger (POST, Header Auth credential: header `x-automations-secret`, value = `AUTOMATIONS_SECRET`) → IF `type` is `booking.cancelled` → notify. Slack incoming webhook if you have a workspace; otherwise Discord, email, or just n8n's execution log. Use the test URL first, then activate it and use the production URL.
4. **Point step 5 at it:** `supabase secrets set AUTOMATIONS_WEBHOOK_URL=... AUTOMATIONS_SECRET=...`. Cancel an appointment through the mock and watch the execution in n8n.
5. **Version control:** export the workflow JSON into `automations/n8n/` (`docker exec n8n n8n export:workflow --all --output=/home/node/.n8n/export` or download it from the UI). Credentials are referenced, not included. Commit it.
6. **Production notes for the interview:** Postgres instead of the default SQLite, a fixed `N8N_ENCRYPTION_KEY`, queue mode with workers to scale, git-backed workflows, an error workflow that alerts, an owner per workflow, and n8n Cloud vs self-hosting trade-offs. See INTERVIEW.md, "n8n: what to know".

## Next: step 6 (auth and My bookings)

**Decisions (2026-11-27):**
- **Linking, both ways, server only:** checkout sets `user_id` when the request carries a valid user token (verified with `auth.getUser`; a bad token is a 401, never a silent guest). A `claim` action on `booking` links rows with no `user_id` whose email matches the user's **verified** email (case-insensitive, `ilike` wildcards escaped). My bookings calls it on load, so it's idempotent.
- **Sign-in is optional:** booking stays guest-friendly. Header link, plus "See it in My bookings" on the confirmation page with the email prefilled through router state (never in the URL).
- **6-digit email code** (`signInWithOtp` then `verifyOtp` with `type: "email"`), not a magic link: works across devices and needs no redirect allow list. Needs `{{ .Token }}` in the hosted project's Magic Link email template (dashboard, user). Default SMTP only sends to the project team's emails, with a low hourly limit: fine for the demo.
- **My bookings reads through RLS** (the existing "Users read their own bookings" policy): confirmed and cancelled rows with treatment, clinic and local time, split into upcoming and past. `next` after sign-in only accepts in-app paths (no open redirect).
- **Who:** Claude writes it all, step by step.

**Implementation steps** (each leaves the app working; gate after each: `npm run lint`, `npm run typecheck`, `npm test`, plus the step's own tests):
0. **Baseline:** record lint, typecheck, test and build results.
1. **Done: server identity and linking** (baseline was 206 tests, lint and typechecks clean, build 613 kB; now 214 tests). `currentUser` in the handler: no bearer or the publishable key = guest, a token Auth rejects = 401 `SIGN_IN_AGAIN`. Only checkout and `claim` call it. `claim` answers 401 `SIGN_IN_REQUIRED` signed out and 403 `EMAIL_NOT_VERIFIED`; `claimByEmail` updates only `user_id is null` rows. `index.ts` uses `admin.auth.getUser(token)` (checks revocation, unlike decoding the JWT). The `ilike` escaper moved to `_shared/sql.ts` with tests, shared with the webhook store. Original scope: a `users.fromToken` dependency, checkout saves `userId`, the `claim` action, the Postgres `claimByEmail`. Tests: signed-in checkout links, a guest stays null, a bad token is 401, claim needs a verified email, claims only unclaimed matching rows, and is repeatable.
2. **Frontend auth** (`api/auth.ts`, `hooks/auth.ts`, `pages/SignInPage.tsx`, header link, `api/booking.ts` sends the access token): tests for both sign-in steps, wrong code, safe `next`.
3. **My bookings** (`api/myBookings.ts`, hook, `pages/MyBookingsPage.tsx`, signed-in-only route): tests for claim then list, upcoming vs past, empty state, signed-out redirect.
4. **Confirmation page link** with the email in router state: test.
5. **Deploy and dashboard** (user): Magic Link template gets `{{ .Token }}`, deploy `booking`, then a manual browser run: book as a guest, sign in with the code, see it in My bookings; book while signed in.
6. **Final gates:** all Checks above, `npm run build`, and INTERVIEW.md notes (linking by verified email, why not a policy on email, OTP vs magic link).

## Open items and later
- **Move to a local Supabase stack** (`supabase start`) and seed data to `seed.sql`. That includes the vendor mappings, which differ per environment (sandbox vs production Boulevard ids).
- **Offer:** add `--yes` to the `db:test` script only, if the user wants it.
- **Decide whether to keep `utm_*` params through the funnel** for attribution (step 7).
- **Bundle size** (~600 kB, mostly supabase-js): code-split later.
- **Optional:** column-level grants on `bookings`, and a `user_id` with an `auth.uid()` check on `consult_requests`.
- **Retention:** a job to clear `webhook_events.payload` after processing (it contains personal data).
- **In CI,** use a scoped Supabase access token, not the full-account token from `supabase login`.
