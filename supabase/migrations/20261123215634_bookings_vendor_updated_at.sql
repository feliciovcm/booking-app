-- When the vendor says the latest change we applied to this booking happened (the
-- webhook's own timestamp, not when we received it). Webhooks can arrive out of order,
-- so a reschedule older than this is skipped instead of moving the booking back.
-- Null = no webhook applied yet (checkout confirmed it directly).
alter table public.bookings add column vendor_updated_at timestamptz;

-- Webhook processing finds bookings by the vendor's appointment id. The existing
-- unique (provider, provider_booking_id) constraint already indexes that lookup.
