import { z } from "zod";
import { SUPABASE_URL } from "../lib/supabase";
import { cardNumberLength, cvcLength } from "../utils/card";

// The one place the browser talks to the booking vendor directly. Card data must go
// straight to the vendor's Tokenization API: if it passed through our function, we'd be
// in PCI DSS scope. Only the token it returns reaches our server.
//
// Boulevard: https://pci.boulevard.app/cards/tokenize (sandbox: https://vault-sandbox.joinblvd.com/cards/tokenize).
// The demo defaults to the mock's copy of that endpoint.
const TOKENIZE_URL =
  (import.meta.env.VITE_CARD_TOKENIZE_URL as string | undefined) ?? `${SUPABASE_URL}/functions/v1/mock-boulevard/cards/tokenize`;

const digits = (value: string) => value.replace(/\D/g, "");

/** Valid through the last day of its month, like the vendor counts it. */
function notExpired(expiry: string, now = new Date()): boolean {
  const [month, year] = expiry.split("/").map(Number);
  return (2000 + year) * 12 + month - 1 >= now.getFullYear() * 12 + now.getMonth();
}

/** The card form, checked before anything leaves the browser. The vendor checks it again. */
export const cardSchema = z
  .object({
    cardName: z.string().trim().min(1, "Enter the name on the card"),
    // The fields already keep digits only and stop at the right length; these catch a short entry.
    cardNumber: z
      .string()
      .transform(digits)
      .superRefine((number, ctx) => {
        if (!number) ctx.addIssue({ code: "custom", message: "Enter the card number" });
        else if (number.length !== cardNumberLength(number)) ctx.addIssue({ code: "custom", message: `Enter all ${cardNumberLength(number)} digits` });
      }),
    cardExpiry: z
      .string()
      .trim()
      .regex(/^(0[1-9]|1[0-2])\/\d{2}$/, "Use MM/YY")
      .refine(notExpired, "This card has expired"),
    cardCvc: z.string().trim(),
    postalCode: z.string().trim().min(3, "Enter the billing ZIP code"),
  })
  .superRefine((card, ctx) => {
    const length = cvcLength(card.cardNumber);
    if (!new RegExp(`^\\d{${length}}$`).test(card.cardCvc)) ctx.addIssue({ code: "custom", path: ["cardCvc"], message: `Enter the ${length}-digit code` });
  });
export type CardInput = z.infer<typeof cardSchema>;

/** The tokenizer refused the card, or couldn't be reached. The message is safe to show. */
export class CardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CardError";
  }
}

export async function tokenizeCard(card: CardInput): Promise<string> {
  const [month, year] = card.cardExpiry.split("/").map((part) => Number(part.trim()));
  let res: Response;
  try {
    res = await fetch(TOKENIZE_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        card: {
          name: card.cardName,
          number: card.cardNumber,
          cvv: card.cardCvc,
          exp_month: month,
          exp_year: 2000 + year,
          address_postal_code: card.postalCode,
        },
      }),
    });
  } catch {
    throw new CardError("We couldn't reach the card service. Check your connection and try again.");
  }
  const json = (await res.json().catch(() => null)) as { success?: boolean; token?: string; error?: string } | null;
  if (!res.ok || !json?.success || !json.token) {
    // Boulevard doesn't document its error body; the mock sends { error }.
    throw new CardError(json?.error ? `We couldn't use this card: ${json.error.toLowerCase()}.` : "We couldn't verify this card. Check the details and try again.");
  }
  return json.token;
}
