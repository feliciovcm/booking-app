import { Link, Outlet, useLocation, useNavigate } from "react-router";
import { FUNNEL_STEPS, stepIndex, type FunnelStep } from "./funnel";

export function BookingLayout() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const step = pathname.split("/").pop() as FunnelStep;
  const index = stepIndex(step);
  const progress = index >= 0 ? ((index + 1) / FUNNEL_STEPS.length) * 100 : 100;

  return (
    <div className="shell">
      <header className="header">
        {index > 0 || index === -1 ? (
          <button type="button" className="back" onClick={() => navigate(-1)} aria-label="Go back">
            ←
          </button>
        ) : (
          <span className="back" />
        )}
        <Link to="/book/services" className="brand">
          Great Many <small>demo</small>
        </Link>
        <span className="back" />
      </header>
      <div className="progress" role="progressbar" aria-valuenow={Math.round(progress)} aria-valuemin={0} aria-valuemax={100}>
        <div style={{ width: `${progress}%` }} />
      </div>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
