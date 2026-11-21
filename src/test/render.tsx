import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import App from "../App";

// Renders the real routes at a URL, with a fresh query cache and no retries,
// and exposes the current URL so tests can assert on navigation.
export function renderAt(url: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[url]}>
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
