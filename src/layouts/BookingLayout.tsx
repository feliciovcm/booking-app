import { Link, Outlet, useLocation } from "react-router";
import { useFunnel } from "../hooks/funnel";
import { FUNNEL_STEPS, stepIndex, stepUrl, type FunnelStep } from "../routes/funnel";

export function BookingLayout() {
  const { pathname } = useLocation();
  const { params } = useFunnel();
  const step = pathname.split("/").pop() as FunnelStep;
  const index = stepIndex(step);
  const progress = index >= 0 ? ((index + 1) / FUNNEL_STEPS.length) * 100 : 100;

  // Back goes to the previous step, not browser history: a visitor who deep-linked in
  // (e.g. "Book PRP" on the marketing site) has no history here, and history(-1) would
  // take them off the app. Earlier choices stay in the URL, so the step shows them selected.
  // After booking there's nothing to go back to.
  const backTo =
    pathname.endsWith("/confirmed")
      ? null
      : index > 0 ? stepUrl(FUNNEL_STEPS[index - 1], params) : index === -1 ? stepUrl("services", params) : null;

  return (
    <div className="shell">
      <header className="header">
        {backTo ? (
          <Link to={backTo} className="back" aria-label="Go back">
            ←
          </Link>
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
