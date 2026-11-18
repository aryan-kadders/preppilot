/**
 * PrepPilot Cloud: a signed-in candidate's finished meetings and mock
 * interviews go to their team's dashboard (candidates are told, in the app).
 *
 * The record is built from what this computer saved (never screenshots), and
 * queued in a small file first, so a session that ends offline, or while the
 * app quits, is sent on the next launch. The server cleans and caps it again
 * (cloud/supabase/functions/_shared/records.ts) and keeps it 90 days.
 * No platform branches: the queue file lives in Electron's userData on both.
 */

export type RecordKind = 'meeting' | 'practice';
export interface QueuedRecord { kind: RecordKind; id: string; tries: number }

export interface MeetingLike {
  id: string;
  title?: string | null;
  date?: string | null;
  transcript?: Array<{ speaker?: string; text?: string; timestamp?: number; origin?: string }>;
  usage?: Array<{ type?: string; timestamp?: number; question?: string; answer?: string; items?: string[] }>;
  detailedSummary?: unknown;
}

export interface PracticeLike {
  id: string;
  createdAt: string;
  updatedAt?: string;
  status?: string;
  config?: { role?: string; company?: string } & Record<string, unknown>;
  questions?: unknown[];
  answers?: unknown[];
  report?: unknown;
}

/** The upload body for a saved meeting. */
export function buildMeetingRecord(m: MeetingLike, timing: { startTime: number; durationMs: number } | null) {
  const start = timing?.startTime && timing.startTime > 0 ? timing.startTime : Date.parse(m.date ?? '') || Date.now();
  return {
    kind: 'meeting' as const,
    local_id: m.id,
    title: m.title || 'Interview session',
    started_at: new Date(start).toISOString(),
    duration_seconds: timing ? Math.round(timing.durationMs / 1000) : null,
    content: {
      transcript: (m.transcript ?? []).map((l) => ({ speaker: l.speaker ?? 'unknown', text: l.text ?? '', t: l.timestamp ?? null })),
      // Questions and answers only: the screenshots an answer used stay on this computer.
      answers: (m.usage ?? []).map((u) => ({ type: u.type ?? null, t: u.timestamp ?? null, question: u.question ?? null, answer: u.answer ?? null, items: u.items ?? [] })),
      summary: m.detailedSummary ?? null,
    },
  };
}

/** The upload body for a finished mock interview. */
export function buildPracticeRecord(p: PracticeLike) {
  const role = p.config?.role?.trim();
  const company = p.config?.company?.trim();
  const started = Date.parse(p.createdAt);
  const ended = Date.parse(p.updatedAt ?? '');
  return {
    kind: 'practice' as const,
    local_id: p.id,
    title: `Mock interview${role ? `: ${role}` : ''}${company ? ` at ${company}` : ''}`,
    started_at: new Date(Number.isFinite(started) ? started : Date.now()).toISOString(),
    duration_seconds: Number.isFinite(started) && Number.isFinite(ended) && ended >= started ? Math.round((ended - started) / 1000) : null,
    content: { config: p.config ?? {}, questions: p.questions ?? [], answers: p.answers ?? [], report: p.report ?? null },
  };
}

/** Kept for a later try (network, server busy, signed-out token) or dropped for good (the server refused this record). */
export function shouldRetry(err: { status?: unknown; code?: unknown } | null | undefined): boolean {
  const status = typeof err?.status === 'number' ? err.status : 0;
  if (!status) return true;
  // 404: a server without this route yet (the app updated first); it is sent once the server is.
  if (status === 401 || status === 404 || status === 408 || status === 429 || status >= 500) return true;
  return false;
}

const MAX_TRIES = 20;
const RETRY_MS = 5 * 60_000;

export interface UploaderDeps {
  signedIn(): boolean;
  upload(record: unknown): Promise<unknown>;
  loadMeeting(id: string): ReturnType<typeof buildMeetingRecord> | null;
  loadPractice(id: string): ReturnType<typeof buildPracticeRecord> | null;
  store: { load(): QueuedRecord[]; save(q: QueuedRecord[]): void };
  schedule?(fn: () => void, ms: number): void;
  log?(line: string): void;
}

export class SessionRecordUploader {
  private queue: QueuedRecord[];
  private running: Promise<void> | null = null;
  private retryScheduled = false;

  constructor(private readonly deps: UploaderDeps) {
    let q: QueuedRecord[] = [];
    try { q = deps.store.load().filter((r) => r && (r.kind === 'meeting' || r.kind === 'practice') && typeof r.id === 'string'); } catch { q = []; }
    this.queue = q;
  }

  get pending(): readonly QueuedRecord[] { return this.queue; }

  /** Queues a record (only while signed in) and sends what is waiting. */
  enqueue(kind: RecordKind, id: string): Promise<void> {
    if (!id || !this.deps.signedIn()) return Promise.resolve();
    if (!this.queue.some((r) => r.kind === kind && r.id === id)) {
      this.queue.push({ kind, id, tries: 0 });
      this.persist();
    }
    return this.flush();
  }

  /** Sends everything waiting, one at a time; stops at the first failure worth retrying. */
  flush(): Promise<void> {
    if (this.running) return this.running.then(() => this.flush());
    this.running = this.drain().finally(() => { this.running = null; });
    return this.running;
  }

  private async drain(): Promise<void> {
    while (this.queue.length && this.deps.signedIn()) {
      const item = this.queue[0];
      const body = item.kind === 'meeting' ? this.deps.loadMeeting(item.id) : this.deps.loadPractice(item.id);
      if (!body) { this.drop(item, 'no longer on this computer'); continue; }
      try {
        await this.deps.upload(body);
        this.queue.shift();
        this.persist();
        this.deps.log?.(`[CloudRecords] sent ${item.kind} ${item.id}`);
      } catch (e: any) {
        item.tries += 1;
        if (!shouldRetry(e) || item.tries >= MAX_TRIES) { this.drop(item, String(e?.code ?? e?.message ?? e)); continue; }
        this.persist();
        this.deps.log?.(`[CloudRecords] will retry ${item.kind} ${item.id}: ${e?.code ?? e?.message ?? e}`);
        this.scheduleRetry();
        return;
      }
    }
  }

  private drop(item: QueuedRecord, why: string): void {
    this.queue = this.queue.filter((r) => r !== item);
    this.persist();
    this.deps.log?.(`[CloudRecords] not sent ${item.kind} ${item.id}: ${why}`);
  }

  private scheduleRetry(): void {
    if (this.retryScheduled || !this.deps.schedule) return;
    this.retryScheduled = true;
    this.deps.schedule(() => { this.retryScheduled = false; void this.flush(); }, RETRY_MS);
  }

  private persist(): void {
    try { this.deps.store.save(this.queue); } catch (e: any) { this.deps.log?.(`[CloudRecords] queue not saved: ${e?.message ?? e}`); }
  }
}

// ── The app's one uploader, wired to Electron (same globalThis anchor as cloudAccount) ──

const SLOT = Symbol.for('preppilot.sessionRecordUploader');
const anchor = globalThis as unknown as Record<symbol, SessionRecordUploader | undefined>;

export function getSessionRecordUploader(): SessionRecordUploader {
  const existing = anchor[SLOT];
  if (existing) return existing;
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const { app } = require('electron');
  const { getCloudClient, cloudModeActive } = require('./cloudAccount');
  const file = path.join(app.getPath('userData'), 'cloud-record-queue.json');
  const uploader = new SessionRecordUploader({
    signedIn: () => cloudModeActive(),
    upload: (record) => getCloudClient().uploadSessionRecord(record),
    loadMeeting: (id) => {
      const { DatabaseManager } = require('../../db/DatabaseManager');
      const db = DatabaseManager.getInstance();
      const m = db.getMeetingDetails(id);
      return m ? buildMeetingRecord(m, db.getMeetingTiming(id)) : null;
    },
    loadPractice: (id) => {
      const { DatabaseManager } = require('../../db/DatabaseManager');
      const raw = DatabaseManager.getInstance().getDb();
      if (!raw) return null;
      try {
        const { PRACTICE_TABLE } = require('../../practice/PracticeService');
        const row = raw.prepare(`SELECT session_json FROM ${PRACTICE_TABLE} WHERE id = ?`).get(id) as { session_json?: string } | undefined;
        const p = row?.session_json ? JSON.parse(row.session_json) : null;
        return p && p.status === 'finished' ? buildPracticeRecord(p) : null;
      } catch {
        return null;
      }
    },
    store: {
      load: () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : []),
      save: (q) => fs.writeFileSync(file, JSON.stringify(q)),
    },
    schedule: (fn, ms) => { const t = setTimeout(fn, ms); (t as any).unref?.(); },
    log: (line) => console.log(line),
  });
  anchor[SLOT] = uploader;
  return uploader;
}

/** Fire and forget: a finished meeting or mock interview, for the team's dashboard. */
export function shareSessionRecord(kind: RecordKind, id: string): void {
  try {
    void getSessionRecordUploader().enqueue(kind, id).catch((e) => console.warn('[CloudRecords] upload failed:', e?.message ?? e));
  } catch (e: any) {
    console.warn('[CloudRecords] not available:', e?.message ?? e);
  }
}

/** Sends what an earlier run could not (called at launch and on sign-in). */
export function flushSessionRecords(): void {
  try { void getSessionRecordUploader().flush().catch(() => {}); } catch { /* not available */ }
}
