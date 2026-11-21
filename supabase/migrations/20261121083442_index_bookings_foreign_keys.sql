-- Postgres doesn't index foreign keys. Without these, joins and deleting a treatment or
-- location scan every booking (Supabase skill rule: schema-foreign-key-indexes).
--
-- location_id leads a composite with slot_start: it covers the foreign key and the coming
-- "bookings at this studio by time" queries (expiring holds, reconciling with the vendor).
create index bookings_location_id_slot_start_idx on public.bookings (location_id, slot_start);
create index bookings_treatment_id_idx on public.bookings (treatment_id);

-- Plain CREATE INDEX locks writes on the table while it builds. Fine for a small table.
-- On a large production table use CREATE INDEX CONCURRENTLY instead, in its own migration,
-- because it can't run inside the transaction a migration normally uses.
