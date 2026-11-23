// HTTP layer of the fake Boulevard. Runtime-agnostic: storage, clock, randomness and
// sleeping come in through Deps, so Vitest can drive it directly.
//
//   POST /mock-boulevard/oauth2/token          anonymous grant (browser) or client_credentials (server)
//   POST /mock-boulevard/api/2026-06/client    the Client API (GraphQL), Bearer token required
//   POST /mock-boulevard/cards/tokenize        the Tokenization API: card in, opaque token out
//
// Failures: `x-mock-fail: 429 | 500 | 503 | timeout` forces one; otherwise a random share
// of API calls fails (failureRate) and every API call waits a random latency.

import { graphql, type GraphQLFormattedError } from "graphql";
import { BlvdError, rootValue, schema, type BoulevardStore } from "./schema.ts";
import { constantTimeEqual, signToken, verifyToken, type TokenKind } from "./tokens.ts";

export type Deps = {
  clientId: string;
  /** Base64 text, the form the developer portal shows and /oauth2/token expects. */
  clientSecret: string;
  businessId: string;
  store: BoulevardStore;
  now: () => Date;
  random: () => number;
  sleep: (ms: number) => Promise<void>;
  /** 0..1, share of API calls that fail with a random 429 or 503. */
  failureRate: number;
  maxLatencyMs: number;
  log: (entry: Record<string, unknown>) => void;
};

const API_PATH = "/api/2026-06/client";
const TIMEOUT_MS = 30_000;
const SCOPES = "business:read cart:read cart:write location:read service:read";
const TOKEN_TTL_S: Record<TokenKind, number> = { anonymous: 900, client_credentials: 86_400 };

// The anonymous grant is meant to be called from a browser, so the mock allows CORS.
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type, x-mock-fail",
  "access-control-allow-methods": "POST, OPTIONS",
};

function json(status: number, body: unknown, requestId: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-request-id": requestId, ...CORS, ...headers },
  });
}

// Boulevard's 429 says how long to wait in the message, not in a Retry-After header.
const rateLimited = (requestId: string) =>
  json(429, { errors: [{ message: "API limit exceeded. Query cost is 32 and you have 4 points available. Please wait 280ms and try again." }] }, requestId);

function failure(kind: string, requestId: string, deps: Deps): Promise<Response> | Response | null {
  switch (kind) {
    case "429":
      return rateLimited(requestId);
    case "500":
      return json(500, { errors: [{ message: "Internal Server Error" }] }, requestId);
    case "503":
      return json(503, { errors: [{ message: "Service Unavailable" }] }, requestId);
    case "timeout":
      // Hangs past any sane client timeout. The caller's AbortController should fire first.
      return deps.sleep(TIMEOUT_MS).then(() => json(504, { errors: [{ message: "Gateway Timeout" }] }, requestId));
    default:
      return null;
  }
}

export function createHandler(deps: Deps): (req: Request) => Promise<Response> {
  return async (req) => {
    const started = Date.now();
    const requestId = `req_${Math.floor(deps.random() * 1e12).toString(36)}`;
    // Supabase routes /functions/v1/mock-boulevard/... to us with the function name kept.
    const path = new URL(req.url).pathname.replace(/^.*?\/mock-boulevard/, "") || "/";
    const meta: Record<string, unknown> = {};

    let response: Response;
    if (req.method === "OPTIONS") response = new Response(null, { status: 204, headers: CORS });
    else if (req.method === "POST" && path === "/oauth2/token") response = await token(req, requestId, deps);
    else if (req.method === "POST" && path === API_PATH) response = await api(req, requestId, deps, meta);
    else if (req.method === "POST" && path === "/cards/tokenize") response = await tokenize(req, requestId, deps);
    else response = json(404, { errors: [{ message: `No route for ${req.method} ${path}` }] }, requestId);

    // No personal data in logs: ids, operation, error codes and timing only.
    deps.log({ fn: "mock-boulevard", requestId, method: req.method, path, ...meta, status: response.status, ms: Date.now() - started });
    return response;
  };
}

async function readParams(req: Request): Promise<Record<string, string>> {
  try {
    if (req.headers.get("content-type")?.includes("application/json")) return (await req.json()) as Record<string, string>;
    return Object.fromEntries(new URLSearchParams(await req.text()));
  } catch {
    return {};
  }
}

// Standard OAuth2 error responses, as the docs say the token endpoint returns.
async function token(req: Request, requestId: string, deps: Deps): Promise<Response> {
  const p = await readParams(req);
  const oauthError = (status: number, error: string) => json(status, { error }, requestId);

  let kind: TokenKind;
  if (p.grant_type === "urn:blvd:params:oauth:grant-type:anonymous") kind = "anonymous";
  else if (p.grant_type === "client_credentials") kind = "client_credentials";
  else return oauthError(400, "unsupported_grant_type");

  if (!p.client_id || !p.business_id) return oauthError(400, "invalid_request");
  if (p.client_id !== deps.clientId) return oauthError(401, "invalid_client");
  if (p.business_id !== deps.businessId) return oauthError(400, "invalid_request");
  if (kind === "client_credentials") {
    if (!constantTimeEqual(p.client_secret ?? "", deps.clientSecret)) return oauthError(401, "invalid_client");
    if (!p.resource?.endsWith(API_PATH)) return oauthError(400, "invalid_target");
  }

  const ttl = TOKEN_TTL_S[kind];
  return json(200, {
    access_token: await signToken(deps.clientSecret, kind, deps.now().getTime() + ttl * 1000),
    token_type: "bearer",
    scope: SCOPES,
    expires_in: ttl,
    aud: [p.resource ?? `https://mock.boulevard${API_PATH}`],
  }, requestId);
}

async function api(req: Request, requestId: string, deps: Deps, meta: Record<string, unknown>): Promise<Response> {
  const bearer = req.headers.get("authorization")?.match(/^Bearer (.+)$/i)?.[1];
  if (!bearer || !(await verifyToken(deps.clientSecret, bearer, deps.now().getTime()))) {
    return json(401, { errors: [{ message: "Unauthorized" }] }, requestId);
  }

  const forced = req.headers.get("x-mock-fail");
  if (forced) {
    const response = failure(forced, requestId, deps);
    if (response) return response;
  }
  await deps.sleep(Math.floor(deps.random() * deps.maxLatencyMs));
  if (!forced && deps.random() < deps.failureRate) return failure(deps.random() < 0.5 ? "429" : "503", requestId, deps)!;

  let body: { query?: unknown; variables?: Record<string, unknown>; operationName?: string };
  try {
    body = await req.json();
  } catch {
    return json(400, { errors: [{ message: "Body must be JSON with a query" }] }, requestId);
  }
  if (typeof body.query !== "string") return json(400, { errors: [{ message: "Missing query" }] }, requestId);
  meta.operation = body.operationName ?? null;

  const result = await graphql({
    schema,
    source: body.query,
    rootValue,
    contextValue: { store: deps.store, now: deps.now() },
    variableValues: body.variables,
    operationName: body.operationName,
  });

  // Boulevard puts its error fields at the top level of each error, not under
  // `extensions`: { __typename: "BlvdError", code, message, description, path }.
  const errors = result.errors?.map((error): GraphQLFormattedError | Record<string, unknown> => {
    const original = error.originalError;
    if (original instanceof BlvdError) {
      return { __typename: "BlvdError", code: original.code, message: original.message, description: original.description, path: error.path };
    }
    return { message: error.message, path: error.path, locations: error.locations };
  });
  if (errors) meta.errorCodes = errors.map((e) => ("code" in e ? e.code : "GRAPHQL"));
  return json(200, errors ? { data: result.data ?? null, errors } : { data: result.data }, requestId);
}

// The Tokenization API: the browser posts the card here directly, so card data never
// passes through our server (that keeps us out of PCI DSS scope). The docs show
//   { card: { name, number, cvv, exp_month, exp_year, address_postal_code } }, all required
//   -> 200 { success: true, token: "<uuid>" }
// They don't document failures; the 400 { success: false, error } below is mock-only.
// The mock keeps nothing: the card is checked and dropped, and the token is random.
async function tokenize(req: Request, requestId: string, deps: Deps): Promise<Response> {
  let card: Record<string, unknown> | undefined;
  try {
    card = ((await req.json()) as { card?: Record<string, unknown> }).card;
  } catch {
    // handled below
  }
  const problem = card ? cardProblem(card, deps.now()) : "Missing card";
  if (problem) return json(400, { success: false, error: problem }, requestId);
  return json(200, { success: true, token: crypto.randomUUID() }, requestId);
}

function cardProblem(card: Record<string, unknown>, now: Date): string | null {
  const { name, number, cvv, exp_month: month, exp_year: year, address_postal_code: postal } = card;
  if (typeof name !== "string" || !name.trim()) return "Missing cardholder name";
  if (typeof number !== "string" || !/^\d{12,19}$/.test(number) || !luhn(number)) return "Invalid card number";
  if (typeof cvv !== "string" || !/^\d{3,4}$/.test(cvv)) return "Invalid cvv";
  if (!Number.isInteger(month) || !Number.isInteger(year) || (month as number) < 1 || (month as number) > 12) return "Invalid expiry";
  // A card is valid through the last day of its expiry month.
  const thisMonth = now.getUTCFullYear() * 12 + now.getUTCMonth();
  if ((year as number) * 12 + (month as number) - 1 < thisMonth) return "Card expired";
  if (typeof postal !== "string" || !postal.trim()) return "Missing postal code";
  return null;
}

// The check digit every real card number has: catches typos, not fraud.
function luhn(number: string): boolean {
  let sum = 0;
  for (let i = 0; i < number.length; i++) {
    let digit = Number(number[number.length - 1 - i]);
    if (i % 2 === 1) digit = digit * 2 > 9 ? digit * 2 - 9 : digit * 2;
    sum += digit;
  }
  return sum % 10 === 0;
}
