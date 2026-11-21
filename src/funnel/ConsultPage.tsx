import { useState, type FormEvent } from "react";
import { z } from "zod";
import { consultRequestSchema, submitConsultRequest, type ConsultRequestInput } from "../lib/consult";

type Status = "idle" | "submitting" | "sent" | "failed";
type FieldErrors = Partial<Record<keyof ConsultRequestInput, string>>;

export function ConsultPage() {
  const [status, setStatus] = useState<Status>("idle");
  const [errors, setErrors] = useState<FieldErrors>({});

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = consultRequestSchema.safeParse(Object.fromEntries(new FormData(event.currentTarget)));
    if (!parsed.success) {
      const fieldErrors = z.flattenError(parsed.error).fieldErrors;
      setErrors(Object.fromEntries(Object.entries(fieldErrors).map(([k, v]) => [k, v?.[0]])) as FieldErrors);
      return;
    }
    setErrors({});
    setStatus("submitting");
    try {
      await submitConsultRequest(parsed.data);
      setStatus("sent");
    } catch {
      setStatus("failed");
    }
  }

  if (status === "sent")
    return (
      <section className="card" role="status">
        <h1>Thanks, we'll call you soon</h1>
        <p className="muted">A clinician will reach out within one business day.</p>
      </section>
    );

  return (
    <>
      <h1>Free 15-minute phone consult</h1>
      <p className="muted">Tell us how to reach you. No commitment.</p>

      <form className="form" onSubmit={onSubmit} noValidate>
        <Field name="full_name" label="Full name" autoComplete="name" error={errors.full_name} />
        <Field name="phone" label="Phone" type="tel" autoComplete="tel" error={errors.phone} />
        <Field name="email" label="Email (optional)" type="email" autoComplete="email" error={errors.email} />
        <label>
          What would you like to discuss? (optional)
          <textarea name="message" rows={3} maxLength={1000} />
        </label>

        {status === "failed" && (
          <p className="error" role="alert">
            Something went wrong. Please try again, or text us.
          </p>
        )}
        <button type="submit" className="button" disabled={status === "submitting"}>
          {status === "submitting" ? "Sending…" : "Request a call"}
        </button>
      </form>
    </>
  );
}

function Field({
  name,
  label,
  error,
  ...input
}: { name: keyof ConsultRequestInput; label: string; error?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label>
      {label}
      <input name={name} aria-invalid={!!error} aria-describedby={error ? `${name}-error` : undefined} {...input} />
      {error && (
        <span id={`${name}-error`} className="field-error">
          {error}
        </span>
      )}
    </label>
  );
}
