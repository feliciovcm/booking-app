// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createAutomations, type AutomationEvent } from "./automations.ts";
import { createLogger } from "./log.ts";

const EVENT: AutomationEvent = {
  type: "booking.cancelled",
  bookingId: "b1",
  location: "noho",
  treatment: "prp",
  start: "2026-11-25T15:00:00.000Z",
};

function setup(respond: (req: Request) => Promise<Response> = async () => new Response(null, { status: 200 })) {
  const requests: Request[] = [];
  const logs: string[] = [];
  const log = createLogger("test", "r1", { log: (l) => logs.push(l), warn: (l) => logs.push(l), error: (l) => logs.push(l) });
  const automations = createAutomations({
    url: "https://n8n.example/webhook/booking",
    secret: "shared-secret-value",
    fetch: async (input, init) => {
      const req = new Request(input, init);
      requests.push(req.clone());
      return respond(req);
    },
    now: () => new Date("2026-11-24T12:00:00Z"),
  });
  return { automations, requests, logs, log };
}

describe("automations forward", () => {
  it("POSTs the event with the shared secret, an id and the send time", async () => {
    const { automations, requests, log } = setup();
    await automations.send(EVENT, log);

    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe("POST");
    expect(requests[0].headers.get("x-automations-secret")).toBe("shared-secret-value");
    expect(await requests[0].json()).toEqual({ id: expect.any(String), sentAt: "2026-11-24T12:00:00.000Z", ...EVENT });
  });

  it("does nothing when no URL is configured, so n8n stays optional", async () => {
    let called = false;
    const automations = createAutomations({ fetch: async () => ((called = true), new Response()) });
    await automations.send(EVENT, createLogger("test", "r1", { log() {}, warn() {}, error() {} }));
    expect(called).toBe(false);
  });

  it("refuses a URL without a secret", () => {
    expect(() => createAutomations({ url: "https://n8n.example/webhook/booking" })).toThrow("AUTOMATIONS_SECRET");
  });

  it("tries once and logs a failure instead of throwing, without leaking the secret", async () => {
    for (const respond of [async () => new Response(null, { status: 500 }), async (): Promise<Response> => Promise.reject(new TypeError("fetch failed"))]) {
      const { automations, requests, logs, log } = setup(respond);
      await expect(automations.send(EVENT, log)).resolves.toBeUndefined();
      expect(requests).toHaveLength(1);
      expect(logs.join("\n")).toContain('"msg":"automation not delivered"');
      expect(logs.join("\n")).not.toContain("shared-secret-value");
    }
  });
});
