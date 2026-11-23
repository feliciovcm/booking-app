import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Database } from "./database.types";

// Only public values belong here: Vite ships every VITE_ variable to the browser.
// The publishable key is safe to expose (the legacy "anon" key is for compatibility only);
// grants and RLS decide what it can do.
const env = z
  .object({
    VITE_SUPABASE_URL: z.url(),
    VITE_SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  })
  .parse(import.meta.env);

export const SUPABASE_URL = env.VITE_SUPABASE_URL;
export const SUPABASE_PUBLISHABLE_KEY = env.VITE_SUPABASE_PUBLISHABLE_KEY;

export const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
