import type { UseQueryResult } from "@tanstack/react-query";

// Shared loading and error UI, so every step handles both the same way.
export function QueryState({ query, label }: { query: UseQueryResult<unknown>; label: string }) {
  if (query.isPending) return <p className="muted">Loading {label}…</p>;
  if (query.isError)
    return (
      <div className="error" role="alert">
        <p>We couldn't load {label}. Check your connection and try again.</p>
        <button type="button" onClick={() => query.refetch()}>
          Try again
        </button>
      </div>
    );
  return null;
}
