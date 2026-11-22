// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createLogger, requestIdFrom, timed, type Sink } from "./log.ts";

function memorySink() {
  const lines: { method: string; entry: Record<string, unknown> }[] = [];
  const sink: Sink = {
    log: (line: string) => lines.push({ method: "log", entry: JSON.parse(line) }),
    warn: (line: string) => lines.push({ method: "warn", entry: JSON.parse(line) }),
    error: (line: string) => lines.push({ method: "error", entry: JSON.parse(line) }),
  };
  return { sink, lines };
}

describe("createLogger", () => {
  it("writes one JSON object per line with the function name and request id", () => {
    const { sink, lines } = memorySink();
    createLogger("booking", "req-1", sink).info("cart created", { status: 200, ms: 41 });
    expect(lines).toEqual([
      { method: "log", entry: { level: "info", fn: "booking", requestId: "req-1", msg: "cart created", status: 200, ms: 41 } },
    ]);
  });

  it("sends each level to the matching console method, so Supabase shows the right severity", () => {
    const { sink, lines } = memorySink();
    const log = createLogger("booking", "req-1", sink);
    log.info("a");
    log.warn("b");
    log.error("c");
    expect(lines.map((l) => l.method)).toEqual(["log", "warn", "error"]);
  });

  it("redacts personal and secret fields, whatever their spelling", () => {
    const { sink, lines } = memorySink();
    createLogger("booking", "req-1", sink).info("client added", {
      email: "ana@example.com",
      phone_number: "+12125550100",
      firstName: "Ana",
      Authorization: "Bearer x",
      cartId: "urn:blvd:Cart:1",
    });
    expect(lines[0].entry).toMatchObject({
      email: "[redacted]",
      phone_number: "[redacted]",
      firstName: "[redacted]",
      Authorization: "[redacted]",
      cartId: "urn:blvd:Cart:1",
    });
    expect(JSON.stringify(lines)).not.toContain("ana@example.com");
  });

  it("doesn't let fields overwrite the standard keys, and drops undefined", () => {
    const { sink, lines } = memorySink();
    createLogger("booking", "req-1", sink).info("x", { requestId: "spoofed", level: "error", extra: undefined });
    expect(lines[0].entry).toEqual({ level: "info", fn: "booking", requestId: "req-1", msg: "x" });
  });
});

describe("requestIdFrom", () => {
  it("reuses a well-formed x-request-id and replaces anything else", () => {
    const req = (id?: string) => new Request("http://x", id ? { headers: { "x-request-id": id } } : {});
    expect(requestIdFrom(req("req_abc-123"))).toBe("req_abc-123");
    expect(requestIdFrom(req())).toMatch(/^[0-9a-f-]{36}$/);
    expect(requestIdFrom(req('evil"} {"level":"error'))).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("timed", () => {
  it("logs duration and success, and returns the result", async () => {
    const { sink, lines } = memorySink();
    const result = await timed(createLogger("booking", "req-1", sink), "boulevard createCart", async () => 42, { operation: "createCart" });
    expect(result).toBe(42);
    expect(lines[0].entry).toMatchObject({ level: "info", msg: "boulevard createCart", operation: "createCart", ok: true });
    expect(typeof lines[0].entry.ms).toBe("number");
  });

  it("logs the error's name and code but not its message, then rethrows", async () => {
    const { sink, lines } = memorySink();
    const failure = Object.assign(new Error("Invalid PhoneNumber: +12125550100"), { code: "CART_TIME_NOT_AVAILABLE" });
    await expect(timed(createLogger("booking", "req-1", sink), "boulevard reserve", async () => { throw failure; })).rejects.toBe(failure);
    expect(lines[0]).toMatchObject({ method: "error", entry: { ok: false, errorName: "Error", errorCode: "CART_TIME_NOT_AVAILABLE" } });
    expect(JSON.stringify(lines)).not.toContain("+12125550100");
  });
});
