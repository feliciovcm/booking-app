-- Demo data. Depends on the column names in docs/step-1-schema-rls.md.

insert into public.treatments (slug, name, description, price_cents, session_count, sort_order) values
  ('prp',    'PRP Hair Restoration',   'Full-scalp, all-natural growth factor treatment.', 49500, 3, 1),
  ('folix',  'Laser Hair Restoration', 'FDA-cleared, needle-free targeted laser.',          49500, 3, 2),
  ('bundle', 'PRP + Laser Bundle',     'Both therapies in every session.',                  66000, 3, 3);

-- Inactive row: must never be visible to the client.
insert into public.treatments (slug, name, price_cents, active, sort_order) values
  ('legacy-serum', 'Retired Serum Add-on', 9900, false, 99);

insert into public.locations (slug, name, address, timezone) values
  ('noho',          'NYC Noho',          '304 Mulberry St, New York, NY', 'America/New_York'),
  ('grand-central', 'NYC Grand Central', 'Grand Central, New York, NY',   'America/New_York'),
  ('atlanta',       'Atlanta Buckhead',  'Buckhead Village, Atlanta, GA', 'America/New_York'),
  ('dc',            'Washington DC',     'Washington, DC',                'America/New_York');

insert into public.location_provider_mappings (location_id, provider, provider_location_id)
select id, 'mock-scheduler', 'loc_' || replace(slug, '-', '_')
from public.locations;
