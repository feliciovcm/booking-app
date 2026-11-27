// Helpers for building PostgREST filters safely.

/**
 * Text for `ilike` that matches itself only. `%` and `_` are wildcards and `_` is common in
 * emails, so `first_last@x.com` would also match `firstXlast@x.com` without this.
 */
export const likeLiteral = (text: string) => text.replace(/[\\%_]/g, "\\$&");
