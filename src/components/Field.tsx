/** A labelled input with its error message wired up for screen readers. */
export function Field({
  name,
  label,
  error,
  ...input
}: { name: string; label: string; error?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
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
