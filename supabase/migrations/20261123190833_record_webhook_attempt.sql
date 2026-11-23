-- Counts one processing try of a webhook event in a single statement.
-- supabase-js can't express "attempts = attempts + 1"; reading then writing would lose a
-- count when two deliveries of the same event are processed at once.
--
-- p_error null = it worked: mark processed and clear the last error.
-- Otherwise keep the error (our own message, no personal data) and leave it unprocessed,
-- so a redelivery or the retry job runs it again.
create function public.record_webhook_attempt(p_provider text, p_event_id text, p_error text default null)
returns void
language sql
security invoker
set search_path = ''
as $$
  update public.webhook_events
  set attempts = attempts + 1,
      last_error = p_error,
      processed_at = case when p_error is null then now() else processed_at end
  where provider = p_provider and event_id = p_event_id;
$$;

-- Server only, like the table. Functions in public are executable by everyone by default.
revoke execute on function public.record_webhook_attempt(text, text, text) from public, anon, authenticated;
grant execute on function public.record_webhook_attempt(text, text, text) to service_role;
