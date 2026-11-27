// @vitest-environment node
import { describe, expect, it } from "vitest";
import { likeLiteral } from "./sql.ts";

describe("likeLiteral", () => {
  it("escapes ilike's wildcards and the escape character", () => {
    expect(likeLiteral("first_last%@x.com")).toBe("first\\_last\\%@x.com");
    expect(likeLiteral("back\\slash@x.com")).toBe("back\\\\slash@x.com");
  });

  it("leaves ordinary emails alone", () => {
    expect(likeLiteral("avery.quinn+test@example.com")).toBe("avery.quinn+test@example.com");
  });
});
