-- Step 5 (webhooks) database checks. Run with the other tests: npm run db:test
-- One transaction, rolled back at the end: it never leaves data behind.
-- Same setup as rls.test.sql: act as postgres, pgTAP on the search_path.
begin;
create extension if not exists pgtap with schema extensions;
set local role postgres;
set local search_path = "$user", public, extensions;

select plan(14);

-- ------------------------------------------------------------
-- Schema added by step 5
-- ------------------------------------------------------------
select has_column('public', 'bookings', 'vendor_updated_at', 'bookings keeps the time of the latest vendor change applied');
select has_column('public', 'bookings', 'provider_session_id', 'bookings keeps the vendor session, for reconciliation');
select has_index('public', 'bookings', 'bookings_held_created_at_idx', 'reconciliation''s held-row lookup is indexed');

-- ------------------------------------------------------------
-- record_webhook_attempt: server only, and counts in one statement
-- ------------------------------------------------------------
insert into public.webhook_events (provider, event_id, type, payload)
values ('boulevard', 'evt_pgtap', 'APPOINTMENT_CANCELLED', '{}');

set local role anon;
select throws_ok(
  $$ select public.record_webhook_attempt('boulevard', 'evt_pgtap', null) $$, '42501', null,
  'anon cannot execute record_webhook_attempt');
set local role postgres;  -- back to the owner (reset role would return to the CLI login role)

set local role authenticated;
select throws_ok(
  $$ select public.record_webhook_attempt('boulevard', 'evt_pgtap', null) $$, '42501', null,
  'authenticated cannot execute record_webhook_attempt');
set local role postgres;

set local role service_role;
select lives_ok(
  $$ select public.record_webhook_attempt('boulevard', 'evt_pgtap', 'bookings table unreachable') $$,
  'service_role records a failed try');
select results_eq(
  $$ select attempts, last_error, processed_at is null from public.webhook_events where event_id = 'evt_pgtap' $$,
  $$ values (1, 'bookings table unreachable', true) $$,
  'a failed try counts, keeps the reason, and leaves the event unprocessed');
select lives_ok(
  $$ select public.record_webhook_attempt('boulevard', 'evt_pgtap') $$,
  'service_role records a successful try (error defaults to null)');
select results_eq(
  $$ select attempts, last_error, processed_at is not null from public.webhook_events where event_id = 'evt_pgtap' $$,
  $$ values (2, null::text, true) $$,
  'a successful try counts, clears the error, and marks it processed');
set local role postgres;

select is(
  (select proconfig from pg_proc where proname = 'record_webhook_attempt'),
  array['search_path=""'],
  'record_webhook_attempt pins an empty search_path');

-- ------------------------------------------------------------
-- The schedule (pg_cron + pg_net + Vault)
-- ------------------------------------------------------------
select ok(
  (select count(*) = 2 from pg_extension where extname in ('pg_cron', 'pg_net')),
  'pg_cron and pg_net are enabled');
select results_eq(
  $$ select schedule, active, username from cron.job where jobname = 'webhook-jobs' $$,
  $$ values ('*/5 * * * *'::text, true, 'postgres'::text) $$,
  'webhook-jobs runs every 5 minutes as postgres (not the CLI''s temporary login role)');
select ok(
  (select command like '%from vault.decrypted_secrets where name = ''webhook_jobs_secret''%' from cron.job where jobname = 'webhook-jobs'),
  'the scheduled command reads its secret from Vault, so none is stored in cron.job');

-- A deploy step, not a migration: fails until both secrets exist (see the cron migration).
select results_eq(
  $$ select count(*)::int from vault.decrypted_secrets where name in ('project_url', 'webhook_jobs_secret') $$,
  $$ values (2) $$,
  'Vault holds project_url and webhook_jobs_secret (deploy setup)');

select * from finish();
rollback;
