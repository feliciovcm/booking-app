import { describe, expect, it } from "vitest";
import { toE164 } from "../../utils/phone";

describe("toE164", () => {
  it("turns US numbers as people type them into E.164", () => {
    expect(toE164("(212) 555-0123")).toBe("+12125550123");
    expect(toE164("212.555.0123")).toBe("+12125550123");
    expect(toE164("1 212 555 0123")).toBe("+12125550123");
  });

  it("keeps international numbers that start with +", () => {
    expect(toE164("+44 20 7946 0958")).toBe("+442079460958");
  });

  it("refuses what can't be a phone number", () => {
    expect(toE164("555")).toBeNull();
    expect(toE164("+0 123 456")).toBeNull();
    expect(toE164("")).toBeNull();
  });
});
