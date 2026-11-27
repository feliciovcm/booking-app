import { useState } from "react";
import { Link, Navigate } from "react-router";
import type { MyBooking } from "../../api/myBookings";
import { QueryState } from "../../components/QueryState";
import { useSession } from "../../hooks/auth";
import { useMyBookings } from "../../hooks/myBookings";
import { formatDay, formatTime, todayIn } from "../../utils/time";

export function MyBookingsPage() {
  const { session, loading } = useSession();
  const query = useMyBookings(session?.user.id);
  // "Now" for upcoming vs past, read once on mount: render must not depend on the clock.
  const [now] = useState(() => Date.now());

  if (loading) return null;
  if (!session) return <Navigate to={`/sign-in?next=${encodeURIComponent("/my-bookings")}`} replace />;

  const bookings = query.data?.bookings ?? [];
  const upcoming = bookings.filter((b) => b.status === "confirmed" && Date.parse(b.start) >= now);
  const rest = bookings.filter((b) => !upcoming.includes(b)).reverse(); // most recent first

  return (
    <section>
      <h1>My bookings</h1>
      <QueryState query={query} label="your bookings" />
      {query.data?.claimFailed && (
        <p className="muted small" role="status">
          Bookings you made before signing in may be missing. Refresh to try again.
        </p>
      )}
      {query.isSuccess && bookings.length === 0 && (
        <div className="card">
          <p>No bookings yet. Ones you make with this email will show up here.</p>
          <Link className="button" to="/book/services">
            Book a treatment
          </Link>
        </div>
      )}
      {upcoming.length > 0 && <BookingList title="Upcoming" bookings={upcoming} />}
      {rest.length > 0 && <BookingList title="Past and cancelled" bookings={rest} />}
    </section>
  );
}

function BookingList({ title, bookings }: { title: string; bookings: MyBooking[] }) {
  const id = `bookings-${title.toLowerCase().replace(/\W+/g, "-")}`;
  return (
    <section aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      <ul className="options">
        {bookings.map((b) => (
          <li key={b.id} className="card">
            <p>
              <strong>
                {formatDay(todayIn(b.timeZone, new Date(b.start)))} at {formatTime(b.start, b.timeZone)}
              </strong>
            </p>
            <p className="muted">
              {b.treatment ?? "Treatment"} at {b.location ?? "our clinic"}
            </p>
            {b.status === "cancelled" && <p className="eyebrow">Cancelled</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}
