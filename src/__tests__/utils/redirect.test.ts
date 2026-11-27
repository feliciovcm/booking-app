import { describe, expect, it } from "vitest";
import { safeNext } from "../../utils/redirect";

describe("safeNext", () => {
  it("keeps paths inside the app, with their query", () => {
    expect(safeNext("/my-bookings")).toBe("/my-bookings");
    expect(safeNext("/book/slot?service=prp&location=noho")).toBe("/book/slot?service=prp&location=noho");
  });

  it("falls back to the start for anything that could leave the app", () => {
    for (const bad of [null, "", "my-bookings", "//evil.example", "/\\evil.example", "https://evil.example", "javascript:alert(1)"]) {
      expect(safeNext(bad)).toBe("/book/services");
    }
  });
});
