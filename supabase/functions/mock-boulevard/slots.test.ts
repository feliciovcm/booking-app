// @vitest-environment node
import { describe, expect, it } from "vitest";
import { formatLocal, generateSlots, localToUtc, parseDate, parseTimeId, VENDOR_LOCATIONS } from "./slots.ts";

const NY = "America/New_York";
const NOHO = Object.keys(VENDOR_LOCATIONS)[0];
const wed = { year: 2026, month: 11, day: 25 };
const beforeAll = new Date("2026-11-01T00:00:00Z");

describe("time zone math", () => {
  it("turns New York wall time into the right instant, in and out of daylight saving", () => {
    expect(localToUtc(wed, 9 * 60, NY).toISOString()).toBe("2026-11-25T14:00:00.000Z");
    expect(localToUtc({ year: 2026, month: 7, day: 15 }, 9 * 60, NY).toISOString()).toBe("2026-07-15T13:00:00.000Z");
  });

  it("handles the days the clocks change", () => {
    expect(localToUtc({ year: 2026, month: 3, day: 8 }, 12 * 60, NY).toISOString()).toBe("2026-03-08T16:00:00.000Z");
    expect(localToUtc({ year: 2026, month: 11, day: 1 }, 12 * 60, NY).toISOString()).toBe("2026-11-01T17:00:00.000Z");
  });

  it("formats an instant as local time with its offset", () => {
    expect(formatLocal(new Date("2026-11-25T14:00:00Z"), NY)).toBe("2026-11-25T09:00:00-05:00");
    expect(formatLocal(new Date("2026-07-15T13:00:00Z"), NY)).toBe("2026-07-15T09:00:00-04:00");
  });

  it("rejects malformed and impossible dates", () => {
    expect(parseDate("2026-02-30")).toBeNull();
    expect(parseDate("2026-1-5")).toBeNull();
    expect(parseDate(null)).toBeNull();
    expect(parseDate("2026-02-28")).toEqual({ year: 2026, month: 2, day: 28 });
  });
});

describe("generateSlots", () => {
  it("offers hourly slots inside opening hours, with some already taken", () => {
    const slots = generateSlots(NOHO, wed, beforeAll);
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.length).toBeLessThan(9); // 9:00 to 17:00 is 9 slots before removing busy ones
    for (const slot of slots) {
      expect(slot.startTime).toMatch(/^2026-11-25T(09|1[0-7]):00:00-05:00$/);
      expect(slot.score).toBeGreaterThanOrEqual(0);
      expect(slot.score).toBeLessThan(1);
    }
  });

  it("gives each slot an opaque time id that maps back to the same instant", () => {
    const [slot] = generateSlots(NOHO, wed, beforeAll);
    expect(slot.id).toMatch(/^t_2026-11-25T\d\d:00:00$/);
    expect(parseTimeId(slot.id, NY)?.getTime()).toBe(slot.start.getTime());
    expect(parseTimeId("t_garbage", NY)).toBeNull();
  });

  it("returns the same slots every time for the same day", () => {
    expect(generateSlots(NOHO, wed, beforeAll)).toEqual(generateSlots(NOHO, wed, beforeAll));
  });

  it("uses shorter Saturday hours and is closed on Sunday", () => {
    const saturday = generateSlots(NOHO, { year: 2026, month: 11, day: 28 }, beforeAll);
    for (const slot of saturday) expect(slot.startTime).toMatch(/T(1[0-5]):00/);
    expect(generateSlots(NOHO, { year: 2026, month: 11, day: 29 }, beforeAll)).toEqual([]);
  });

  it("never offers a time that has already passed", () => {
    const now = new Date("2026-11-25T17:30:00Z"); // 12:30 in New York
    for (const slot of generateSlots(NOHO, wed, now)) expect(slot.start.getTime()).toBeGreaterThan(now.getTime());
  });

  it("knows nothing about unknown locations", () => {
    expect(generateSlots("urn:blvd:Location:nope", wed, beforeAll)).toEqual([]);
  });
});
