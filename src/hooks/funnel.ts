import { useNavigate, useSearchParams } from "react-router";
import { readFunnelParams, stepUrl, type FunnelParams, type FunnelStep } from "../routes/funnel";

export function useFunnel() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const params = readFunnelParams(searchParams);

  return {
    params,
    goTo: (step: FunnelStep, patch: FunnelParams = {}, options?: { replace?: boolean }) =>
      navigate(stepUrl(step, { ...params, ...patch }), options),
  };
}
