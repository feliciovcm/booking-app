import { describe, expect, it } from "vitest";
import { caretAfterDigits, cardNumberLength, cvcLength, formatCardNumber, formatCvc, formatExpiry } from "../../utils/card";

describe("formatCardNumber", () => {
  it("keeps digits only and groups them in fours", () => {
    expect(formatCardNumber("4242abc4242-4242 4242")).toBe("4242 4242 4242 4242");
    expect(formatCardNumber("42424")).toBe("4242 4");
    expect(formatCardNumber("letters")).toBe("");
  });

  it("stops at the brand's length", () => {
    expect(formatCardNumber("42424242424242429999")).toBe("4242 4242 4242 4242");
    expect(formatCardNumber("378282246310005999")).toBe("3782 822463 10005"); // Amex: 4-6-5
    expect(formatCardNumber("3056930902590499")).toBe("3056 930902 5904"); // Diners: 4-6-4
  });

  it("knows how many digits each brand has", () => {
    expect(cardNumberLength("4242")).toBe(16);
    expect(cardNumberLength("37")).toBe(15);
    expect(cardNumberLength("36")).toBe(14);
  });
});

describe("formatExpiry", () => {
  it("writes MM/YY from digits, adding the slash once there's a year digit", () => {
    expect(formatExpiry("1")).toBe("1");
    expect(formatExpiry("12")).toBe("12");
    expect(formatExpiry("123")).toBe("12/3");
    expect(formatExpiry("12/30")).toBe("12/30");
    expect(formatExpiry("12a30999")).toBe("12/30");
  });

  it("adds the leading zero a month like 2 to 9 needs", () => {
    expect(formatExpiry("4")).toBe("04");
    expect(formatExpiry("430")).toBe("04/30");
  });
});

describe("formatCvc", () => {
  it("keeps 3 digits, or 4 for an Amex", () => {
    expect(formatCvc("12a345", "4242 4242 4242 4242")).toBe("123");
    expect(formatCvc("12345", "3782 822463 10005")).toBe("1234");
    expect(cvcLength("")).toBe(3);
  });
});

it("puts the caret back after the same digit", () => {
  expect(caretAfterDigits("4242 4242", 4)).toBe(4);
  expect(caretAfterDigits("4242 4242", 5)).toBe(6); // past the space
  expect(caretAfterDigits("12/30", 3)).toBe(4);
  expect(caretAfterDigits("4242", 0)).toBe(0);
});
