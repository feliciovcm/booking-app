// Access tokens for the mock's OAuth2 endpoint. Real Boulevard tokens are RS256 JWTs;
// the mock signs a small payload with HMAC-SHA256 instead, so it needs no key pair and
// no storage. Uses Web Crypto, which both Deno and Node provide.

export type TokenKind = "anonymous" | "client_credentials";
type Payload = { kind: TokenKind; exp: number };

const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(data))));
}

export async function signToken(secret: string, kind: TokenKind, expiresAtMs: number): Promise<string> {
  const body = base64url(encoder.encode(JSON.stringify({ kind, exp: expiresAtMs } satisfies Payload)));
  return `mockblvd.${body}.${await hmac(secret, body)}`;
}

/** The token's payload if the signature is valid and it hasn't expired, else null. */
export async function verifyToken(secret: string, token: string, nowMs: number): Promise<Payload | null> {
  const [prefix, body, signature] = token.split(".");
  if (prefix !== "mockblvd" || !body || !signature) return null;
  if (!constantTimeEqual(signature, await hmac(secret, body))) return null;
  try {
    const payload = JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/"))) as Payload;
    return payload.exp > nowMs ? payload : null;
  } catch {
    return null;
  }
}

// Compares without returning early, so response time doesn't leak how much matched.
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
