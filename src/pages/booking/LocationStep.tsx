import { Navigate } from "react-router";
import { useLocations, useTreatments } from "../../hooks/catalog";
import { QueryState } from "../../components/QueryState";
import { useFunnel } from "../../hooks/funnel";
import { stepUrl } from "../../routes/funnel";
import { formatPrice } from "../../utils/format";

export function LocationStep() {
  const treatments = useTreatments();
  const locations = useLocations();
  const { params, goTo } = useFunnel();

  // A missing or unknown ?service= (old link, typo) sends the visitor back to pick one.
  if (!params.service) return <Navigate to={stepUrl("services", {})} replace />;
  const treatment = treatments.data?.find((t) => t.slug === params.service);
  if (treatments.isSuccess && !treatment) return <Navigate to={stepUrl("services", {})} replace />;

  return (
    <>
      <h1>Choose a studio</h1>
      {treatment && (
        <p className="muted">
          {treatment.name} · {formatPrice(treatment.price_cents)}/session
        </p>
      )}

      <QueryState query={locations} label="studios" />
      <ul className="options">
        {locations.data?.map((l) => (
          <li key={l.id}>
            <button
              type="button"
              className={`option${params.location === l.slug ? " selected" : ""}`}
              onClick={() => goTo("slot", { location: l.slug, date: undefined })}
            >
              <span className="option-title">{l.name}</span>
              <span className="muted">{l.address}</span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
