import { Navigate } from "react-router";
import { useLocations, useTreatments } from "../lib/catalog";
import { stepUrl, useFunnel } from "./funnel";

// Placeholder until step 3, when the availability edge function returns real slots.
export function SlotStep() {
  const treatments = useTreatments();
  const locations = useLocations();
  const { params } = useFunnel();

  if (!params.service) return <Navigate to={stepUrl("services", {})} replace />;
  if (!params.location) return <Navigate to={stepUrl("location", params)} replace />;

  const treatment = treatments.data?.find((t) => t.slug === params.service);
  const location = locations.data?.find((l) => l.slug === params.location);
  // Same guards as earlier steps: an unknown slug (old link, typo) goes back to where it's chosen.
  if (treatments.isSuccess && !treatment) return <Navigate to={stepUrl("services", {})} replace />;
  if (locations.isSuccess && !location) return <Navigate to={stepUrl("location", { service: params.service })} replace />;

  return (
    <>
      <h1>Pick a time</h1>
      <p className="muted">
        {treatment?.name} at {location?.name}
        {location && ` · times shown in ${location.timezone}`}
      </p>
      <div className="card">
        <p>Available times come from the booking vendor in step 3.</p>
      </div>
    </>
  );
}
