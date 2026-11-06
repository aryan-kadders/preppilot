// Supabase Edge Function `api`: the desktop app's server. Thin Deno wrapper;
// the logic and its tests live in ../_shared.
//
// Secrets (supabase secrets set ...): GEMINI_API_KEY, DEEPGRAM_API_KEY,
// optional MIN_APP_VERSION and GEMINI_PRICES ('{"model":[in,out]}' USD per 1M).
// SUPABASE_URL and the server key are provided by Supabase.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { handle, randomToken, type Deps } from '../_shared/core.ts';

const env = (name: string, required = true): string => {
  const v = Deno.env.get(name) ?? '';
  if (required && !v) throw new Error(`missing secret ${name}`);
  return v;
};

// The server key: new projects provide SUPABASE_SECRET_KEYS (a JSON map, key
// "default"); older ones SUPABASE_SERVICE_ROLE_KEY. Either bypasses RLS.
function serverKey(): string {
  const legacy = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (legacy) return legacy;
  try {
    const keys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}') as Record<string, string>;
    const key = keys.default ?? Object.values(keys)[0];
    if (key) return key;
  } catch { /* fall through */ }
  throw new Error('missing secret SUPABASE_SECRET_KEYS (or SUPABASE_SERVICE_ROLE_KEY)');
}

const db = createClient(env('SUPABASE_URL'), serverKey(), {
  auth: { persistSession: false, autoRefreshToken: false },
});

let prices: Deps['env']['prices'];
try { prices = Deno.env.get('GEMINI_PRICES') ? JSON.parse(Deno.env.get('GEMINI_PRICES')!) : undefined; } catch { prices = undefined; }

const deps: Deps = {
  async rpc(fn, args) {
    const { data, error } = await db.rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data;
  },
  fetch: (input, init) => fetch(input, init),
  env: {
    geminiKey: env('GEMINI_API_KEY', false),
    deepgramKey: env('DEEPGRAM_API_KEY', false),
    minAppVersion: env('MIN_APP_VERSION', false) || undefined,
    prices,
  },
  randomToken,
  staff: {
    async userIdFromJwt(jwt) {
      const { data, error } = await db.auth.getUser(jwt);
      return error ? null : data.user?.id ?? null;
    },
    async signInLink(email, redirectTo) {
      // A new person gets an invite link; someone who already has a login, a sign-in link.
      let r = await db.auth.admin.generateLink({ type: 'invite', email, options: { redirectTo } });
      if (r.error && /already|registered|exists/i.test(r.error.message)) {
        r = await db.auth.admin.generateLink({ type: 'magiclink', email, options: { redirectTo } });
      }
      if (r.error || !r.data?.user) throw new Error(`sign-in link: ${r.error?.message ?? 'no user'}`);
      return { userId: r.data.user.id, link: r.data.properties.action_link };
    },
  },
  waitUntil: (p) => (globalThis as any).EdgeRuntime?.waitUntil?.(p),
  log: (line, extra) => console.log(line, extra ? JSON.stringify(extra) : ''),
};

Deno.serve((req) => handle(req, deps));
