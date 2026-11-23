// Deno entry for the booking function, and its composition root: the only file that
// knows which vendors exist. Adding a vendor = write its adapter, register it below,
// and point mapping rows at its name. The handler doesn't change.

import { createClient } from "@supabase/supabase-js";
import { createBoulevard } from "../_shared/boulevard.ts";
import { createHandler, type Mapping } from "./handler.ts";

const env = (name: string) => {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} must be set`);
  return value;
};

// The new API keys arrive as JSON dictionaries keyed by name ("default", ...).
const publishableKeys = Object.values(JSON.parse(env("SUPABASE_PUBLISHABLE_KEYS")) as Record<string, string>);
const secretKey = (JSON.parse(env("SUPABASE_SECRET_KEYS")) as Record<string, string>).default;
// Secret key = service_role: bypasses RLS. Only used for the mapping tables, never with
// anything the caller controls beyond the two slugs.
const admin = createClient(env("SUPABASE_URL"), secretKey, { auth: { persistSession: false } });

const boulevardConfig = {
  baseUrl: env("BOULEVARD_BASE_URL"),
  clientId: env("BOULEVARD_CLIENT_ID"),
  clientSecret: env("BOULEVARD_CLIENT_SECRET"),
  businessId: env("BOULEVARD_BUSINESS_ID"),
};

async function resolve(locationSlug: string, serviceSlug: string): Promise<Mapping | null> {
  const { data: location, error: locationError } = await admin
    .from("locations")
    .select("location_provider_mappings(provider, provider_location_id)")
    .eq("slug", locationSlug)
    .eq("active", true)
    .maybeSingle();
  if (locationError) throw locationError;
  const vendor = location?.location_provider_mappings as { provider: string; provider_location_id: string } | null | undefined;
  if (!vendor) return null;

  const { data: service, error: serviceError } = await admin
    .from("service_provider_mappings")
    .select("provider_service_id, treatments!inner(slug, active)")
    .eq("provider", vendor.provider)
    .eq("treatments.slug", serviceSlug)
    .eq("treatments.active", true)
    .maybeSingle();
  if (serviceError) throw serviceError;
  if (!service) return null;

  return { provider: vendor.provider, vendorLocationId: vendor.provider_location_id, vendorServiceId: service.provider_service_id };
}

export default {
  fetch: createHandler({
    publishableKeys,
    allowedOrigins: env("BOOKING_ALLOWED_ORIGINS").split(",").map((o) => o.trim()),
    resolve,
    // Keys match `provider` in the mapping tables.
    providers: {
      boulevard: (log) => createBoulevard(boulevardConfig, log),
    },
  }),
};
