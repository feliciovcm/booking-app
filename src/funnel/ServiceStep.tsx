import { Link } from "react-router";
import { formatPrice, useTreatments } from "../lib/catalog";
import { QueryState } from "./QueryState";
import { useFunnel } from "./funnel";

export function ServiceStep() {
  const treatments = useTreatments();
  const { params, goTo } = useFunnel();

  return (
    <>
      <section className="card highlight">
        <p className="eyebrow">Most popular · Free</p>
        <h2>Free consultation</h2>
        <p className="muted">FollicleScan scalp analysis with a clinician. Every treatment starts here.</p>
        <Link to="/book/call" className="button secondary">
          Prefer to talk? Free 15-min call
        </Link>
      </section>

      <h1>Book a treatment</h1>
      <QueryState query={treatments} label="treatments" />

      <ul className="options">
        {treatments.data?.map((t) => (
          <li key={t.id}>
            <button
              type="button"
              className={`option${params.service === t.slug ? " selected" : ""}`}
              onClick={() => goTo("location", { service: t.slug })}
            >
              <span className="option-title">{t.name}</span>
              <span className="option-meta">
                {formatPrice(t.price_cents)}/session · {t.session_count} sessions
              </span>
              <span className="muted">{t.description}</span>
            </button>
          </li>
        ))}
      </ul>

      <p className="muted small">$0 due today · HSA/FSA accepted</p>
    </>
  );
}
