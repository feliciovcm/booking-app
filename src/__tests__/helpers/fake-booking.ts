import { vi } from "vitest";

// A fake of our `booking` edge function, installed as global fetch. It follows the same
// contract (actions, sessionId, error codes), records every call, and lets a test
// script the next response for an action. It also fakes the vendor's card tokenizer,
// which the browser calls directly (any URL ending in /cards/tokenize).

type Reply = { status: number; body: unknown };

export function installFakeBooking() {
  const state = {
    calls: [] as { action: string; body: Record<string, unknown>; headers: Headers }[],
    tokenizeCalls: [] as { url: string; body: { card: Record<string, unknown> } }[],
    /** Set to make the tokenizer refuse the card with this error. */
    cardError: null as string | null,
    /** What summary returns: the session's live hold, or null. */
    hold: { start: "2026-11-25T14:00:00.000Z", expiresAt: "2026-11-24T15:30:00.000Z" } as { start: string; expiresAt: string } | null,
    /** Bookings by idempotency key: the same key returns the same booking. */
    bookings: {} as Record<string, { bookingId: string; start: string }>,
    sessions: 0,
    dates: ["2026-11-25", "2026-11-26"],
    times: {
      "2026-11-25": [
        { id: "t1", start: "2026-11-25T14:00:00.000Z" }, // 9:00 AM in New York
        { id: "t2", start: "2026-11-25T15:00:00.000Z" },
      ],
      "2026-11-26": [],
    } as Record<string, { id: string; start: string }[]>,
    taken: new Set<string>(),
    /** One-shot scripted replies, per action. */
    next: {} as Record<string, Reply[]>,
  };

  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const error = (status: number, code: string, message: string) => json(status, { error: { code, message } });

  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    if (url.endsWith("/cards/tokenize")) {
      state.tokenizeCalls.push({ url, body: JSON.parse(String(init.body)) });
      return state.cardError ? json(400, { success: false, error: state.cardError }) : json(200, { success: true, token: "tok-fake-1" });
    }
    const body = JSON.parse(String(init.body)) as Record<string, string>;
    state.calls.push({ action: body.action, body, headers: new Headers(init.headers) });
    const scripted = state.next[body.action]?.shift();
    if (scripted) return json(scripted.status, scripted.body);

    switch (body.action) {
      case "start":
        return json(200, { sessionId: `fake|s${++state.sessions}` });
      case "dates":
        return json(200, { dates: state.dates });
      case "times":
        return json(200, { times: (state.times[body.date] ?? []).filter((t) => !state.taken.has(t.id)) });
      case "hold":
        if (state.taken.has(body.slotId)) return error(409, "SLOT_UNAVAILABLE", "Time is no longer available, please select another.");
        state.taken.add(body.slotId);
        return json(200, {
          start: Object.values(state.times).flat().find((t) => t.id === body.slotId)!.start,
          expiresAt: "2026-11-24T15:30:00.000Z", // 30 minutes after the tests' fixed "now"
        });
      case "summary":
        return json(200, { hold: state.hold });
      case "checkout": {
        const key = body.idempotencyKey;
        state.bookings[key] ??= { bookingId: `bk${Object.keys(state.bookings).length + 1}`, start: state.hold!.start };
        return json(200, state.bookings[key]);
      }
      default:
        return error(400, "INVALID_REQUEST", "Bad request");
    }
  });

  return { state, error: (status: number, code: string, message = "Scripted error") => ({ status, body: { error: { code, message } } }) };
}
