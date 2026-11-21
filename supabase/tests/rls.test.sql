-- RLS tests. Run: npm run db:test   (npx supabase test db --linked)
-- One transaction, rolled back at the end: it never leaves data behind.
--
-- Two kinds of refusal, both SQLSTATE 42501:
--   no grant  -> "permission denied for table ..."
--   no policy -> "new row violates row-level security policy" (writes) or zero rows (reads)
begin;
create extension if not exists pgtap with schema extensions;

-- Against a hosted project (--linked) the CLI connects as a temporary role, cli_login_postgres.
-- That role can't use the extensions schema (where pgTAP lives), but it is a member of postgres.
-- So act as postgres, and switch back to postgres (not `reset role`) after each impersonation.
set local role postgres;
-- pgTAP functions are called without a schema prefix, so its schema must be on search_path.
set local search_path = "$user", public, extensions;

select plan(22);

-- ------------------------------------------------------------
-- Setup, as postgres (table owner, bypasses RLS). Fixed ids keep assertions readable.
-- ------------------------------------------------------------
insert into auth.users (id, email) values
  ('a1111111-1111-1111-1111-111111111111', 'alice@test.dev'),
  ('b2222222-2222-2222-2222-222222222222', 'bob@test.dev');

insert into public.treatments (id, slug, name, price_cents, active) values
  ('10000000-0000-0000-0000-000000000001', 'test-active', 'Test Active', 100, true),
  ('10000000-0000-0000-0000-000000000002', 'test-hidden', 'Test Hidden', 100, false);

insert into public.locations (id, slug, name, address, timezone, active) values
  ('20000000-0000-0000-0000-000000000001', 'test-loc',        'Test Loc',   'x', 'America/New_York', true),
  ('20000000-0000-0000-0000-000000000002', 'test-loc-hidden', 'Hidden Loc', 'x', 'America/New_York', false);

insert into public.location_provider_mappings (location_id, provider, provider_location_id)
values ('20000000-0000-0000-0000-000000000001', 'mock-scheduler', 'loc_test');

insert into public.bookings (id, user_id, email, treatment_id, location_id, slot_start, provider, idempotency_key) values
  ('30000000-0000-0000-0000-00000000000a', 'a1111111-1111-1111-1111-111111111111', 'alice@test.dev',
   '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', now() + interval '1 day', 'mock-scheduler', 'key-alice'),
  ('30000000-0000-0000-0000-00000000000b', 'b2222222-2222-2222-2222-222222222222', 'bob@test.dev',
   '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', now() + interval '2 days', 'mock-scheduler', 'key-bob'),
  ('30000000-0000-0000-0000-00000000000c', null, 'guest@test.dev',
   '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', now() + interval '3 days', 'mock-scheduler', 'key-guest');

insert into public.webhook_events (provider, event_id, type, payload)
values ('stripe', 'evt_test', 'setup_intent.succeeded', '{}');

-- ============================================================
-- anon (logged-out visitor)
-- ============================================================
set local role anon;

-- Public config: active rows only
select results_eq(
  $$ select count(*)::int from public.treatments where slug = 'test-active' $$, $$ values (1) $$,
  'anon reads active treatments');
select results_eq(
  $$ select count(*)::int from public.treatments where slug = 'test-hidden' $$, $$ values (0) $$,
  'anon cannot see inactive treatments');
select results_eq(
  $$ select count(*)::int from public.locations where slug = 'test-loc-hidden' $$, $$ values (0) $$,
  'anon cannot see inactive locations');

-- Public config is read-only (no write grants)
select throws_ok(
  $$ insert into public.treatments (slug, name, price_cents) values ('evil', 'Evil', 1) $$, '42501', null,
  'anon cannot insert treatments');
select throws_ok(
  $$ update public.treatments set price_cents = 0 $$, '42501', null,
  'anon cannot update treatments');
select throws_ok(
  $$ delete from public.treatments $$, '42501', null,
  'anon cannot delete treatments');

-- Private and internal tables: no grant, so even reading is refused
select throws_ok(
  $$ select * from public.location_provider_mappings $$, '42501', null,
  'anon cannot read location_provider_mappings');
select throws_ok(
  $$ select * from public.bookings $$, '42501', null,
  'anon cannot read bookings');
select throws_ok(
  $$ select * from public.webhook_events $$, '42501', null,
  'anon cannot read webhook_events');

-- consult_requests: insert only, validated by constraints
select lives_ok(
  $$ insert into public.consult_requests (full_name, phone) values ('Anon Visitor', '5555550100') $$,
  'anon can submit a valid consult request');
select throws_ok(
  $$ insert into public.consult_requests (full_name, phone) values (repeat('x', 500), '5555550100') $$, '23514', null,
  'anon cannot submit an oversized full_name (check constraint)');
select throws_ok(
  $$ select * from public.consult_requests $$, '42501', null,
  'anon cannot read consult requests');
-- The .insert().select() gotcha: RETURNING needs select rights, so the whole insert fails
select throws_ok(
  $$ insert into public.consult_requests (full_name, phone) values ('Anon', '5555550100') returning id $$, '42501', null,
  'insert ... returning on consult_requests is refused');

set local role postgres;  -- back to the owner (reset role would return to the CLI login role)

-- ============================================================
-- alice (signed in)
-- ============================================================
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"a1111111-1111-1111-1111-111111111111","role":"authenticated"}', true);

select results_eq(
  $$ select id from public.bookings $$,
  $$ values ('30000000-0000-0000-0000-00000000000a'::uuid) $$,
  'alice sees exactly her own booking (not bob''s, not the guest''s)');
select results_eq(
  $$ select count(*)::int from public.bookings where id = '30000000-0000-0000-0000-00000000000b' $$, $$ values (0) $$,
  'alice cannot see bob''s booking even by id');
select throws_ok(
  $$ update public.bookings set status = 'confirmed' where id = '30000000-0000-0000-0000-00000000000a' $$, '42501', null,
  'alice cannot update her own booking (changes go through edge functions)');
select throws_ok(
  $$ insert into public.bookings (email, treatment_id, location_id, slot_start, provider, idempotency_key)
     values ('alice@test.dev', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001',
             now(), 'mock-scheduler', 'key-evil') $$, '42501', null,
  'alice cannot insert bookings');
-- Catches the classic "policy only for anon" bug: logged-in users must still see public config
select results_eq(
  $$ select count(*)::int from public.treatments where slug = 'test-active' $$, $$ values (1) $$,
  'signed-in users still read active treatments');
select lives_ok(
  $$ insert into public.consult_requests (full_name, phone) values ('Alice', '5555550101') $$,
  'signed-in users can submit a consult request');

-- ============================================================
-- bob (signed in)
-- ============================================================
select set_config('request.jwt.claims',
  '{"sub":"b2222222-2222-2222-2222-222222222222","role":"authenticated"}', true);

select results_eq(
  $$ select id from public.bookings $$,
  $$ values ('30000000-0000-0000-0000-00000000000b'::uuid) $$,
  'bob sees exactly his own booking');

set local role postgres;  -- back to the owner (reset role would return to the CLI login role)

-- ============================================================
-- service_role (edge functions)
-- ============================================================
set local role service_role;

select results_eq(
  $$ select count(*)::int from public.location_provider_mappings where provider_location_id = 'loc_test' $$, $$ values (1) $$,
  'service_role reads internal tables (grant present, RLS bypassed)');

set local role postgres;  -- back to the owner (reset role would return to the CLI login role)

-- ============================================================
-- Guard: no table in the exposed schema may have RLS off
-- ============================================================
select is_empty(
  $$ select tablename from pg_tables where schemaname = 'public' and not rowsecurity $$,
  'every public table has RLS enabled');

select * from finish();
rollback;
