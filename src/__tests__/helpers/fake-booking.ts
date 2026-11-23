import { vi } from "vitest";

// A fake of our `booking` edge function, installed as global fetch. It follows the same
// contract (actions, sessionId, error codes), records every call, and lets a test
// script the next response for an action.

type Reply = { status: number; body: unknown };

export function installFakeBooking() {
  const state = {
    calls: [] as { action: string; body: Record<string, string>; headers: Headers }[],
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

  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
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
      default:
        return error(400, "INVALID_REQUEST", "Bad request");
    }
  });

  return { state, error: (status: number, code: string, message = "Scripted error") => ({ status, body: { error: { code, message } } }) };
}
