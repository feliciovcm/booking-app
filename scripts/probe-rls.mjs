// Attacker probe: calls the real Supabase REST API with the public anon key
// and checks that it can do only what docs/step-1-schema-rls.md allows.
// Run: npm run probe:rls  (reads VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY from .env.local)
//
// Safe by design: it never deletes, and its only update writes a row's own value back.

const url = process.env.VITE_SUPABASE_URL;
const key = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
if (!url || !key) {
  console.error("Missing VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY in .env.local");
  process.exit(1);
}

const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
const rest = (path, init = {}) =>
  fetch(`${url}/rest/v1/${path}`, { ...init, headers: { ...headers, ...init.headers } });

let failures = 0;
const report = (ok, label, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
};

// Reading is "blocked" when the API returns no rows or refuses outright.
async function expectNoRead(table) {
  const res = await rest(`${table}?select=*&limit=5`);
  const body = await res.json().catch(() => null);
  const blocked = (res.ok && Array.isArray(body) && body.length === 0) || res.status === 401 || res.status === 403;
  report(blocked, `anon cannot read ${table}`, res.ok ? `${body?.length} rows` : `HTTP ${res.status}`);
}

// Only a permission refusal counts. A 400 (bad column, FK, check) would hide a missing RLS rule.
// Postgres checks privileges and RLS before constraints, so a blocked insert is always 401/403.
async function expectInsertBlocked(table, row) {
  const res = await rest(table, { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(row) });
  const refused = res.status === 401 || res.status === 403;
  report(refused, `anon cannot insert into ${table}`, `HTTP ${res.status}`);
}

async function expectPublicReadOnly(table, newRow) {
  const res = await rest(`${table}?select=*`);
  const rows = await res.json().catch(() => null);
  const readable = res.ok && Array.isArray(rows) && rows.length > 0;
  report(readable, `anon can read ${table}`, readable ? `${rows.length} rows` : `HTTP ${res.status}`);
  if (!readable) return;

  report(rows.every((r) => r.active === true), `anon sees only active ${table}`);

  // Write the row's own name back. If any row comes back, the update was allowed.
  const { id, name } = rows[0];
  const upd = await rest(`${table}?id=eq.${id}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ name }),
  });
  const updated = upd.ok ? await upd.json() : [];
  report(updated.length === 0, `anon cannot update ${table}`, upd.ok ? `${updated.length} rows changed` : `HTTP ${upd.status}`);

  await expectInsertBlocked(table, newRow);
}

async function probeConsultRequests() {
  const valid = { full_name: "RLS Probe", phone: "5555550100", message: "probe-rls.mjs" };
  const ok = await rest("consult_requests", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(valid) });
  report(ok.status === 201, "anon can insert a valid consult_request", `HTTP ${ok.status}`);

  const tooLong = { ...valid, full_name: "x".repeat(500) };
  const bad = await rest("consult_requests", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(tooLong) });
  report(!bad.ok, "anon cannot insert an oversized consult_request", `HTTP ${bad.status}`);

  await expectNoRead("consult_requests");
}

console.log(`Probing ${url} as anon\n`);
await expectPublicReadOnly("treatments", { slug: `probe-${Date.now()}`, name: "probe", price_cents: 1 });
await expectPublicReadOnly("locations", { slug: `probe-${Date.now()}`, name: "probe", address: "x", timezone: "UTC" });
await expectNoRead("location_provider_mappings");
await expectInsertBlocked("location_provider_mappings", { location_id: crypto.randomUUID(), provider: "x", provider_location_id: "x" });
await expectNoRead("bookings");
await expectInsertBlocked("bookings", {
  email: "attacker@test.dev", treatment_id: crypto.randomUUID(), location_id: crypto.randomUUID(),
  slot_start: new Date().toISOString(), idempotency_key: crypto.randomUUID(),
});
await expectNoRead("webhook_events");
await expectInsertBlocked("webhook_events", { provider: "stripe", event_id: `evt_${Date.now()}`, type: "x", payload: {} });
await probeConsultRequests();

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
