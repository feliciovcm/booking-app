-- Great Many's vendor is Boulevard. The demo mappings now use the provider name
-- 'boulevard' and Boulevard-style opaque ids (urn:blvd:Location:<uuid>).
--
-- The provider is the vendor, not the environment: the mock, Boulevard's sandbox and
-- production are all 'boulevard', and which base URL the adapter calls is config.
-- These ids must match VENDOR_LOCATIONS in supabase/functions/mock-boulevard/slots.ts.

update public.location_provider_mappings m
set provider = 'boulevard',
    provider_location_id = 'urn:blvd:Location:' || case l.slug
      when 'noho'          then '6c1f0a52-1d3e-4b7a-9f20-000000000001'
      when 'grand-central' then '6c1f0a52-1d3e-4b7a-9f20-000000000002'
      when 'atlanta'       then '6c1f0a52-1d3e-4b7a-9f20-000000000003'
      when 'dc'            then '6c1f0a52-1d3e-4b7a-9f20-000000000004'
    end
from public.locations l
where l.id = m.location_id
  and m.provider = 'mock-scheduler'
  and l.slug in ('noho', 'grand-central', 'atlanta', 'dc');
