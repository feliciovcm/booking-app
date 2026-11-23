import { Link, Navigate } from "react-router";
import { BookingApiError, useAvailableDates, useAvailableTimes, useBookingSession, useHold } from "../lib/booking";
import { useLocations, useTreatments } from "../lib/catalog";
import { addDays, formatDay, formatTime, todayIn } from "../lib/time";
import { QueryState } from "./QueryState";
import { stepUrl, useFunnel } from "./funnel";

const DAYS_SHOWN = 14;

export function SlotStep() {
  const treatments = useTreatments();
  const locations = useLocations();
  const { params, goTo } = useFunnel();

  const treatment = treatments.data?.find((t) => t.slug === params.service);
  const location = locations.data?.find((l) => l.slug === params.location);
  // Only start a vendor session for a real treatment at a real clinic.
  const session = useBookingSession(treatment?.slug, location?.slug);

  const timeZone = location?.timezone ?? "UTC";
  const from = todayIn(timeZone);
  const dates = useAvailableDates(session, from, addDays(from, DAYS_SHOWN - 1));
  const times = useAvailableTimes(session, params.date);
  const hold = useHold(session);

  if (!params.service) return <Navigate to={stepUrl("services", {})} replace />;
  if (!params.location) return <Navigate to={stepUrl("location", params)} replace />;
  // Same guards as earlier steps: an unknown slug (old link, typo) goes back to where it's chosen.
  if (treatments.isSuccess && !treatment) return <Navigate to={stepUrl("services", {})} replace />;
  if (locations.isSuccess && !location) return <Navigate to={stepUrl("location", { service: params.service })} replace />;

  const pickDate = (date: string) => {
    hold.reset();
    goTo("slot", { date }, { replace: true });
  };

  return (
    <>
      <h1>Pick a time</h1>
      <p className="muted">
        {treatment?.name} at {location?.name}
        {location && ` · times shown in ${location.timezone}`}
      </p>

      {session.isError ? (
        <BookingProblem error={session.error} retry={() => session.refetch()} />
      ) : (
        <QueryState query={session.isSuccess ? dates : session} label="available days" />
      )}

      {dates.data?.length === 0 && (
        <div className="card">
          <p>No openings in the next two weeks.</p>
          <Link to="/book/call" className="button secondary">
            Request a call instead
          </Link>
        </div>
      )}

      {dates.data && dates.data.length > 0 && (
        <ul className="chips" aria-label="Available days">
          {dates.data.map((date) => (
            <li key={date}>
              <button
                type="button"
                className={`chip${params.date === date ? " selected" : ""}`}
                aria-pressed={params.date === date}
                onClick={() => pickDate(date)}
              >
                {formatDay(date)}
              </button>
            </li>
          ))}
        </ul>
      )}

      {params.date && dates.data && (
        <>
          <QueryState query={times} label="times" />
          {times.data?.length === 0 && <p className="muted">No times left on {formatDay(params.date)}. Try another day.</p>}
          {times.data && times.data.length > 0 && (
            <ul className="times" aria-label={`Times on ${formatDay(params.date)}`}>
              {times.data.map((slot) => (
                <li key={slot.id}>
                  <button
                    type="button"
                    className={`chip${hold.variables === slot.id ? " selected" : ""}`}
                    disabled={hold.isPending}
                    onClick={() => hold.mutate(slot.id)}
                  >
                    {formatTime(slot.start, timeZone)}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {hold.isPending && <p className="muted">Holding your time…</p>}
      {hold.isError && <BookingProblem error={hold.error} />}
      {hold.data && (
        <section className="card highlight" aria-live="polite">
          <p className="eyebrow">Held for you</p>
          <h2>
            {formatDay(params.date!)} at {formatTime(hold.data.start, timeZone)}
          </h2>
          {/* A duration, not a clock time: "until 3:58 AM" in the clinic's zone confuses visitors elsewhere. */}
          <p className="muted">We'll keep this time for you for {minutesUntil(hold.data.expiresAt)} minutes.</p>
          <button type="button" className="button" disabled title="Checkout comes in step 4">
            Continue
          </button>
        </section>
      )}
    </>
  );
}

const minutesUntil = (iso: string) => Math.max(1, Math.round((Date.parse(iso) - Date.now()) / 60_000));

// The server's message is written for visitors, so show it; add a way forward when there is one.
function BookingProblem({ error, retry }: { error: Error; retry?: () => void }) {
  const code = error instanceof BookingApiError ? error.code : "UNKNOWN";
  return (
    <div className="error" role="alert">
      <p>{error.message}</p>
      {code === "NOT_BOOKABLE" && <Link to="/book/call">Request a call instead</Link>}
      {retry && code !== "NOT_BOOKABLE" && (
        <button type="button" onClick={retry}>
          Try again
        </button>
      )}
    </div>
  );
}
