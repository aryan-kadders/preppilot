/**
 * PrepPilot Cloud client: the desktop side of cloud/supabase/functions/_shared/core.ts.
 *
 * A candidate signs in once with an invite code. The server returns a
 * 15-minute access token (kept in memory only) and a 30-day refresh token
 * (persisted through the injected store, which encrypts it with the OS
 * keystore). Every call carries the access token; a 401 refreshes it once and
 * retries. Refresh tokens rotate on every use, so the newest one is saved
 * before anything else happens.
 *
 * A session is the paid time: it opens when a meeting starts (only inside a
 * booked slot with minutes left), checks in every 30 seconds so the server can
 * charge the time, warns once when five minutes are left, and reports when the
 * server ends it (time up, revoked, stale).
 *
 * Platform-independent and dependency-injected (fetch, clock, timers, store):
 * the same code is tested for macOS and Windows identities.
 */

export type CloudState = 'signed_out' | 'signed_in' | 'revoked';

export interface StoredCloudCredentials {
  refreshToken: string;
  deviceId: string;
  baseUrl: string;
}

export interface CloudStore {
  load(): StoredCloudCredentials | null;
  save(c: StoredCloudCredentials): void;
  clear(): void;
}

export interface CloudDeps {
  fetch: typeof fetch;
  store: CloudStore;
  appVersion: string;
  platform: string;
  deviceName: string;
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  log?: (line: string) => void;
}

export interface CloudSessionView {
  session_id: string;
  status: 'open' | 'ended';
  end_reason: string | null;
  allowed_until: string;
  seconds_left: number;
  balance_seconds: number;
}

export interface CloudStatus {
  candidate: { id: string; name: string } | null;
  balance_seconds: number;
  current_slot: { starts_at: string; ends_at: string } | null;
  next_slot: { starts_at: string; ends_at: string } | null;
  assignments: Array<Record<string, unknown>>;
}

/** A refusal the user should read as their time, not as a failure. */
export type TimeReason = 'no_active_slot' | 'no_minutes' | 'time_up' | 'session_ended' | 'attempts_exhausted';

export class CloudError extends Error {
  constructor(public readonly code: string, public readonly status: number, public readonly reason?: string) {
    super(reason ? `${code}: ${reason}` : code);
    this.name = 'CloudError';
  }
}

export type CloudEvent =
  | { type: 'state'; state: CloudState }
  | { type: 'session'; session: CloudSessionView }
  | { type: 'warning'; secondsLeft: number }
  | { type: 'ended'; reason: string };

export const HEARTBEAT_MS = 30_000;
export const WARNING_SECONDS = 300;
const ACCESS_SKEW_MS = 60_000;
const ACCESS_LIFETIME_MS = 15 * 60_000;

/** "a1b2 c3d4-e5f6g7h8…" → "A1B2-C3D4-E5F6-7890", or null when it cannot be a code. */
export function normalizeInviteCode(input: string): string | null {
  const raw = String(input ?? '').toUpperCase().replace(/[^0-9A-F]/g, '');
  return raw.length === 16 ? raw.match(/.{4}/g)!.join('-') : null;
}

/** Plain-language line for a time refusal, shown in Settings and the overlay. */
export function timeReasonMessage(reason: string | undefined): string {
  switch (reason) {
    case 'no_active_slot': return 'You have no session booked right now. Your manager can book a time slot for you.';
    case 'no_minutes': return 'You have no practice minutes left. Ask your manager for more time.';
    case 'time_up': return 'Your time for this session is up.';
    case 'attempts_exhausted': return 'You have used all attempts for this assignment.';
    case 'session_ended': return 'This session has ended.';
    case 'device_revoked': return 'This computer was signed out by your manager.';
    default: return 'PrepPilot Cloud is not available right now.';
  }
}

export class CloudClient {
  private access: { token: string; expiresAt: number } | null = null;
  private creds: StoredCloudCredentials | null;
  private refreshing: Promise<void> | null = null;
  private listeners = new Set<(e: CloudEvent) => void>();
  private session: { id: string; seq: number; timer: unknown; warned: boolean } | null = null;
  private stateValue: CloudState;
  private readonly now: () => number;

  constructor(private readonly baseUrl: string, private readonly deps: CloudDeps) {
    this.now = deps.now ?? Date.now;
    this.creds = deps.store.load();
    // Credentials saved against another server are not ours to use.
    if (this.creds && this.creds.baseUrl !== baseUrl) this.creds = null;
    this.stateValue = this.creds ? 'signed_in' : 'signed_out';
  }

  get state(): CloudState { return this.stateValue; }
  get signedIn(): boolean { return this.stateValue === 'signed_in'; }
  get deviceId(): string | null { return this.creds?.deviceId ?? null; }
  get sessionId(): string | null { return this.session?.id ?? null; }

  on(fn: (e: CloudEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: CloudEvent): void {
    for (const fn of this.listeners) {
      try { fn(e); } catch (err) { this.deps.log?.(`[Cloud] listener failed: ${(err as Error)?.message ?? err}`); }
    }
  }

  private setState(s: CloudState): void {
    if (this.stateValue === s) return;
    this.stateValue = s;
    this.emit({ type: 'state', state: s });
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { 'content-type': 'application/json', 'x-preppilot-version': this.deps.appVersion, ...extra };
  }

  private async call(path: string, init: { method?: string; body?: unknown; auth?: boolean; session?: boolean } = {}, retried = false): Promise<any> {
    const extra: Record<string, string> = {};
    if (init.auth !== false) extra.authorization = `Bearer ${await this.accessToken()}`;
    if (init.session) {
      if (!this.session) throw new CloudError('session_required', 400);
      extra['x-preppilot-session'] = this.session.id;
    }
    const res = await this.deps.fetch(`${this.baseUrl}${path}`, {
      method: init.method ?? 'POST',
      headers: this.headers(extra),
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    let data: any = null;
    try { data = await res.json(); } catch { data = null; }
    if (res.ok) return data;
    const code = typeof data?.error === 'string' ? data.error : `http_${res.status}`;
    if (res.status === 401 && init.auth !== false && !retried) {
      this.access = null;
      return this.call(path, init, true);
    }
    if (res.status === 403 && code === 'device_revoked') this.revoke();
    throw new CloudError(code, res.status, data?.reason);
  }

  /** Signs this computer in with an invite code from a manager. */
  async redeem(code: string): Promise<void> {
    const normalized = normalizeInviteCode(code);
    if (!normalized) throw new CloudError('invalid_code', 400);
    const r = await this.call('/v1/auth/redeem', {
      auth: false,
      body: { code: normalized, device_name: this.deps.deviceName, platform: this.deps.platform, app_version: this.deps.appVersion },
    });
    this.adopt(r);
    this.setState('signed_in');
  }

  private adopt(r: { access_token: string; refresh_token: string; device_id: string; access_expires_at?: string }): void {
    this.creds = { refreshToken: r.refresh_token, deviceId: r.device_id, baseUrl: this.baseUrl };
    // Saved first: the old refresh token is already spent on the server.
    this.deps.store.save(this.creds);
    const exp = r.access_expires_at ? Date.parse(r.access_expires_at) : NaN;
    this.access = { token: r.access_token, expiresAt: Number.isFinite(exp) ? exp : this.now() + ACCESS_LIFETIME_MS };
  }

  /** A valid access token, refreshing (once, shared) when it is about to expire. */
  async accessToken(): Promise<string> {
    if (this.access && this.access.expiresAt - ACCESS_SKEW_MS > this.now()) return this.access.token;
    if (!this.creds) throw new CloudError('signed_out', 401);
    if (!this.refreshing) {
      this.refreshing = (async () => {
        try {
          const res = await this.deps.fetch(`${this.baseUrl}/v1/auth/refresh`, {
            method: 'POST', headers: this.headers(), body: JSON.stringify({ refresh_token: this.creds!.refreshToken }),
          });
          let data: any = null;
          try { data = await res.json(); } catch { data = null; }
          if (!res.ok) {
            const code = typeof data?.error === 'string' ? data.error : `http_${res.status}`;
            if (code === 'device_revoked') this.revoke();
            else if (res.status === 401) this.signOutLocally();
            throw new CloudError(code, res.status);
          }
          this.adopt(data);
        } finally {
          this.refreshing = null;
        }
      })();
    }
    await this.refreshing;
    return this.access!.token;
  }

  async status(): Promise<CloudStatus> {
    return this.call('/v1/me', { method: 'GET' });
  }

  /** Opens the paid session (or resumes this computer's open one). */
  async startSession(assignmentId?: string): Promise<CloudSessionView> {
    if (this.session) return this.heartbeat();
    const view: CloudSessionView = await this.call('/v1/session/start', { body: assignmentId ? { assignment_id: assignmentId } : {} });
    this.session = { id: view.session_id, seq: Number((view as { last_seq?: number }).last_seq) || 0, timer: null, warned: false };
    const set = this.deps.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
    this.session.timer = set(() => { this.heartbeat().catch((e) => this.deps.log?.(`[Cloud] heartbeat failed: ${e?.message ?? e}`)); }, HEARTBEAT_MS);
    this.observe(view);
    return view;
  }

  async heartbeat(): Promise<CloudSessionView> {
    const s = this.session;
    if (!s) throw new CloudError('session_required', 400);
    s.seq += 1;
    let view: CloudSessionView;
    try {
      view = await this.call('/v1/session/heartbeat', { body: { session_id: s.id, seq: s.seq } });
    } catch (e) {
      // The server no longer has this session open: it is over, whatever the reason.
      if (e instanceof CloudError && (e.status === 409 || e.status === 429) && this.session === s) {
        this.stopTimer();
        this.session = null;
        this.emit({ type: 'ended', reason: e.reason ?? e.code });
      }
      throw e;
    }
    this.observe(view);
    return view;
  }

  /** Ends the session (meeting stopped). Never throws: the server also ends a silent session. */
  async endSession(): Promise<void> {
    const s = this.session;
    if (!s) return;
    this.stopTimer();
    this.session = null;
    try {
      await this.call('/v1/session/end', { body: { session_id: s.id, seq: s.seq + 1 } });
    } catch (e) {
      this.deps.log?.(`[Cloud] end session failed (the server closes it after 90 s): ${(e as Error)?.message ?? e}`);
    }
  }

  private observe(view: CloudSessionView): void {
    this.emit({ type: 'session', session: view });
    if (view.status === 'ended') {
      this.stopTimer();
      this.session = null;
      this.emit({ type: 'ended', reason: view.end_reason ?? 'session_ended' });
      return;
    }
    if (this.session && !this.session.warned && view.seconds_left <= WARNING_SECONDS) {
      this.session.warned = true;
      this.emit({ type: 'warning', secondsLeft: view.seconds_left });
    }
  }

  private stopTimer(): void {
    if (this.session?.timer != null) (this.deps.clearInterval ?? ((h: unknown) => clearInterval(h as any)))(this.session.timer);
    if (this.session) this.session.timer = null;
  }

  /** A Deepgram key valid for 60 seconds, for opening the transcription stream. */
  async sttToken(): Promise<string> {
    const r = await this.call('/v1/stt/token', { session: true });
    return r.access_token;
  }

  /** Headers for the app's hosted-provider client (LLMHelper) to call /v1/chat. */
  async chatHeaders(): Promise<Record<string, string>> {
    if (!this.session) throw new CloudError('time_quota_exceeded', 429, 'session_ended');
    return { 'x-natively-key': await this.accessToken(), 'x-preppilot-session': this.session.id, 'x-preppilot-version': this.deps.appVersion };
  }

  get chatUrl(): string { return `${this.baseUrl}/v1/chat`; }

  /** Signs out on this computer (the device stays listed for the manager to revoke). */
  async signOut(): Promise<void> {
    await this.endSession();
    this.signOutLocally();
  }

  private signOutLocally(next: CloudState = 'signed_out'): void {
    const hadSession = this.session !== null;
    this.stopTimer();
    this.session = null;
    this.access = null;
    this.creds = null;
    this.deps.store.clear();
    this.setState(next);
    if (hadSession) this.emit({ type: 'ended', reason: next === 'revoked' ? 'device_revoked' : 'signed_out' });
  }

  private revoke(): void {
    this.signOutLocally('revoked');
  }
}
