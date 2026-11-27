import { Link, Outlet } from "react-router";
import { AuthNav } from "../components/AuthNav";

/** Pages outside the funnel (sign-in, My bookings): the same header, no progress bar or back step. */
export function AccountLayout() {
  return (
    <div className="shell">
      <header className="header">
        <span className="back" />
        <Link to="/book/services" className="brand">
          Great Many <small>demo</small>
        </Link>
        <AuthNav />
      </header>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
