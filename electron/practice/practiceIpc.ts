// IPC for the mock interview (PrepPilot). Registered from ipcHandlers.ts.
//
//   practice:start         (config)                          → { ok, session }
//   practice:answer        (sessionId, questionId, text)     → { ok, session, answer }
//   practice:finish        (sessionId)                       → { ok, session }
//   practice:get           (sessionId)                       → { ok, session }
//   practice:history       ()                                → { ok, sessions }
//   practice:delete        (sessionId)                       → { ok }
//   practice:progress      ()                                → { ok, progress }
//   practice:voice-toggle  ()                                → { ok, state }
//   'practice-voice' event: { state, text?, message?, kind? }
//
// Voice answers reuse dictation's microphone and speech pipeline
// (wireDictationTo): the same native or fallback capture on macOS and Windows,
// the user's speech provider (or the on-device default).

import { BrowserWindow } from 'electron';
import { PracticeService } from './PracticeService';
import { buildProfileContextBlock } from '../profile/profileExtraction';
import type { DictationController } from '../services/dictation/DictationController';
import { EndOfAnswerDetector } from './endOfAnswer';

/** Quiet after speech that ends a spoken answer. */
const SILENCE_MS = 2_200;

type SafeHandle = (channel: string, handler: (event: any, ...args: any[]) => any) => void;

interface AppStateLike {
  processingHelper: { getLLMHelper(): any };
  getKnowledgeOrchestrator(): any;
}

const errorOf = (e: any) => String(e?.message || e || 'Something went wrong.');

function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    try { if (!w.isDestroyed()) w.webContents.send(channel, payload); } catch { /* window going away */ }
  }
}

export function registerPracticeIpc(safeHandle: SafeHandle, appState: AppStateLike): void {
  let service: PracticeService | null = null;
  const getService = (): PracticeService => {
    if (service) return service;
    const { DatabaseManager } = require('../db/DatabaseManager');
    const db = DatabaseManager.getInstance().getDb();
    if (!db) throw new Error('Local storage is not ready yet. Try again in a moment.');
    service = new PracticeService({
      db,
      generate: () => {
        const llm = appState.processingHelper?.getLLMHelper?.();
        if (!llm?.hasAnyConfiguredProvider?.()) return null;
        return (prompt: string) => llm.generateContentStructured(prompt);
      },
      profileBlock: () => {
        try {
          const o = appState.getKnowledgeOrchestrator?.();
          return buildProfileContextBlock(o?.activeResume?.structured_data ?? null, o?.activeJD?.structured_data ?? null);
        } catch {
          return '';
        }
      },
    });
    return service;
  };

  safeHandle('practice:start', async (_e, config: unknown) => {
    try {
      return { ok: true, session: await getService().start((config ?? {}) as any) };
    } catch (e) {
      return { ok: false, error: errorOf(e) };
    }
  });

  safeHandle('practice:answer', async (_e, sessionId: string, questionId: string, text: string, meta?: { spoken?: boolean; durationMs?: number }) => {
    try {
      const m = meta && typeof meta === 'object'
        ? { spoken: meta.spoken === true, durationMs: Number.isFinite(Number(meta.durationMs)) ? Number(meta.durationMs) : null }
        : undefined;
      const { session, answer } = await getService().answer(String(sessionId), String(questionId), String(text ?? ''), m);
      return { ok: true, session, answer };
    } catch (e) {
      return { ok: false, error: errorOf(e) };
    }
  });

  safeHandle('practice:finish', async (_e, sessionId: string) => {
    try {
      return { ok: true, session: getService().finish(String(sessionId)) };
    } catch (e) {
      return { ok: false, error: errorOf(e) };
    }
  });

  safeHandle('practice:get', async (_e, sessionId: string) => {
    try {
      const session = getService().get(String(sessionId));
      return session ? { ok: true, session } : { ok: false, error: 'This practice session no longer exists.' };
    } catch (e) {
      return { ok: false, error: errorOf(e) };
    }
  });

  safeHandle('practice:history', async () => {
    try {
      return { ok: true, sessions: getService().history() };
    } catch (e) {
      return { ok: false, error: errorOf(e), sessions: [] };
    }
  });

  safeHandle('practice:progress', async () => {
    try {
      const { computeProgress } = require('./progress') as typeof import('./progress');
      return { ok: true, progress: computeProgress(getService().all()) };
    } catch (e) {
      return { ok: false, error: errorOf(e) };
    }
  });

  safeHandle('practice:delete', async (_e, sessionId: string) => {
    try {
      return { ok: getService().delete(String(sessionId)) };
    } catch (e) {
      return { ok: false, error: errorOf(e) };
    }
  });

  // ── Voice answers ─────────────────────────────────────────────────────────
  let voice: DictationController | null = null;
  // A recording ends by itself when the speaker stops talking (endOfAnswer.ts):
  // the Stop button still works, but is no longer needed.
  let detector: EndOfAnswerDetector | null = null;
  // Speaking time of the current recording, for the pace figure: from the
  // start to the stop, less the quiet the auto-stop waited through.
  let recordingStartedAt = 0;
  let speakingMs: number | null = null;
  const stopVoice = (reason: 'answer-ended' | 'no-speech') => {
    if (!voice || voice.current !== 'recording') return;
    speakingMs = recordingStartedAt ? Math.max(0, Date.now() - recordingStartedAt - (reason === 'answer-ended' ? SILENCE_MS : 0)) : null;
    broadcast('practice-voice', { state: 'transcribing', reason });
    void voice.press().catch(() => { /* the controller reports its own failures */ });
  };
  const getVoice = (): DictationController | null => {
    if (voice) return voice;
    const dictation = require('../services/dictation/wireDictation');
    const wiring = dictation.dictationWiring();
    if (!wiring) return null;
    voice = dictation.wireDictationTo(
      wiring,
      (text: string) => broadcast('practice-voice', { state: 'done', text, durationMs: speakingMs }),
      (kind: string, notice: { title: string; body: string }) => {
        if (kind === 'recording') { recordingStartedAt = Date.now(); speakingMs = null; broadcast('practice-voice', { state: 'recording' }); }
        else if (kind !== 'copied') broadcast('practice-voice', { state: 'error', kind, message: notice.body || notice.title });
      },
      (chunk: Buffer) => {
        if (!detector || voice?.current !== 'recording') return;
        const verdict = detector.push(chunk);
        if (verdict !== 'continue') stopVoice(verdict);
      },
    ) as DictationController;
    return voice;
  };

  safeHandle('practice:voice-toggle', async () => {
    try {
      const v = getVoice();
      if (!v) return { ok: false, error: 'The microphone is not ready yet. Try again in a moment.' };
      // Stopping hands over to transcription; say so before waiting on it, as
      // press() can resolve only after the text has arrived (a 'done' event).
      if (v.current === 'recording') {
        speakingMs = recordingStartedAt ? Date.now() - recordingStartedAt : null;
        broadcast('practice-voice', { state: 'transcribing' });
      } else {
        detector = new EndOfAnswerDetector({ silenceMs: SILENCE_MS });
      }
      await v.press();
      return { ok: true, state: v.current };
    } catch (e) {
      return { ok: false, error: errorOf(e) };
    }
  });

  safeHandle('practice:voice-cancel', async () => {
    try { voice?.cancel(); } catch { /* nothing to cancel */ }
    return { ok: true };
  });
}
