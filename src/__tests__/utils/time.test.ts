import { describe, expect, it } from "vitest";
import { addDays, formatDay, formatTime, todayIn } from "../../utils/time";

describe("time helpers", () => {
  it("uses the clinic's date, not the visitor's", () => {
    const lateEvening = new Date("2026-11-25T03:30:00Z"); // 10:30 PM on the 24th in New York
    expect(todayIn("America/New_York", lateEvening)).toBe("2026-11-24");
    expect(todayIn("Asia/Tokyo", lateEvening)).toBe("2026-11-25");
  });

  it("adds days across month and year ends", () => {
    expect(addDays("2026-11-24", 13)).toBe("2026-12-07");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("formats a calendar day without shifting it", () => {
    expect(formatDay("2026-11-25")).toBe("Wed, Nov 25");
  });

  it("formats a time in the clinic's zone, across daylight saving", () => {
    expect(formatTime("2026-11-25T14:00:00.000Z", "America/New_York")).toBe("9:00 AM");
    expect(formatTime("2026-07-15T13:00:00.000Z", "America/New_York")).toBe("9:00 AM");
    expect(formatTime("2026-11-25T14:00:00.000Z", "America/Los_Angeles")).toBe("6:00 AM");
  });
});
