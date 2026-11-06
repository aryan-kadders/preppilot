// PrepPilot Cloud API: everything the desktop app calls.
//
// Runs as the Supabase Edge Function `api` (see ../api/index.ts), so the app's
// base URL is https://<project>.supabase.co/functions/v1/api and the routes
// below follow it. Pure TypeScript with injected dependencies: no Deno APIs
// here, so the same code is tested under Node (cloud/tests/api.test.ts).
//
// Wire format of /v1/chat matches the app's existing hosted-provider client
// (LLMHelper.streamWithNatively / generateWithNatively): request
// { messages, system?, stream?, images?, fast_mode?, model_tier? }; a stream
// answers `data: {"delta": "...", "model": "..."}` lines and `data: [DONE]`;
// otherwise `{ "content": "..." }`. Time limits come back as HTTP 429 with
// `error: "time_quota_exceeded"`, which that client already reports as a
// plan limit instead of a broken provider.

import { geminiChat, type ChatBody } from './gemini.ts';
import { deepgramGrant } from './deepgram.ts';

export interface Deps {
  /** Calls a Postgres function with the service role; returns its result. */
  rpc(fn: string, args: Record<string, unknown>): Promise<any>;
  fetch: typeof fetch;
  env: {
    geminiKey: string;
    deepgramKey: string;
    /** Oldest desktop version allowed (e.g. "3.2.0"); unset = any. */
    minAppVersion?: string;
    /** USD per 1M tokens, keyed by model: { "<model>": [input, output] }. */
    prices?: Record<string, [number, number]>;
  };
  randomToken(): string;
  /** Dashboard (staff) routes: Supabase Auth, through the service role. */
  staff?: {
    /** The user id behind a dashboard session's access token, or null. */
    userIdFromJwt(jwt: string): Promise<string | null>;
    /** Creates (or finds) the person and returns a one-time sign-in link for them. */
    signInLink(email: string, redirectTo: string | undefined): Promise<{ userId: string; link: string }>;
  };
  /** Keeps work alive after the response is sent (EdgeRuntime.waitUntil). */
  waitUntil?(p: Promise<unknown>): void;
  log?(line: string, extra?: Record<string, unknown>): void;
}

export const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 32 random bytes, base64url: the access and refresh tokens. */
export function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** "a1b2 c3d4-e5f6g7h8" style input → the canonical XXXX-XXXX-XXXX-XXXX. */
export function normalizeInviteCode(input: unknown): string | null {
  const raw = String(input ?? '').toUpperCase().replace(/[^0-9A-F]/g, '');
  if (raw.length !== 16) return null;
  return raw.match(/.{4}/g)!.join('-');
}

/** -1, 0 or 1. Missing parts count as 0; anything non-numeric compares as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(/[.+-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0) ? 1 : -1;
  }
  return 0;
}

// Session refusals the app shows as "your time" messages, not as failures.
const TIME_ERRORS = new Set(['no_active_slot', 'no_minutes', 'time_up', 'session_ended', 'attempts_exhausted']);

/** The HTTP answer for an error code from the database functions. */
export function errorResponse(code: string, extra: Record<string, unknown> = {}): Response {
  if (code === 'invalid_token') return json(401, { error: code });
  if (code === 'device_revoked') return json(403, { error: code });
  if (TIME_ERRORS.has(code)) return json(429, { error: 'time_quota_exceeded', reason: code, ...extra });
  if (code === 'session_stale' || code === 'session_not_found') return json(409, { error: code });
  if (code === 'invalid_code' || code === 'code_used' || code === 'code_expired') return json(400, { error: code });
  if (code === 'assignment_not_found' || code === 'bad_seq') return json(400, { error: code });
  return json(400, { error: code });
}

interface Device { device_id: string; candidate_id: string }

/** The calling device, from `Authorization: Bearer` or the app's existing `x-natively-key`. */
async function authenticate(req: Request, deps: Deps): Promise<Device | Response> {
  const bearer = req.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  const token = (bearer ?? req.headers.get('x-natively-key') ?? '').trim();
  if (!token) return json(401, { error: 'invalid_token' });
  const r = await deps.rpc('pp_authenticate', { p_access_hash: await sha256Hex(token) });
  if (r?.error) return errorResponse(r.error);
  return r as Device;
}

async function readJson(req: Request): Promise<Record<string, any> | null> {
  try {
    const body = await req.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

const isUuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/** The route after the function's own prefix: ".../functions/v1/api/v1/chat" → "/v1/chat". */
export function routeOf(url: string): string {
  const p = new URL(url).pathname;
  const i = p.indexOf('/v1/', p.indexOf('/api') >= 0 ? p.indexOf('/api') : 0);
  return i >= 0 ? p.slice(i).replace(/\/+$/, '') : p;
}

export async function handle(req: Request, deps: Deps): Promise<Response> {
  const route = routeOf(req.url);
  if (route.startsWith('/v1/staff/')) return staffRoute(req, route, deps);
  try {
    if (req.method !== 'POST' && !(req.method === 'GET' && route === '/v1/me')) {
      return json(405, { error: 'method_not_allowed' });
    }
    const version = req.headers.get('x-preppilot-version');
    if (deps.env.minAppVersion && (!version || compareVersions(version, deps.env.minAppVersion) < 0)) {
      return json(426, { error: 'app_update_required', min_version: deps.env.minAppVersion });
    }

    if (route === '/v1/auth/redeem') return await redeem(req, deps);
    if (route === '/v1/auth/refresh') return await refresh(req, deps);

    const device = await authenticate(req, deps);
    if (device instanceof Response) return device;

    switch (route) {
      case '/v1/me':
        return json(200, await deps.rpc('pp_device_status', { p_device: device.device_id }));
      case '/v1/session/start': {
        const body = (await readJson(req)) ?? {};
        if (body.assignment_id != null && !isUuid(body.assignment_id)) return json(400, { error: 'bad_assignment_id' });
        const r = await deps.rpc('pp_session_start', { p_device: device.device_id, p_assignment: body.assignment_id ?? null });
        return r?.error ? errorResponse(r.error) : json(200, r);
      }
      case '/v1/session/heartbeat':
      case '/v1/session/end': {
        const body = await readJson(req);
        if (!body || !isUuid(body.session_id) || !Number.isInteger(body.seq) || body.seq < 1) return json(400, { error: 'bad_request' });
        const fn = route === '/v1/session/end' ? 'pp_session_end' : 'pp_session_heartbeat';
        const r = await deps.rpc(fn, { p_device: device.device_id, p_session: body.session_id, p_seq: body.seq });
        return r?.error ? errorResponse(r.error) : json(200, r);
      }
      case '/v1/chat':
      case '/v1/stt/token': {
        const sessionId = req.headers.get('x-preppilot-session');
        if (!isUuid(sessionId)) return json(400, { error: 'session_required' });
        const auth = await deps.rpc('pp_authorize_call', { p_device: device.device_id, p_session: sessionId });
        if (auth?.error) return errorResponse(auth.error, auth.end_reason ? { end_reason: auth.end_reason } : {});
        if (route === '/v1/stt/token') return await deepgramGrant(deps);
        const body = await readJson(req);
        if (!body || !Array.isArray(body.messages) || body.messages.length === 0) return json(400, { error: 'bad_request' });
        return await geminiChat(body as ChatBody, sessionId, req.signal, deps);
      }
      default:
        return json(404, { error: 'not_found' });
    }
  } catch (e) {
    deps.log?.('[api] unhandled error', { route, error: String((e as Error)?.message ?? e).slice(0, 300) });
    return json(500, { error: 'internal_error' });
  }
}

async function issueTokens(deps: Deps) {
  const access = deps.randomToken();
  const refresh = deps.randomToken();
  return { access, refresh, accessHash: await sha256Hex(access), refreshHash: await sha256Hex(refresh) };
}

async function redeem(req: Request, deps: Deps): Promise<Response> {
  const body = await readJson(req);
  const code = normalizeInviteCode(body?.code);
  if (!code) return json(400, { error: 'invalid_code' });
  const t = await issueTokens(deps);
  const r = await deps.rpc('pp_redeem_invite', {
    p_code_hash: await sha256Hex(code),
    p_device_name: String(body?.device_name ?? '').slice(0, 200) || null,
    p_platform: String(body?.platform ?? ''),
    p_app_version: String(body?.app_version ?? '').slice(0, 50) || null,
    p_access_hash: t.accessHash,
    p_refresh_hash: t.refreshHash,
  });
  if (r?.error) return errorResponse(r.error);
  return json(200, {
    access_token: t.access, refresh_token: t.refresh, device_id: r.device_id,
    access_expires_at: r.access_expires_at, refresh_expires_at: r.refresh_expires_at,
  });
}

async function refresh(req: Request, deps: Deps): Promise<Response> {
  const body = await readJson(req);
  const token = typeof body?.refresh_token === 'string' ? body.refresh_token.trim() : '';
  if (!token) return json(401, { error: 'invalid_token' });
  const t = await issueTokens(deps);
  const r = await deps.rpc('pp_refresh', {
    p_refresh_hash: await sha256Hex(token), p_new_access_hash: t.accessHash, p_new_refresh_hash: t.refreshHash,
  });
  if (r?.error) return errorResponse(r.error);
  return json(200, {
    access_token: t.access, refresh_token: t.refresh, device_id: r.device_id,
    access_expires_at: r.access_expires_at, refresh_expires_at: r.refresh_expires_at,
  });
}

// ─────────────────────────── dashboard (staff) routes ───────────────────────────
// Called from the manager dashboard in a browser: CORS, and the caller's
// Supabase Auth session instead of a device token.

const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type, apikey, x-client-info',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-max-age': '600',
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function staffRoute(req: Request, route: string, deps: Deps): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  try {
    if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' }, CORS);
    if (!deps.staff) return json(503, { error: 'staff_routes_unavailable' }, CORS);
    const jwt = req.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    const adminId = jwt ? await deps.staff.userIdFromJwt(jwt) : null;
    if (!adminId) return json(401, { error: 'not_signed_in' }, CORS);

    if (route === '/v1/staff/invite') {
      // Checked first, so nobody but an admin can make the server create a login.
      if ((await deps.rpc('pp_staff_role', { p_user: adminId })) !== 'admin') return json(403, { error: 'admins_only' }, CORS);
      const body = await readJson(req);
      const email = String(body?.email ?? '').trim().toLowerCase();
      const role = String(body?.role ?? '');
      const teamIds: unknown[] = Array.isArray(body?.team_ids) ? body!.team_ids : [];
      if (!EMAIL_RE.test(email) || email.length > 254) return json(400, { error: 'bad_email' }, CORS);
      if (!['admin', 'manager', 'coach'].includes(role)) return json(400, { error: 'bad_role' }, CORS);
      if (!teamIds.every(isUuid)) return json(400, { error: 'bad_team' }, CORS);
      const redirectTo = typeof body?.redirect_to === 'string' && /^https?:\/\//.test(body.redirect_to) ? body.redirect_to : undefined;
      const { userId, link } = await deps.staff.signInLink(email, redirectTo);
      const r = await deps.rpc('pp_admin_add_staff', {
        p_admin: adminId, p_user: userId, p_role: role, p_team_ids: teamIds,
        p_display_name: typeof body?.display_name === 'string' ? body.display_name.slice(0, 120) : null,
      });
      if (r?.error) return json(r.error === 'forbidden' ? 403 : 409, { error: r.error }, CORS);
      return json(200, { user_id: userId, link }, CORS);
    }
    return json(404, { error: 'not_found' }, CORS);
  } catch (e) {
    deps.log?.('[api] staff route failed', { route, error: String((e as Error)?.message ?? e).slice(0, 300) });
    return json(500, { error: 'internal_error' }, CORS);
  }
}
