import type { Session } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";

// Sign-in with a code sent by email (Supabase Auth's email OTP). The same call signs up
// a new email, so there's no separate "create account" step.

export class AuthApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthApiError";
  }
}

export const authApi = {
  async sendCode(email: string) {
    const { error } = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
    if (!error) return;
    // Supabase's default email sender allows only a few emails an hour.
    if (error.status === 429) throw new AuthApiError("Too many codes requested. Wait a minute, then try again.");
    throw new AuthApiError("We couldn't send the code. Please try again.");
  },

  async verifyCode(email: string, code: string) {
    const { error } = await supabase.auth.verifyOtp({ email, token: code, type: "email" });
    if (error) throw new AuthApiError("That code is wrong or expired. Check the latest email, or send a new code.");
  },

  async signOut() {
    await supabase.auth.signOut();
  },

  async session(): Promise<Session | null> {
    const { data } = await supabase.auth.getSession();
    return data.session;
  },

  /** Calls back on sign-in, sign-out, token refresh and changes from other tabs. Returns an unsubscribe. */
  onChange(callback: (session: Session | null) => void): () => void {
    const { data } = supabase.auth.onAuthStateChange((_event, session) => callback(session));
    return () => data.subscription.unsubscribe();
  },

  /** The signed-in user's access token, for our own edge functions. Null when signed out. */
  async accessToken(): Promise<string | null> {
    return (await authApi.session())?.access_token ?? null;
  },
};
