// Supabase Edge Function `api`: the desktop app's server. Thin Deno wrapper;
// the logic and its tests live in ../_shared.
//
// Secrets (supabase secrets set ...): GEMINI_API_KEY, DEEPGRAM_API_KEY,
// ANTHROPIC_API_KEY (optional: Claude answers once it is set), MIN_APP_VERSION,
// MODEL_PRICES ('{"model":[in,out]}' USD per 1M; GEMINI_PRICES still read) and
// MODEL_ROUTES ('{"fast":["claude:claude-haiku-5-5",...],"long":[...]}').
// SUPABASE_URL and the server key are provided by Supabase.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import Anthropic from 'npm:@anthropic-ai/sdk@0.127.0';
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

// A malformed optional secret is ignored (and logged), never fatal.
function jsonSecret<T>(...names: string[]): T | undefined {
  for (const name of names) {
    const raw = Deno.env.get(name);
    if (!raw) continue;
    try { return JSON.parse(raw) as T; } catch { console.log(`[api] ignoring malformed secret ${name}`); }
  }
  return undefined;
}

const anthropicKey = env('ANTHROPIC_API_KEY', false);
const anthropic = anthropicKey ? new Anthropic({ apiKey: anthropicKey, maxRetries: 0 }) : undefined;

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
    prices: jsonSecret('MODEL_PRICES', 'GEMINI_PRICES'),
    routes: jsonSecret('MODEL_ROUTES'),
  },
  anthropic: anthropic as unknown as Deps['anthropic'],
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
