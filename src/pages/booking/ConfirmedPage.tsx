import { Link, Navigate, useSearchParams } from "react-router";
import { useForgetBookingSession } from "../../hooks/booking";
import { useLocations, useTreatments } from "../../hooks/catalog";
import { formatDay, formatTime, todayIn } from "../../utils/time";

// The URL carries what this page shows (no personal data), so a refresh keeps it.
export function ConfirmedPage() {
  const [search] = useSearchParams();
  const service = search.get("service") ?? undefined;
  const slug = search.get("location") ?? undefined;
  const at = search.get("at");
  useForgetBookingSession(service, slug);

  const treatment = useTreatments().data?.find((t) => t.slug === service);
  const location = useLocations().data?.find((l) => l.slug === slug);

  if (!at || Number.isNaN(Date.parse(at))) return <Navigate to="/book/services" replace />;
  const timeZone = location?.timezone ?? "UTC";

  return (
    <section className="card highlight" role="status">
      <p className="eyebrow">You're booked</p>
      {location && (
        <h1>
          {formatDay(todayIn(timeZone, new Date(at)))} at {formatTime(at, timeZone)}
        </h1>
      )}
      <p>
        {treatment?.name} at {location?.name}
      </p>
      {location && <p className="muted">{location.address}</p>}
      <p className="muted">A confirmation email is on its way.</p>
      <Link to="/book/services" className="button secondary">
        Book another treatment
      </Link>
    </section>
  );
}
