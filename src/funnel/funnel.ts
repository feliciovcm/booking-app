import { useNavigate, useSearchParams } from "react-router";

// The funnel's state lives in the URL (?service=prp&location=noho), not in React state:
// - deep links work, like Great Many's "Book PRP" button linking to ?service=prp
// - refresh and the back button keep the visitor's choices
// - analytics see the step and choices in the page URL

export const FUNNEL_STEPS = ["services", "location", "slot"] as const;
export type FunnelStep = (typeof FUNNEL_STEPS)[number];

export type FunnelParams = { service?: string; location?: string; date?: string };

const PARAM_KEYS = ["service", "location", "date"] as const;

export function readFunnelParams(searchParams: URLSearchParams): FunnelParams {
  const params: FunnelParams = {};
  for (const key of PARAM_KEYS) {
    const value = searchParams.get(key);
    if (value) params[key] = value;
  }
  return params;
}

export function stepUrl(step: FunnelStep, params: FunnelParams): string {
  const query = new URLSearchParams();
  for (const key of PARAM_KEYS) {
    const value = params[key];
    if (value) query.set(key, value);
  }
  const qs = query.toString();
  return `/book/${step}${qs ? `?${qs}` : ""}`;
}

export function stepIndex(step: FunnelStep): number {
  return FUNNEL_STEPS.indexOf(step);
}

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
