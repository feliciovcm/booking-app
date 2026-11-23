// Fake Boulevard (Great Many's appointment system), deployed as its own edge function.
// Our functions call it like the real Client API: get a token, then send GraphQL.
// Swapping to Boulevard's sandbox is a base URL and credentials, not a code change.
// verify_jwt is off in supabase/config.toml: it checks its own OAuth tokens instead.

import { createHandler } from "./handler.ts";
import { createPgStore } from "./store.ts";
import { createWebhookSender } from "./webhooks.ts";

const env = (name: string) => {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} must be set`);
  return value;
};

// Optional: where to send appointment webhooks (our boulevard-webhook function).
const webhookUrl = Deno.env.get("MOCK_WEBHOOK_URL");
const log = (entry: Record<string, unknown>) => console.log(JSON.stringify(entry));

export default {
  fetch: createHandler({
    clientId: env("MOCK_BLVD_CLIENT_ID"),
    clientSecret: env("MOCK_BLVD_CLIENT_SECRET"),
    businessId: env("MOCK_BLVD_BUSINESS_ID"),
    store: createPgStore(env("SUPABASE_DB_URL")),
    now: () => new Date(),
    random: Math.random,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    failureRate: Number(Deno.env.get("MOCK_FAILURE_RATE") ?? "0.1"),
    maxLatencyMs: Number(Deno.env.get("MOCK_MAX_LATENCY_MS") ?? "800"),
    log,
    webhooks: webhookUrl ? createWebhookSender({ url: webhookUrl, clientSecret: env("MOCK_BLVD_CLIENT_SECRET"), log }) : undefined,
    // The response returns right away; the runtime keeps the delivery running.
    defer: (work) => EdgeRuntime.waitUntil(work),
  }),
};
