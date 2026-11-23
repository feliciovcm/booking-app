/**
 * Turns what a visitor types into E.164, which the booking vendor requires.
 * US-first: 10 digits get +1. Anything starting with + is kept as typed (digits only).
 * Returns null when it can't be a phone number.
 */
export function toE164(input: string): string | null {
  const trimmed = input.trim();
  const digits = trimmed.replace(/\D/g, "");
  const e164 = trimmed.startsWith("+")
    ? `+${digits}`
    : digits.length === 10
      ? `+1${digits}`
      : digits.length === 11 && digits.startsWith("1")
        ? `+${digits}`
        : null;
  return e164 && /^\+[1-9]\d{6,14}$/.test(e164) ? e164 : null;
}
