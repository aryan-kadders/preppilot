// The PrepPilot Cloud project. The publishable key is meant for browsers:
// what it can read is decided by the database's row-level security, so it is
// safe in this bundle. Never put the secret (service role) key here.
export const SUPABASE_URL: string = import.meta.env.VITE_SUPABASE_URL ?? 'https://uhrthebpefobnxsxoyoc.supabase.co';
export const SUPABASE_PUBLISHABLE_KEY: string = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? 'sb_publishable_3cJbgToWOotr8q0qSGlQhQ_gXc9O_TK';
export const API_URL = `${SUPABASE_URL}/functions/v1/api`;
