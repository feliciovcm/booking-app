-- Our treatments -> the vendor's service ids. Server only, like location_provider_mappings.
--
-- Keyed by (treatment, provider), not by treatment alone: the location decides which
-- vendor books it, so a treatment needs an id at every vendor that might book it.

create table public.service_provider_mappings (
  treatment_id        uuid not null references public.treatments(id) on delete cascade,
  provider            text not null,
  provider_service_id text not null,
  primary key (treatment_id, provider),
  unique (provider, provider_service_id) -- two of our treatments can't share one vendor service
);

revoke all on public.service_provider_mappings from anon, authenticated;
grant all on public.service_provider_mappings to service_role;

alter table public.service_provider_mappings enable row level security;
-- No policies on purpose. service_role bypasses RLS; every other role is denied.

-- Demo data. Must match SERVICES in supabase/functions/mock-boulevard/slots.ts.
-- Per-environment data: move to seed files when we go local (sandbox ids differ).
insert into public.service_provider_mappings (treatment_id, provider, provider_service_id)
select t.id, 'boulevard', 'urn:blvd:Service:2b7d4e90-5a1c-4f3e-8d6b-00000000000' || case t.slug
    when 'prp' then '1'
    when 'folix' then '2'
    when 'bundle' then '3'
  end
from public.treatments t
where t.slug in ('prp', 'folix', 'bundle');
