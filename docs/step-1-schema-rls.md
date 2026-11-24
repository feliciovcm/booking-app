# Step 1: Schema and Row Level Security

**Goal:** the database is safe to expose to the browser with the public (anon) key.
You write the schema, the policies and the pgTAP tests. Claude reviews and runs an attacker probe.

## Files

| File | Who | What |
|---|---|---|
| `supabase/migrations/*_step1_schema_and_rls.sql` | You | Tables, constraints, RLS, policies. `treatments` is done as a worked example. |
| `supabase/migrations/*_step1_seed_demo_data.sql` | Claude | Demo rows. Runs after your migration, so it only works if your column names match the spec below. |
| `supabase/tests/rls.test.sql` | You | pgTAP tests, one example written. |
| `scripts/probe-rls.mjs` | Claude | Calls the real REST API with the anon key, like an attacker would. |

## Tables

Column names matter: the seed and the probe use them.

### `treatments` (public config, done for you)
`id, slug, name, description, price_cents, session_count, active, sort_order`

### `locations` (public config)
| Column | Type | Notes |
|---|---|---|
| id | uuid | PK, default `gen_random_uuid()` |
| slug | text | unique, not null (`noho`, `atlanta`) |
| name | text | not null |
| address | text | not null |
| timezone | text | not null, IANA name (`America/New_York`) |
| active | boolean | not null, default true |

### `location_provider_mappings` (internal)
Maps our location to the scheduling vendor's ID. Great Many has a table like this.
| Column | Type | Notes |
|---|---|---|
| location_id | uuid | PK, FK to `locations(id)` on delete cascade |
| provider | text | not null (`mock-scheduler`) |
| provider_location_id | text | not null |
|  |  | unique `(provider, provider_location_id)` |

### `bookings` (private, per user)
| Column | Type | Notes |
|---|---|---|
| id | uuid | PK |
| user_id | uuid | **nullable** (guest checkout), FK `auth.users(id)` on delete set null |
| email | text | not null |
| treatment_id | uuid | FK, not null |
| location_id | uuid | FK, not null |
| slot_start | timestamptz | not null |
| status | text | not null, default `'held'`, check in `held, confirmed, cancelled, expired` |
| provider | text | not null, which vendor holds this booking (`mock-scheduler`); keeps old bookings valid if the location switches vendor |
| provider_booking_id | text | nullable |
| stripe_customer_id | text | nullable |
| stripe_setup_intent_id | text | nullable, unique |
| idempotency_key | text | not null, unique |
| created_at / updated_at | timestamptz | not null, default `now()` |

### `webhook_events` (internal)
| Column | Type | Notes |
|---|---|---|
| provider | text | not null |
| event_id | text | not null |
| type | text | not null |
| payload | jsonb | not null |
| received_at | timestamptz | not null, default `now()` |
| processed_at | timestamptz | nullable (fixes the "lost work on retry" bug from the lab) |
|  |  | PK `(provider, event_id)` |

### `consult_requests` (the "Free phone consult" form)
| Column | Type | Notes |
|---|---|---|
| id | uuid | PK |
| full_name | text | not null, 1 to 100 chars |
| phone | text | not null, 7 to 20 chars |
| email | text | nullable, max 254 chars |
| message | text | nullable, max 1000 chars |
| created_at | timestamptz | not null, default `now()` |

## Access rules (what your policies must enforce)

| Table | anon | authenticated | Server (service role) |
|---|---|---|---|
| treatments | read active rows | read active rows | everything |
| locations | read active rows | read active rows | everything |
| location_provider_mappings | nothing | nothing | everything |
| bookings | nothing | read **own** rows only | everything |
| webhook_events | nothing | nothing | everything |
| consult_requests | insert only (valid rows) | insert only (valid rows) | everything |

Nobody on the client writes to bookings: the `create-booking` edge function does that in step 4.

## Hints
- Access has two layers. **Grants** decide whether a role can touch a table at all. **RLS policies** decide which rows. A role needs both.
- Your project settings auto-grant and auto-enable RLS on new tables. Write both explicitly anyway, like the `treatments` example: migrations must not depend on dashboard settings, and newer Supabase projects don't auto-grant.
- Least privilege: `revoke all` from `anon, authenticated`, then grant only what the access table needs (`select`, or just `insert` for the form). Internal tables get no client grants at all. Then the API returns "permission denied" instead of an empty list, and a future bad policy can't leak them.
- `service_role` bypasses RLS but **still needs grants**. Give it `all` on every table, or the edge functions in later steps will fail.
- "Nothing" needs **no policy**. Deny is the default.
- Put validation in `check` constraints, not only in the policy. Constraints apply to every role, including the service role.
- Use `(select auth.uid())` in policies, and index the column the policy filters on.
- Insert-only means no select policy. Think about what that means for `insert ... returning` (and `.insert().select()` in supabase-js).

## Checks, in order
1. `npx supabase db push --linked --dry-run`, then `npx supabase db push --linked`
2. `npx supabase test db --linked` passes
3. `npm run probe:rls` prints no `FAIL`
