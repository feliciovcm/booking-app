import { useState } from "react";
import { Navigate, useLocation, useNavigate, useSearchParams } from "react-router";
import { z } from "zod";
import { Field } from "../../components/Field";
import { useSendCode, useSession, useVerifyCode } from "../../hooks/auth";
import { safeNext } from "../../utils/redirect";

const emailSchema = z.email("Enter a valid email.");
// Supabase's code length is a project setting (6 by default), so accept what it may send.
const codeSchema = z.string().regex(/^\d{6,10}$/, "Enter the digits from the email.");

// Two steps: email, then the code we emailed. The email can arrive prefilled through
// router state (from the confirmation page), never through the URL.
export function SignInPage() {
  const [search] = useSearchParams();
  const next = safeNext(search.get("next"));
  const prefill = (useLocation().state as { email?: string } | null)?.email ?? "";
  const navigate = useNavigate();
  const { session, loading } = useSession();

  const [email, setEmail] = useState(prefill);
  const [step, setStep] = useState<"email" | "code">("email");
  const [fieldError, setFieldError] = useState<string>();
  const sendCode = useSendCode();
  const verifyCode = useVerifyCode();

  if (loading) return null;
  if (session && !verifyCode.isPending) return <Navigate to={next} replace />;

  const requestCode = (to: string) => {
    sendCode.mutate(to, { onSuccess: () => setStep("code") });
  };

  const onEmail = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const value = String(new FormData(e.currentTarget).get("email") ?? "").trim();
    const parsed = emailSchema.safeParse(value);
    if (!parsed.success) return setFieldError(parsed.error.issues[0].message);
    setFieldError(undefined);
    setEmail(parsed.data);
    requestCode(parsed.data);
  };

  const onCode = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const parsed = codeSchema.safeParse(String(new FormData(e.currentTarget).get("code") ?? "").trim());
    if (!parsed.success) return setFieldError(parsed.error.issues[0].message);
    setFieldError(undefined);
    verifyCode.mutate({ email, code: parsed.data }, { onSuccess: () => navigate(next, { replace: true }) });
  };

  // Each step gets its own key: both render section > form > input, and without a key React
  // would reuse the email <input> for the code, keeping the typed email in the code box.
  if (step === "email") {
    return (
      <section key="email">
        <h1>Sign in</h1>
        <p className="muted">We'll email you a code. No password needed, and a new email gets an account.</p>
        <form className="form" onSubmit={onEmail} noValidate>
          <Field name="email" label="Email" type="email" autoComplete="email" defaultValue={email} error={fieldError} />
          {sendCode.error && (
            <p className="field-error" role="alert">
              {sendCode.error.message}
            </p>
          )}
          <button className="button" type="submit" disabled={sendCode.isPending}>
            {sendCode.isPending ? "Sending…" : "Email me a code"}
          </button>
        </form>
      </section>
    );
  }

  return (
    <section key="code">
      <h1>Check your email</h1>
      <p className="muted">We sent a code to {email}. It expires in about an hour.</p>
      <form className="form" onSubmit={onCode} noValidate>
        <Field name="code" label="Code" inputMode="numeric" autoComplete="one-time-code" maxLength={10} error={fieldError} />
        {(verifyCode.error ?? sendCode.error) && (
          <p className="field-error" role="alert">
            {(verifyCode.error ?? sendCode.error)?.message}
          </p>
        )}
        <button className="button" type="submit" disabled={verifyCode.isPending}>
          {verifyCode.isPending ? "Signing in…" : "Sign in"}
        </button>
      </form>
      <button className="button secondary" type="button" onClick={() => requestCode(email)} disabled={sendCode.isPending}>
        Send a new code
      </button>
      <button
        className="button secondary"
        type="button"
        onClick={() => {
          verifyCode.reset();
          setFieldError(undefined);
          setStep("email");
        }}
      >
        Use a different email
      </button>
    </section>
  );
}
