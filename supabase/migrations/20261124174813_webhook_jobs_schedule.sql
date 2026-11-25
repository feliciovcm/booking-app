-- Step 5, piece 5: the scheduled webhook jobs (retry, reconcile, silence check).
--
-- pg_cron runs a job every 5 minutes. The job uses pg_net to POST to the webhook-jobs
-- edge function, which does the work in TypeScript. Both values it needs come from
-- Vault at run time, so no secret is in this file or in git. Create them once (SQL editor):
--
--   select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
--   select vault.create_secret('<random secret>', 'webhook_jobs_secret');
--
-- and give the function the same secret: supabase secrets set WEBHOOK_JOBS_SECRET=<random secret>
-- A dedicated secret, not the project's secret key: pg_net keeps header values in
-- net.http_request_queue until sent, and this one can only start these jobs.
--
-- Inspect runs:     select * from cron.job_run_details order by start_time desc limit 10;
-- Inspect replies:  select * from net._http_response order by created desc limit 10;

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

-- Reconciliation asks the vendor how this session ended, so keep its id (Boulevard: the cart).
alter table public.bookings add column provider_session_id text;

-- Reconciliation looks for old held bookings. Partial: held rows are few and short-lived.
create index bookings_held_created_at_idx on public.bookings (created_at) where status = 'held';

-- pg_cron runs a job as the role that scheduled it. Against a hosted project the CLI may
-- connect as a temporary login role, so schedule as postgres (the login role is a member).
set role postgres;

-- The function replies 202 before working, so a short timeout is enough.
select cron.schedule(
  'webhook-jobs',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/webhook-jobs',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'webhook_jobs_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 5000
  );
  $$
);

reset role;
