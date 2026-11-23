// The booking function our frontend calls. Vendor-agnostic: it works with whatever
// BookingProvider the mapping tables point to, through the registry in Deps. Only
// index.ts (the composition root) knows which vendors exist.
//
// Anonymous visitors use it, so it accepts the publishable key (checked here; verify_jwt
// is off in config.toml, as Supabase's docs recommend for publishable-key functions).
//
// POST { action: "start", location, service }  -> { sessionId }
// POST { action: "dates", sessionId, from, to } -> { dates: ["2026-11-25", ...] }
// POST { action: "times", sessionId, date }     -> { times: [{ id, start }] }   start is UTC ISO
// POST { action: "hold",  sessionId, slotId }   -> { start, expiresAt }
//
// Errors: { error: { code, message } } with our codes (see BookingErrorCode); message is
// safe to show the visitor.

import { z } from "zod";
import { BookingError, type BookingErrorCode, type BookingProvider } from "../_shared/booking-provider.ts";
import { createLogger, requestIdFrom, type Log, type Sink } from "../_shared/log.ts";

export type Mapping = { provider: string; vendorLocationId: string; vendorServiceId: string };

export type Deps = {
  /** Values of SUPABASE_PUBLISHABLE_KEYS. */
  publishableKeys: string[];
  /** Browser origins allowed to call us (CORS). */
  allowedOrigins: string[];
  /** Our slugs -> provider name and vendor ids, from the server-only mapping tables. Null if not bookable. */
  resolve: (locationSlug: string, serviceSlug: string) => Promise<Mapping | null>;
  /** Provider name (as stored in the mapping tables) -> a client for this request. */
  providers: Record<string, (log: Log) => BookingProvider>;
  sink?: Sink;
};

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const slug = z.string().regex(/^[a-z0-9-]{1,64}$/);
const sessionId = z.string().min(3).max(250);
const MAX_RANGE_DAYS = 31;

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start"), location: slug, service: slug }),
  z.object({ action: z.literal("dates"), sessionId, from: date, to: date }),
  z.object({ action: z.literal("times"), sessionId, date }),
  z.object({ action: z.literal("hold"), sessionId, slotId: z.string().min(1).max(100) }),
]);

const STATUS: Record<BookingErrorCode, number> = {
  SLOT_UNAVAILABLE: 409,
  SESSION_EXPIRED: 409,
  INVALID: 400,
  UNAVAILABLE: 503,
  MISCONFIGURED: 502,
};

// Our session id records which provider owns it, so follow-up calls reach the same
// vendor without the browser knowing vendors exist: "<provider>|<vendor session id>".
const SEPARATOR = "|";
const toSessionId = (provider: string, vendorSessionId: string) => `${provider}${SEPARATOR}${vendorSessionId}`;
function fromSessionId(id: string): { provider: string; vendorSessionId: string } | null {
  const at = id.indexOf(SEPARATOR);
  return at > 0 ? { provider: id.slice(0, at), vendorSessionId: id.slice(at + 1) } : null;
}

export function createHandler(deps: Deps): (req: Request) => Promise<Response> {
  return async (req) => {
    const started = Date.now();
    const log = createLogger("booking", requestIdFrom(req), deps.sink);
    const origin = req.headers.get("origin");
    const cors: Record<string, string> = {
      "access-control-allow-headers": "authorization, apikey, content-type, x-client-info, x-request-id",
      "access-control-allow-methods": "POST, OPTIONS",
      vary: "origin",
      ...(origin && deps.allowedOrigins.includes(origin) ? { "access-control-allow-origin": origin } : {}),
    };
    const fields: Record<string, string | undefined> = {};
    const reply = (status: number, body: unknown) => {
      log[status >= 500 ? "error" : status >= 400 ? "warn" : "info"]("booking request", { status, ms: Date.now() - started, ...fields });
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "x-request-id": log.requestId, ...cors } });
    };
    const fail = (status: number, code: string, message: string) => {
      fields.errorCode = code;
      return reply(status, { error: { code, message } });
    };

    // Preflight first: browsers send it without our headers.
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (req.method !== "POST") return fail(405, "METHOD_NOT_ALLOWED", "Use POST.");

    // The publishable key is public, so this only keeps out callers that aren't our app's
    // clients. Abuse protection is rate limiting and bot checks, not this.
    if (!deps.publishableKeys.includes(req.headers.get("apikey") ?? "")) return fail(401, "UNAUTHORIZED", "Missing or invalid API key.");

    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return fail(400, "INVALID_REQUEST", "Something about this request isn't right.");
    const body = parsed.data;
    fields.action = body.action;

    /** The provider and vendor session behind one of our session ids. */
    const session = (id: string) => {
      const parts = fromSessionId(id);
      const make = parts && deps.providers[parts.provider];
      if (!parts || !make) throw new BookingError("SESSION_EXPIRED", "Your booking session expired. Please start again.");
      fields.provider = parts.provider;
      return { provider: make(log), id: parts.vendorSessionId };
    };

    try {
      switch (body.action) {
        case "start": {
          const mapping = await deps.resolve(body.location, body.service);
          const make = mapping && deps.providers[mapping.provider];
          if (!mapping || !make) return fail(404, "NOT_BOOKABLE", "This treatment can't be booked online at this clinic.");
          fields.provider = mapping.provider;
          const { sessionId } = await make(log).startSession(mapping.vendorLocationId, mapping.vendorServiceId);
          return reply(200, { sessionId: toSessionId(mapping.provider, sessionId) });
        }
        case "dates": {
          const days = (Date.parse(body.to) - Date.parse(body.from)) / 86_400_000;
          if (!(days >= 0 && days < MAX_RANGE_DAYS)) return fail(400, "INVALID_RANGE", `Pick a range of up to ${MAX_RANGE_DAYS} days.`);
          const s = session(body.sessionId);
          return reply(200, { dates: await s.provider.availableDates(s.id, body.from, body.to) });
        }
        case "times": {
          const s = session(body.sessionId);
          return reply(200, { times: await s.provider.availableTimes(s.id, body.date) });
        }
        case "hold": {
          const s = session(body.sessionId);
          return reply(200, await s.provider.hold(s.id, body.slotId));
        }
      }
    } catch (error) {
      if (error instanceof BookingError) {
        fields.vendorCode = error.vendorCode;
        return fail(STATUS[error.code], error.code, error.userMessage);
      }
      log.error("unexpected error", { action: body.action, errorName: error instanceof Error ? error.name : typeof error });
      return fail(500, "INTERNAL", "Something went wrong. Please try again.");
    }
  };
}
