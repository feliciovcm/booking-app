-- The card on file lives with the booking vendor: the browser sends it to Boulevard's
-- Tokenization API and only a token reaches our server. These columns came from the
-- earlier Stripe SetupIntent design and would never be filled.
-- Dropping stripe_setup_intent_id also drops its unique constraint.
alter table public.bookings
  drop column stripe_customer_id,
  drop column stripe_setup_intent_id;
