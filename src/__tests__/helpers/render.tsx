import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import App from "../../App";

// Renders the real routes at a URL, with a fresh query cache and no retries,
// and exposes the current URL so tests can assert on navigation. `state` is router
// state, as a <Link state> or navigate(..., { state }) would pass it.
export function renderAt(url: string, state?: unknown) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const at = url.indexOf("?"); // the first "?" only: a ?next= value can contain its own
  const [pathname, search] = at === -1 ? [url, ""] : [url.slice(0, at), url.slice(at)];
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[{ pathname, search, state }]}>
        <App />
        <Routes>
          <Route path="*" element={<CurrentUrl />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function CurrentUrl() {
  const { pathname, search } = useLocation();
  return <output data-testid="url">{pathname + search}</output>;
}
