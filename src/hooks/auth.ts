import type { Session } from "@supabase/supabase-js";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { authApi } from "../api/auth";

/**
 * The current session, kept in sync with Supabase Auth (sign-in, sign-out, token refresh,
 * and other tabs). `loading` is true until the stored session has been read, so pages
 * don't flash "signed out" on a refresh.
 */
export function useSession(): { session: Session | null; loading: boolean } {
  const [state, setState] = useState<{ session: Session | null; loading: boolean }>({ session: null, loading: true });

  useEffect(() => {
    let active = true;
    authApi.session().then((session) => active && setState({ session, loading: false }));
    const unsubscribe = authApi.onChange((session) => active && setState({ session, loading: false }));
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  return state;
}

export const useSendCode = () => useMutation({ mutationFn: (email: string) => authApi.sendCode(email) });

export const useVerifyCode = () =>
  useMutation({ mutationFn: ({ email, code }: { email: string; code: string }) => authApi.verifyCode(email, code) });

export const useSignOut = () => useMutation({ mutationFn: () => authApi.signOut() });
