import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";

let cached: SupabaseClient | undefined;

// One service-role client per server process. The secret key never reaches the
// browser: this module is server-only and RLS has no policies, so the client
// bypasses RLS by design (it IS the trusted server).
export function getSupabase(): SupabaseClient {
  cached ??= createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}
