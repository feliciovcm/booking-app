// A fake of supabase.auth for the email-code sign-in: the methods our app calls, with the
// same result shapes ({ data, error }). One shared instance; call reset() in beforeEach.
// Use it in a test's vi.mock of lib/supabase: `auth: (await import("../helpers/fake-auth")).fakeAuth`.

type Session = { access_token: string; user: { id: string; email: string } };
type Listener = (event: string, session: Session | null) => void;

const state = {
  session: null as Session | null,
  /** Emails a code was sent to, in order. */
  codesSentTo: [] as string[],
  /** The code that works. Anything else is "wrong or expired". */
  validCode: "123456",
  /** Set to make the next signInWithOtp fail like Supabase's rate limit. */
  rateLimited: false,
  listeners: new Set<Listener>(),
};

const emit = (event: string) => state.listeners.forEach((listener) => listener(event, state.session));

export const fakeAuth = {
  state,
  reset() {
    state.session = null;
    state.codesSentTo = [];
    state.rateLimited = false;
    state.listeners.clear();
  },
  /** Starts a test signed in, as if the session was restored from storage. */
  signInAs(email: string) {
    state.session = { access_token: `token-for-${email}`, user: { id: `u-${email}`, email } };
  },

  async getSession() {
    return { data: { session: state.session }, error: null };
  },
  onAuthStateChange(listener: Listener) {
    state.listeners.add(listener);
    return { data: { subscription: { unsubscribe: () => state.listeners.delete(listener) } } };
  },
  async signInWithOtp({ email }: { email: string }) {
    if (state.rateLimited) return { data: {}, error: { status: 429, code: "over_email_send_rate_limit", message: "email rate limit exceeded" } };
    state.codesSentTo.push(email);
    return { data: {}, error: null };
  },
  async verifyOtp({ email, token }: { email: string; token: string; type: string }) {
    if (token !== state.validCode) return { data: { session: null, user: null }, error: { status: 403, code: "otp_expired", message: "Token has expired or is invalid" } };
    fakeAuth.signInAs(email);
    emit("SIGNED_IN");
    return { data: { session: state.session, user: state.session!.user }, error: null };
  },
  async signOut() {
    state.session = null;
    emit("SIGNED_OUT");
    return { error: null };
  },
};
