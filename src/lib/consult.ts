import { z } from "zod";
import { supabase } from "./supabase";

// Mirrors the check constraints on public.consult_requests. The database stays the
// source of truth; this only gives the visitor errors before a round trip.
export const consultRequestSchema = z.object({
  full_name: z.string().trim().min(1, "Enter your name").max(100),
  phone: z.string().trim().min(7, "Enter a valid phone number").max(20),
  email: z.union([z.literal(""), z.string().trim().pipe(z.email({ error: "Enter a valid email" }).max(254))]),
  message: z.string().trim().max(1000),
});

export type ConsultRequestInput = z.infer<typeof consultRequestSchema>;

export async function submitConsultRequest(input: ConsultRequestInput) {
  // Insert only, no .select(): the table has no select grant (submissions hold personal
  // data), and INSERT ... RETURNING needs one, so .insert().select() would fail with 42501.
  const { error } = await supabase.from("consult_requests").insert({
    full_name: input.full_name,
    phone: input.phone,
    email: input.email || null,
    message: input.message || null,
  });
  if (error) throw error;
}
