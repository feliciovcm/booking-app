import { describe, expect, it } from "vitest";
import { readFunnelParams, stepUrl } from "./funnel";

describe("funnel URL state", () => {
  it("builds step URLs with only the params that are set", () => {
    expect(stepUrl("services", {})).toBe("/book/services");
    expect(stepUrl("location", { service: "prp" })).toBe("/book/location?service=prp");
    expect(stepUrl("slot", { service: "prp", location: "noho" })).toBe("/book/slot?service=prp&location=noho");
  });

  it("reads known params and ignores unknown or empty ones", () => {
    const params = readFunnelParams(new URLSearchParams("service=prp&location=&utm_source=ig"));
    expect(params).toEqual({ service: "prp" });
  });
});
