import { Link, useLocation } from "react-router";
import { useSession, useSignOut } from "../hooks/auth";

/** The header's right slot: sign in (and come back here), or My bookings and sign out. */
export function AuthNav() {
  const { pathname, search } = useLocation();
  const { session, loading } = useSession();
  const signOut = useSignOut();

  if (loading) return <span className="header-action" />;
  if (!session) {
    return (
      <Link className="header-action" to={`/sign-in?next=${encodeURIComponent(pathname + search)}`}>
        Sign in
      </Link>
    );
  }
  return (
    <span className="header-actions">
      <Link className="header-action" to="/my-bookings">
        My bookings
      </Link>
      <button className="header-action" type="button" onClick={() => signOut.mutate()} disabled={signOut.isPending}>
        Sign out
      </button>
    </span>
  );
}
