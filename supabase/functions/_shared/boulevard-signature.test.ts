// @vitest-environment node
import { describe, expect, it } from "vitest";
import { makeSalt, signBoulevardWebhook, verifyBoulevardWebhook } from "./boulevard-signature.ts";

// Expected values were computed independently with openssl, following Boulevard's
// documented steps (decode the secret, HMAC-SHA256 of "salt:body", Base64):
//   printf '%s:%s' "$SALT" "$BODY" | openssl dgst -sha256 -mac HMAC -macopt hexkey:<decoded secret as hex> -binary | base64
const SECRET = "cmF3LWJpbmFyeS1jbGllbnQtc2VjcmV0LWJ5dGVz"; // base64("raw-binary-client-secret-bytes"), as the portal shows it
const BODY = '{"eventType":"APPOINTMENT_CREATED","idempotencyKey":"58e5797b"}';
const NOW = Date.parse("2026-11-24T12:00:00Z");
const SALT = makeSalt("efa1a1fd-80b2-41c8-8b13-850f36f9a303", NOW / 1000);
const SIGNATURE = "ri9TBXSdfuLl4NUxG0F50wU0D5NpHLACti8BDRFNMx8=";
/** What you'd get by wrongly keying the HMAC with the Base64 text itself. */
const SIGNED_WITH_TEXT_KEY = "/Mm3PJbImhlcLWS/9NeoDzWMSlR7oL7+YVs5/v56LC0=";

const verify = (overrides: Partial<Parameters<typeof verifyBoulevardWebhook>[0]> = {}) =>
  verifyBoulevardWebhook({ secretBase64: SECRET, salt: SALT, signature: SIGNATURE, rawBody: BODY, nowMs: NOW, ...overrides });

describe("Boulevard webhook signature", () => {
  it("signs exactly like Boulevard's documented algorithm", async () => {
    expect(SALT).toBe("blvd-webhook-oauth-v1:efa1a1fd-80b2-41c8-8b13-850f36f9a303:1795521600");
    expect(await signBoulevardWebhook(SECRET, SALT, BODY)).toBe(SIGNATURE);
  });

  it("keys the HMAC with the decoded secret, not the Base64 text the portal shows", async () => {
    expect(await signBoulevardWebhook(SECRET, SALT, BODY)).not.toBe(SIGNED_WITH_TEXT_KEY);
    expect(await verify({ signature: SIGNED_WITH_TEXT_KEY })).toMatchObject({ reason: "BAD_SIGNATURE" });
  });

  it("accepts a genuine delivery and returns its delivery id", async () => {
    expect(await verify()).toEqual({ ok: true, deliveryId: "efa1a1fd-80b2-41c8-8b13-850f36f9a303" });
  });

  it("rejects a changed body, even one that parses to the same JSON", async () => {
    expect(await verify({ rawBody: BODY.replace("58e5797b", "00000000") })).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
    expect(await verify({ rawBody: JSON.stringify(JSON.parse(BODY), null, 2) })).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
  });

  it("rejects the wrong secret, missing headers and a malformed salt", async () => {
    expect(await verify({ secretBase64: "b3RoZXI=" })).toMatchObject({ reason: "BAD_SIGNATURE" });
    expect(await verify({ signature: null })).toMatchObject({ reason: "MISSING_HEADERS" });
    expect(await verify({ salt: "v0:abc:123" })).toMatchObject({ reason: "BAD_SALT" });
    expect(await verify({ salt: "blvd-webhook-oauth-v1:abc:soon" })).toMatchObject({ reason: "BAD_SALT" });
  });

  it("rejects a replay of an old delivery, but allows a little clock skew", async () => {
    expect(await verify({ nowMs: NOW + 10 * 60_000 })).toMatchObject({ reason: "STALE" });
    expect(await verify({ nowMs: NOW - 10 * 60_000 })).toMatchObject({ reason: "STALE" });
    expect(await verify({ nowMs: NOW + 60_000 })).toMatchObject({ ok: true });
  });

  it("checks the signature before the timestamp, so a forged fresh salt doesn't help", async () => {
    expect(await verify({ salt: makeSalt("x", NOW / 1000) })).toMatchObject({ reason: "BAD_SIGNATURE" });
  });
});
