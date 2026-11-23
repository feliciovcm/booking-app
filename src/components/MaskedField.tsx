import type { ChangeEvent } from "react";
import { caretAfterDigits } from "../utils/card";
import { Field } from "./Field";

/**
 * An input that reformats what's typed or pasted (card number, expiry, CVC). It stays
 * uncontrolled, since the form reads it with FormData: on each change we rewrite the value
 * and put the caret back after the same digit, so editing in the middle doesn't jump to
 * the end. Works for any format whose added characters aren't digits.
 */
export function MaskedField({
  format,
  ...field
}: { format: (value: string, input: HTMLInputElement) => string } & React.ComponentProps<typeof Field>) {
  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const caret = input.selectionStart ?? input.value.length;
    const atEnd = caret === input.value.length;
    const digitsBeforeCaret = input.value.slice(0, caret).replace(/\D/g, "").length;
    const formatted = format(input.value, input);
    if (formatted === input.value) return;
    input.value = formatted;
    // Typing at the end stays at the end, even when the format adds a digit ("2" -> "02").
    const position = atEnd ? formatted.length : caretAfterDigits(formatted, digitsBeforeCaret);
    input.setSelectionRange(position, position);
  };
  return <Field inputMode="numeric" {...field} onChange={onChange} />;
}
