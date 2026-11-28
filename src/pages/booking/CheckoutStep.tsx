import { useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate } from "react-router";
import { z } from "zod";
import { BookingApiError } from "../../api/booking";
import { CardError, cardSchema, tokenizeCard } from "../../api/cards";
import { Field } from "../../components/Field";
import { MaskedField } from "../../components/MaskedField";
import { QueryState } from "../../components/QueryState";
import { useBookingSession, useCheckout, useHoldSummary } from "../../hooks/booking";
import { useLocations, useTreatments } from "../../hooks/catalog";
import { useFunnel } from "../../hooks/funnel";
import { stepUrl } from "../../routes/funnel";
import { formatCardNumber, formatCvc, formatExpiry } from "../../utils/card";
import { toE164 } from "../../utils/phone";
import { formatDay, formatTime, minutesUntil, todayIn } from "../../utils/time";

const contactSchema = z.object({
  firstName: z.string().trim().min(1, "Enter your first name").max(100),
  lastName: z.string().trim().min(1, "Enter your last name").max(100),
  email: z.email("Enter a valid email").max(254),
  phone: z
    .string()
    .trim()
    .transform((value, ctx) => {
      if (!value) return undefined; // optional
      const e164 = toE164(value);
      if (!e164) ctx.addIssue({ code: "custom", message: "Enter a phone number like (212) 555-0123" });
      return e164 ?? undefined;
    }),
});
const formSchema = contactSchema.and(cardSchema);
type FieldErrors = Partial<Record<string, string>>;

export function CheckoutStep() {
  const treatments = useTreatments();
  const locations = useLocations();
  const { params } = useFunnel();
  const navigate = useNavigate();

  const treatment = treatments.data?.find((t) => t.slug === params.service);
  const location = locations.data?.find((l) => l.slug === params.location);
  const session = useBookingSession(treatment?.slug, location?.slug);
  const summary = useHoldSummary(session);
  const checkout = useCheckout(session, params.service ?? "", params.location ?? "");

  const [errors, setErrors] = useState<FieldErrors>({});
  const [cardError, setCardError] = useState<string | null>(null);
  const [tokenizing, setTokenizing] = useState(false);

  if (!params.service) return <Navigate to={stepUrl("services", {})} replace />;
  if (!params.location) return <Navigate to={stepUrl("location", params)} replace />;
  if (treatments.isSuccess && !treatment) return <Navigate to={stepUrl("services", {})} replace />;
  if (locations.isSuccess && !location) return <Navigate to={stepUrl("location", { service: params.service })} replace />;

  const timeZone = location?.timezone ?? "UTC";
  const pickTime = stepUrl("slot", params);
  const busy = tokenizing || checkout.isPending;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const parsed = formSchema.safeParse(Object.fromEntries(new FormData(event.currentTarget)));
    if (!parsed.success) {
      const fieldErrors = z.flattenError(parsed.error).fieldErrors as Record<string, string[] | undefined>;
      setErrors(Object.fromEntries(Object.entries(fieldErrors).map(([k, v]) => [k, v?.[0]])));
      return;
    }
    setErrors({});
    setCardError(null);
    checkout.reset();
    const { firstName, lastName, email, phone, ...card } = parsed.data;

    // 1. Card -> the vendor's tokenizer, straight from the browser. Card data stops here.
    let cardToken: string;
    setTokenizing(true);
    try {
      cardToken = await tokenizeCard(card);
    } catch (error) {
      setCardError(error instanceof CardError ? error.message : "We couldn't verify this card. Please try again.");
      return;
    } finally {
      setTokenizing(false);
    }

    // 2. Token + contact details -> our booking function.
    checkout.mutate(
      { client: { firstName, lastName, email, ...(phone ? { phone } : {}) }, cardToken },
      {
        // The email rides in router state (for "See it in My bookings"), never in the URL.
        onSuccess: (booking) =>
          navigate(`/book/confirmed?${new URLSearchParams({ service: params.service!, location: params.location!, at: booking.start })}`, {
            state: { email },
          }),
      },
    );
  }

  const hold = summary.data;
  return (
    <>
      <h1>Confirm your booking</h1>
      <p className="muted">
        {treatment?.name} at {location?.name}
      </p>

      {session.isSuccess ? <QueryState query={summary} label="your held time" /> : <QueryState query={session} label="your booking" />}

      {hold === null && (
        <div className="card" role="alert">
          <p>Your hold on this time ran out, or no time was picked yet.</p>
          <Link to={pickTime} className="button secondary">
            Pick a time
          </Link>
        </div>
      )}

      {hold && (
        <>
          <section className="card highlight">
            <p className="eyebrow">Held for you</p>
            <h2>
              {formatDay(todayIn(timeZone, new Date(hold.start)))} at {formatTime(hold.start, timeZone)}
            </h2>
            <p className="muted">We'll keep it for {minutesUntil(hold.expiresAt)} more minutes.</p>
          </section>

          <form className="form" onSubmit={onSubmit} noValidate aria-label="Checkout">
            <h2>Your details</h2>
            <Field name="firstName" label="First name" autoComplete="given-name" error={errors.firstName} />
            <Field name="lastName" label="Last name" autoComplete="family-name" error={errors.lastName} />
            <Field name="email" label="Email" type="email" autoComplete="email" error={errors.email} />
            <Field name="phone" label="Mobile phone (optional)" type="tel" autoComplete="tel" error={errors.phone} />

            <h2>Card on file</h2>
            <p className="muted small">
              $0 due today. Your card secures the booking. It goes straight to our booking provider's secure vault, so we never see the number.
            </p>
            {/* autoComplete off: this is a demo, a saved real card must not fill in by accident. */}
            <Field name="cardName" label="Name on card" autoComplete="off" error={errors.cardName} />
            <MaskedField name="cardNumber" label="Card number" format={formatCardNumber} autoComplete="off" placeholder="4242 4242 4242 4242" error={errors.cardNumber} />
            <MaskedField name="cardExpiry" label="Expiry" format={formatExpiry} autoComplete="off" placeholder="MM/YY" error={errors.cardExpiry} />
            <MaskedField name="cardCvc" label="CVC" format={(value, input) => formatCvc(value, cardNumberIn(input))} autoComplete="off" placeholder="123" error={errors.cardCvc} />
            <Field name="postalCode" label="Billing ZIP code" autoComplete="off" error={errors.postalCode} />

            {cardError && (
              <p className="error" role="alert">
                {cardError}
              </p>
            )}
            {checkout.isError && <CheckoutProblem error={checkout.error} pickTime={pickTime} />}

            <button type="submit" className="button" disabled={busy}>
              {busy ? "Booking…" : "Book"}
            </button>
          </form>
        </>
      )}
    </>
  );
}

/** The card number typed in the same form, so the CVC knows its length (Amex has 4 digits). */
const cardNumberIn = (input: HTMLInputElement) => (input.form?.elements.namedItem("cardNumber") as HTMLInputElement | null)?.value ?? "";

// The server's message is written for visitors. When the time is gone, the way forward is a new time.
function CheckoutProblem({ error, pickTime }: { error: Error; pickTime: string }) {
  const code = error instanceof BookingApiError ? error.code : "UNKNOWN";
  return (
    <div className="error" role="alert">
      <p>{error.message}</p>
      {(code === "SLOT_UNAVAILABLE" || code === "SESSION_EXPIRED") && <Link to={pickTime}>Pick another time</Link>}
    </div>
  );
}
