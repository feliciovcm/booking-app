const HOME = "/book/services";

/**
 * Where to go after sign-in, from an untrusted `?next=`. Only paths inside this app:
 * "//evil.example" and "/\evil.example" are read by browsers as other sites, so a bare
 * "starts with /" check would turn the sign-in page into an open redirect.
 */
export function safeNext(next: string | null): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return HOME;
  return next;
}
