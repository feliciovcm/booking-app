// Boulevard's webhook signature (Admin API docs, "Webhook authentication"):
//
//   x-blvd-oauth-hmac-salt:   blvd-webhook-oauth-v1:<per-delivery id>:<unix timestamp>
//   x-blvd-oauth-hmac-sha256: base64( HMAC-SHA256( key = base64decode(client secret),
//                                                   data = salt + ":" + raw body ) )
//
// Two details the docs call out, and both are easy to get wrong:
// - the key is the DECODED secret (the portal shows it as Base64 text)
// - sign and verify the raw body bytes, before any JSON parsing or re-serializing
//
// Shared by the mock (which signs) and our receiver (which verifies). Web Crypto only,
// so it runs in Deno, Node and Workers alike.

export const SALT_HEADER = "x-blvd-oauth-hmac-salt";
export const SIGNATURE_HEADER = "x-blvd-oauth-hmac-sha256";
const SALT_PREFIX = "blvd-webhook-oauth-v1";

const encoder = new TextEncoder();
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function hmacBase64(secretBase64: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", fromBase64(secretBase64), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toBase64(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(data))));
}

/** The salt Boulevard sends with a delivery. */
export const makeSalt = (deliveryId: string, unixSeconds: number) => `${SALT_PREFIX}:${deliveryId}:${unixSeconds}`;

/** The signature header value for a raw body. */
export const signBoulevardWebhook = (secretBase64: string, salt: string, rawBody: string) => hmacBase64(secretBase64, `${salt}:${rawBody}`);

export type VerifyResult = { ok: true; deliveryId: string } | { ok: false; reason: "MISSING_HEADERS" | "BAD_SALT" | "STALE" | "BAD_SIGNATURE" };

/**
 * Checks a delivery came from Boulevard and isn't a replay. `maxAgeSeconds` bounds the
 * salt's timestamp both ways (a little clock skew is normal; 5 minutes is generous).
 */
export async function verifyBoulevardWebhook(input: {
  secretBase64: string;
  salt: string | null;
  signature: string | null;
  rawBody: string;
  nowMs: number;
  maxAgeSeconds?: number;
}): Promise<VerifyResult> {
  const { salt, signature } = input;
  if (!salt || !signature) return { ok: false, reason: "MISSING_HEADERS" };

  const [prefix, deliveryId, timestamp, ...rest] = salt.split(":");
  if (prefix !== SALT_PREFIX || !deliveryId || !/^\d+$/.test(timestamp ?? "") || rest.length) return { ok: false, reason: "BAD_SALT" };

  // Check the signature before trusting the timestamp: an attacker can write any salt.
  const expected = await signBoulevardWebhook(input.secretBase64, salt, input.rawBody);
  if (!constantTimeEqual(expected, signature)) return { ok: false, reason: "BAD_SIGNATURE" };

  const ageSeconds = Math.abs(input.nowMs / 1000 - Number(timestamp));
  if (ageSeconds > (input.maxAgeSeconds ?? 300)) return { ok: false, reason: "STALE" };
  return { ok: true, deliveryId };
}

// Compares without returning early, so response time doesn't leak how much matched.
function constantTimeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
