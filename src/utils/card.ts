// How card numbers are printed, by brand: the digits each group holds.
// Amex is 4-6-5 (15 digits), Diners 4-6-4 (14), everything else 4-4-4-4 (16).
// Trade-off: 19-digit cards (some Maestro and UnionPay) aren't accepted.
const AMEX = [4, 6, 5];
const DINERS = [4, 6, 4];
const DEFAULT = [4, 4, 4, 4];

function groupsFor(digits: string): number[] {
  if (/^3[47]/.test(digits)) return AMEX;
  if (/^3(0[0-5]|[68])/.test(digits)) return DINERS;
  return DEFAULT;
}

const onlyDigits = (value: string) => value.replace(/\D/g, "");

/** How many digits this card number should have, from its first digits. */
export const cardNumberLength = (value: string) => groupsFor(onlyDigits(value)).reduce((a, b) => a + b, 0);

/** Keeps digits only, cuts at the brand's length, and groups them: "4242424242424242" -> "4242 4242 4242 4242". */
export function formatCardNumber(value: string): string {
  const digits = onlyDigits(value);
  const groups = groupsFor(digits);
  const parts: string[] = [];
  let at = 0;
  for (const size of groups) {
    if (at >= digits.length) break;
    parts.push(digits.slice(at, at + size));
    at += size;
  }
  return parts.join(" ");
}

/** Where the caret goes in the formatted value so it stays after the same number of digits. */
export function caretAfterDigits(formatted: string, digitCount: number): number {
  if (digitCount === 0) return 0;
  let seen = 0;
  for (let i = 0; i < formatted.length; i++) {
    if (/\d/.test(formatted[i]) && ++seen === digitCount) return i + 1;
  }
  return formatted.length;
}

/**
 * Expiry as MM/YY. Digits only, at most 4. A first digit of 2 to 9 can only be a month
 * like 02 to 09, so it gets its leading zero. The slash appears once there's a year digit,
 * so backspace never fights an auto-inserted slash.
 */
export function formatExpiry(value: string): string {
  let digits = onlyDigits(value).slice(0, 4);
  if (/^[2-9]/.test(digits)) digits = `0${digits}`.slice(0, 4);
  return digits.length > 2 ? `${digits.slice(0, 2)}/${digits.slice(2)}` : digits;
}

/** How many digits the security code has: 4 on the front of an Amex, 3 on the back of the rest. */
export const cvcLength = (cardNumber: string) => (/^3[47]/.test(onlyDigits(cardNumber)) ? 4 : 3);

/** The security code: digits only, cut at the card's length. */
export const formatCvc = (value: string, cardNumber: string) => onlyDigits(value).slice(0, cvcLength(cardNumber));
