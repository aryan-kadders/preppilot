// Mock interview (PrepPilot): practise with an AI interviewer.
//
// Setup → a question (read aloud if wanted) → answer by speaking or typing →
// instant feedback (score, strengths, improvements, STAR check, a stronger
// answer) → next question → a report. Sessions are saved locally and listed
// under "Past sessions". Talks to main through the practice:* IPC
// (electron/practice/practiceIpc.ts). Voice answers use the same microphone and
// speech pipeline as dictation; questions are read with the OS voices through
// speechSynthesis, available on macOS and Windows alike.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Check, ChevronDown, History, Loader2, Mic, Square, Trash2, Volume2, X } from 'lucide-react';
import type {
  InterviewKind, InterviewLevel, PracticeAnswer, PracticeConfig, PracticeProgress, PracticeQuestion, PracticeSession, PracticeSummary, PracticeVoiceEvent,
} from '../../types/practice';
import { SETTINGS_BTN } from '../settings/SettingsRow';
import { ProgressView } from './ProgressView';

type Stage = 'setup' | 'starting' | 'question' | 'scoring' | 'feedback' | 'report';
type VoiceState = 'idle' | 'recording' | 'transcribing';

const api = () => window.electronAPI;
const INPUT = 'w-full rounded-lg border border-border-subtle bg-bg-primary px-3 py-2 text-sm text-text-primary outline-none focus:border-text-secondary';
const LABEL = 'block text-xs font-semibold text-text-secondary mb-1';

function speak(text: string, onEnd?: () => void) {
  try {
    const synth = window.speechSynthesis;
    if (!synth) { onEnd?.(); return; }
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1;
    if (onEnd) { u.onend = () => onEnd(); u.onerror = () => onEnd(); }
    synth.speak(u);
  } catch { onEnd?.(); /* no voices: the question is on screen anyway */ }
}
function stopSpeaking() {
  try { window.speechSynthesis?.cancel(); } catch { /* nothing playing */ }
}

const scoreTone = (s: number) => (s >= 8 ? 'text-emerald-400' : s >= 5 ? 'text-amber-400' : 'text-red-400');

export const MockInterviewPanel: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [stage, setStage] = useState<Stage>('setup');
  const [error, setError] = useState('');
  const [config, setConfig] = useState<PracticeConfig>({ role: '', company: '', level: 'mid', kind: 'mixed', questionCount: 5, useProfile: true });
  const [readAloud, setReadAloud] = useState(true);
  // Hands-free: recording starts once the question has been read, stops when
  // the speaker goes quiet (main: endOfAnswer.ts), and the answer is submitted.
  const [handsFree, setHandsFree] = useState(true);
  const handsFreeRef = useRef(handsFree);
  handsFreeRef.current = handsFree;
  const autoSubmitRef = useRef<(text: string) => void>(() => {});
  // Whether this question's answer was spoken, and for how long (pace).
  const spokenRef = useRef<{ spoken: boolean; ms: number }>({ spoken: false, ms: 0 });
  const [hasProfile, setHasProfile] = useState(false);
  const [session, setSession] = useState<PracticeSession | null>(null);
  const [index, setIndex] = useState(0);
  const [answer, setAnswer] = useState('');
  const [lastAnswer, setLastAnswer] = useState<PracticeAnswer | null>(null);
  const [voice, setVoice] = useState<VoiceState>('idle');
  const [history, setHistory] = useState<PracticeSummary[]>([]);
  const [progress, setProgress] = useState<PracticeProgress | null>(null);
  const [showBetter, setShowBetter] = useState(false);
  const answerRef = useRef<HTMLTextAreaElement>(null);

  const question: PracticeQuestion | null = session?.questions[index] ?? null;

  // Prefill role/company from the uploaded JD, and know whether a profile exists.
  useEffect(() => {
    void (async () => {
      try {
        const [status, profile] = await Promise.all([api()?.profileGetStatus?.(), api()?.profileGetProfile?.()]);
        setHasProfile(!!status?.hasProfile || !!profile?.hasActiveJD);
        const jd = profile?.activeJD;
        setConfig((c) => ({ ...c, role: c.role || jd?.title || profile?.experience?.[0]?.role || '', company: c.company || jd?.company || '' }));
      } catch { /* no profile: the fields stay empty */ }
    })();
  }, []);

  const loadHistory = useCallback(async () => {
    const [res, prog] = await Promise.all([
      api()?.practiceHistory?.().catch(() => null),
      api()?.practiceProgress?.().catch(() => null),
    ]);
    if (res?.ok) setHistory(res.sessions);
    if (prog?.ok) setProgress(prog.progress);
  }, []);
  useEffect(() => { void loadHistory(); }, [loadHistory]);

  // Voice answers: events from main.
  useEffect(() => {
    const off = api()?.onPracticeVoice?.((e: PracticeVoiceEvent) => {
      if (e.state === 'recording') setVoice('recording');
      else if (e.state === 'transcribing') setVoice('transcribing');
      else if (e.state === 'done') {
        setVoice('idle');
        spokenRef.current = { spoken: true, ms: spokenRef.current.ms + (typeof e.durationMs === 'number' ? e.durationMs : 0) };
        if (handsFreeRef.current) { autoSubmitRef.current(e.text); return; }
        setAnswer((a) => (a.trim() ? `${a.trim()} ${e.text}` : e.text));
        answerRef.current?.focus();
      } else if (e.state === 'error') {
        setVoice('idle');
        setError(e.message || "Couldn't record your answer. You can type it instead.");
      }
    });
    return () => { try { off?.(); } catch { /* gone */ } };
  }, []);

  // Stop talking and recording when the panel closes.
  useEffect(() => () => { stopSpeaking(); void api()?.practiceVoiceCancel?.(); }, []);

  // Each new question: read it aloud, then (hands-free) start recording.
  useEffect(() => {
    if (stage !== 'question' || !question) return;
    spokenRef.current = { spoken: false, ms: 0 };
    let cancelled = false;
    const listen = () => {
      if (cancelled || !handsFreeRef.current) return;
      void api()?.practiceVoiceToggle?.().then((res: any) => {
        if (!cancelled && !res?.ok) setError(res?.error || "Couldn't start the microphone. You can type your answer instead.");
      });
    };
    if (readAloud) speak(question.text, listen);
    else if (handsFree) { const t = window.setTimeout(listen, 600); return () => { cancelled = true; window.clearTimeout(t); }; }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, question?.id]);

  const start = async () => {
    setError('');
    setStage('starting');
    const res = await api()?.practiceStart?.(config).catch((e: any) => ({ ok: false as const, error: e?.message || 'Could not start.' }));
    if (!res?.ok) { setError(res?.error || 'Could not start the interview.'); setStage('setup'); return; }
    setSession(res.session);
    setIndex(0);
    setAnswer('');
    setLastAnswer(null);
    setStage('question');
  };

  const toggleVoice = async () => {
    setError('');
    stopSpeaking();
    const res = await api()?.practiceVoiceToggle?.().catch((e: any) => ({ ok: false as const, error: e?.message }));
    if (!res?.ok) setError(res?.error || "Couldn't use the microphone. You can type your answer instead.");
  };

  const submit = async (spoken?: string) => {
    if (!session || !question) return;
    const text = (spoken ?? answer).trim();
    if (!text) { setError('Say or type your answer first.'); return; }
    if (spoken === undefined && voice !== 'idle') { setError('Stop recording first.'); return; }
    if (spoken !== undefined) setAnswer(text);
    setError('');
    stopSpeaking();
    setStage('scoring');
    const meta = spokenRef.current.spoken ? { spoken: true, durationMs: spokenRef.current.ms || null } : undefined;
    const res = await api()?.practiceAnswer?.(session.id, question.id, text, meta).catch((e: any) => ({ ok: false as const, error: e?.message }));
    if (!res?.ok) { setError(res?.error || 'Could not save your answer.'); setStage('question'); return; }
    setSession(res.session);
    setLastAnswer(res.answer);
    setShowBetter(false);
    setStage('feedback');
  };

  // The voice listener is set up once; it submits through the latest submit().
  autoSubmitRef.current = (text: string) => { void submit(text); };

  const next = async () => {
    if (!session) return;
    if (index + 1 < session.questions.length) {
      setIndex(index + 1);
      setAnswer('');
      setLastAnswer(null);
      setStage('question');
      return;
    }
    await finish();
  };

  const finish = async () => {
    if (!session) return;
    stopSpeaking();
    const res = await api()?.practiceFinish?.(session.id).catch(() => null);
    if (res?.ok) setSession(res.session);
    setStage('report');
    void loadHistory();
  };

  const openPast = async (id: string) => {
    const res = await api()?.practiceGet?.(id).catch(() => null);
    if (!res?.ok) return;
    setSession(res.session);
    if (res.session.status === 'finished') { setStage('report'); return; }
    const next = res.session.questions.findIndex((q) => !res.session.answers.some((a) => a.questionId === q.id));
    setIndex(next < 0 ? 0 : next);
    setAnswer('');
    setStage(next < 0 ? 'report' : 'question');
  };

  const removePast = async (id: string) => {
    await api()?.practiceDelete?.(id).catch(() => null);
    void loadHistory();
  };

  const reset = () => { stopSpeaking(); setSession(null); setStage('setup'); setError(''); setAnswer(''); };

  const questionById = useMemo(() => new Map((session?.questions ?? []).map((q) => [q.id, q])), [session]);

  return (
    <div className="flex h-full w-full flex-col text-text-primary">
      <header className="flex items-center justify-between border-b border-border-subtle px-6 py-4">
        <div>
          <h2 className="text-[17px] font-bold">Mock interview</h2>
          <p className="text-xs text-text-secondary">
            {stage === 'setup' || stage === 'starting'
              ? 'Practise with an AI interviewer and get feedback on every answer.'
              : session ? `${session.config.role}${session.config.company ? ` · ${session.config.company}` : ''}` : ''}
          </p>
        </div>
        <button type="button" className={SETTINGS_BTN} onClick={() => { stopSpeaking(); onClose(); }} aria-label="Close mock interview">
          <X size={14} aria-hidden /> Close
        </button>
      </header>

      <main className="flex-1 overflow-y-auto px-6 py-5">
        {error && <div role="alert" className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</div>}

        {(stage === 'setup' || stage === 'starting') && (
          <div className="grid gap-6 md:grid-cols-[1fr_260px]">
            <section className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={LABEL} htmlFor="pi-role">Role</label>
                  <input id="pi-role" className={INPUT} value={config.role} placeholder="e.g. Frontend Engineer" onChange={(e) => setConfig({ ...config, role: e.target.value })} />
                </div>
                <div>
                  <label className={LABEL} htmlFor="pi-company">Company (optional)</label>
                  <input id="pi-company" className={INPUT} value={config.company ?? ''} placeholder="e.g. Google" onChange={(e) => setConfig({ ...config, company: e.target.value })} />
                </div>
              </div>
              {/* Segmented choices, not native <select>: an OS-drawn select popup
                  shows up in screen shares (NoNativePopups2026_09_27.test.mjs). */}
              <Segmented label="Level" value={config.level} onChange={(v) => setConfig({ ...config, level: v as InterviewLevel })}
                options={[['entry', 'Entry / graduate'], ['mid', 'Mid-level'], ['senior', 'Senior']]} />
              <Segmented label="Questions" value={config.kind} onChange={(v) => setConfig({ ...config, kind: v as InterviewKind })}
                options={[['mixed', 'Mixed'], ['behavioral', 'Behavioural'], ['technical', 'Technical']]} />
              <Segmented label="How many" value={String(config.questionCount)} onChange={(v) => setConfig({ ...config, questionCount: Number(v) })}
                options={[['3', '3'], ['5', '5'], ['7', '7'], ['10', '10']]} />
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={config.useProfile} onChange={(e) => setConfig({ ...config, useProfile: e.target.checked })} />
                Use my résumé and job description {hasProfile ? '' : <span className="text-xs text-text-tertiary">(none uploaded yet)</span>}
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={readAloud} onChange={(e) => setReadAloud(e.target.checked)} />
                Read questions aloud
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={handsFree} onChange={(e) => setHandsFree(e.target.checked)} />
                Hands-free: listen after each question and submit when I stop talking
              </label>
              <button type="button" className={`${SETTINGS_BTN} px-4 py-2 text-sm`} onClick={() => void start()} disabled={stage === 'starting'}>
                {stage === 'starting' ? <><Loader2 size={14} className="animate-spin" aria-hidden /> Preparing your questions…</> : <>Start interview <ArrowRight size={14} aria-hidden /></>}
              </button>
            </section>

            <aside className="space-y-5">
              {progress && progress.sessions > 0 && <ProgressView progress={progress} />}
              <div>
              <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-text-secondary"><History size={13} aria-hidden /> Past sessions</h3>
              {history.length === 0 ? (
                <p className="text-xs text-text-tertiary">Your sessions and scores will show here.</p>
              ) : (
                <ul className="space-y-1.5">
                  {history.map((h) => (
                    <li key={h.id} className="group flex items-center gap-2 rounded-lg border border-border-subtle px-2.5 py-2">
                      <button type="button" className="min-w-0 flex-1 text-left" onClick={() => void openPast(h.id)}>
                        <div className="truncate text-xs font-semibold">{h.role}{h.company ? ` · ${h.company}` : ''}</div>
                        <div className="text-[11px] text-text-tertiary">
                          {new Date(h.createdAt).toLocaleDateString()} · {h.answered}/{h.total} answered
                          {h.averageScore !== null && <> · <span className={scoreTone(h.averageScore)}>{h.averageScore}/10</span></>}
                        </div>
                      </button>
                      <button type="button" aria-label="Delete session" className="text-text-tertiary opacity-0 group-hover:opacity-100 hover:text-red-400" onClick={() => void removePast(h.id)}>
                        <Trash2 size={13} aria-hidden />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              </div>
            </aside>
          </div>
        )}

        {(stage === 'question' || stage === 'scoring') && session && question && (
          <section className="mx-auto max-w-2xl space-y-4">
            <div className="flex items-center justify-between text-xs text-text-secondary">
              <span>Question {index + 1} of {session.questions.length} · {question.kind === 'intro' ? 'Introduction' : question.kind[0].toUpperCase() + question.kind.slice(1)}</span>
              <button type="button" className="inline-flex items-center gap-1 hover:text-text-primary" onClick={() => speak(question.text)}><Volume2 size={13} aria-hidden /> Read aloud</button>
            </div>
            {session.usedFallbackQuestions && index === 0 && (
              <p className="text-[11px] text-text-tertiary">Using built-in questions: connect an AI for questions tailored to your role and feedback on your answers.</p>
            )}
            <p className="text-lg font-semibold leading-snug">{question.text}</p>
            <textarea
              ref={answerRef}
              className={`${INPUT} min-h-[150px] resize-y leading-relaxed`}
              placeholder="Speak your answer, or type it here…"
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              disabled={stage === 'scoring'}
            />
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className={`${SETTINGS_BTN} ${voice === 'recording' ? 'border-red-400 text-red-300' : ''}`} onClick={() => void toggleVoice()} disabled={stage === 'scoring' || voice === 'transcribing'}>
                {voice === 'recording' ? <><Square size={12} aria-hidden /> Stop recording</> : voice === 'transcribing' ? <><Loader2 size={12} className="animate-spin" aria-hidden /> Writing it down…</> : <><Mic size={12} aria-hidden /> Speak answer</>}
              </button>
              <button type="button" className={`${SETTINGS_BTN} px-4`} onClick={() => void submit()} disabled={stage === 'scoring' || voice !== 'idle'}>
                {stage === 'scoring' ? <><Loader2 size={12} className="animate-spin" aria-hidden /> Getting feedback…</> : <>Submit answer <ArrowRight size={12} aria-hidden /></>}
              </button>
              <button type="button" className="ml-auto text-xs text-text-tertiary hover:text-text-secondary" onClick={() => void finish()}>End interview</button>
            </div>
            {voice === 'recording' && <p className="text-xs text-red-300">Listening… answer as you would in the interview. It stops by itself when you finish.</p>}
          </section>
        )}

        {stage === 'feedback' && session && question && lastAnswer && (
          <section className="mx-auto max-w-2xl space-y-4">
            <p className="text-xs text-text-secondary">Question {index + 1} of {session.questions.length}</p>
            <p className="text-base font-semibold">{question.text}</p>
            {lastAnswer.feedback ? (
              <FeedbackView feedback={lastAnswer.feedback} focus={question.focus} showBetter={showBetter} onToggleBetter={() => setShowBetter((v) => !v)} />
            ) : null}
            {lastAnswer.delivery && <DeliveryView delivery={lastAnswer.delivery} />}
            {lastAnswer.feedback ? null : (
              <p className="rounded-lg border border-border-subtle px-3 py-2 text-sm text-text-secondary">{lastAnswer.feedbackError || 'No feedback for this answer.'}</p>
            )}
            <div className="flex gap-2">
              <button type="button" className={`${SETTINGS_BTN} px-4`} onClick={() => void next()}>
                {index + 1 < session.questions.length ? <>Next question <ArrowRight size={12} aria-hidden /></> : <>See my report <ArrowRight size={12} aria-hidden /></>}
              </button>
              <button type="button" className={SETTINGS_BTN} onClick={() => { setStage('question'); }}>Try this one again</button>
            </div>
          </section>
        )}

        {stage === 'report' && session && (
          <ReportView session={session} questionById={questionById} onAgain={reset} />
        )}
      </main>
    </div>
  );
};

const Segmented: React.FC<{ label: string; value: string; options: Array<[string, string]>; onChange: (v: string) => void }> = ({ label, value, options, onChange }) => (
  <div>
    <span className={LABEL}>{label}</span>
    <div role="radiogroup" aria-label={label} className="inline-flex flex-wrap gap-1 rounded-lg border border-border-subtle p-1">
      {options.map(([id, name]) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={value === id}
          onClick={() => onChange(id)}
          className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${value === id ? 'bg-bg-secondary text-text-primary' : 'text-text-secondary hover:text-text-primary'}`}
        >
          {name}
        </button>
      ))}
    </div>
  </div>
);

const PACE_TEXT: Record<'slow' | 'good' | 'fast', string> = { slow: 'a bit slow', good: 'a good pace', fast: 'a bit fast' };

const DeliveryView: React.FC<{ delivery: NonNullable<PracticeAnswer['delivery']> }> = ({ delivery }) => (
  <div className="rounded-lg border border-border-subtle px-3 py-2.5">
    <h4 className="mb-1.5 text-xs font-semibold text-text-secondary">Delivery</h4>
    <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
      {delivery.wpm !== null && delivery.pace && (
        <span>Pace: <b className={delivery.pace === 'good' ? 'text-emerald-400' : 'text-amber-400'}>{delivery.wpm} wpm</b> <span className="text-text-tertiary">({PACE_TEXT[delivery.pace]})</span></span>
      )}
      <span>Filler words: <b className={delivery.fillerRate >= 5 ? 'text-amber-400' : 'text-emerald-400'}>{delivery.fillerCount}</b>
        {delivery.fillers.length > 0 && <span className="text-text-tertiary"> ({delivery.fillers.slice(0, 3).map((f) => `${f.word} ×${f.count}`).join(', ')})</span>}
      </span>
      <span>Length: <b className={delivery.length === 'good' ? 'text-emerald-400' : 'text-amber-400'}>{delivery.wordCount} words</b></span>
    </div>
    {delivery.tips.length > 0 && <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-xs text-text-secondary">{delivery.tips.map((t) => <li key={t}>{t}</li>)}</ul>}
  </div>
);

const FeedbackView: React.FC<{ feedback: NonNullable<PracticeAnswer['feedback']>; focus: string; showBetter: boolean; onToggleBetter: () => void }> = ({ feedback, focus, showBetter, onToggleBetter }) => (
  <div className="space-y-3">
    <div className="flex items-baseline gap-3">
      <span className={`text-3xl font-bold ${scoreTone(feedback.score)}`}>{feedback.score}<span className="text-base text-text-tertiary">/10</span></span>
      <span className="text-sm text-text-secondary">{feedback.verdict}</span>
    </div>
    {feedback.star && (
      <div className="flex flex-wrap gap-1.5 text-[11px]" aria-label="STAR structure">
        {(['situation', 'task', 'action', 'result'] as const).map((k) => (
          <span key={k} className={`rounded-full border px-2 py-0.5 ${feedback.star![k] ? 'border-emerald-500/40 text-emerald-300' : 'border-border-subtle text-text-tertiary line-through'}`}>
            {k[0].toUpperCase() + k.slice(1)}
          </span>
        ))}
      </div>
    )}
    {feedback.strengths.length > 0 && (
      <div>
        <h4 className="mb-1 text-xs font-semibold text-emerald-300">What went well</h4>
        <ul className="space-y-1 text-sm">{feedback.strengths.map((s) => <li key={s} className="flex gap-1.5"><Check size={14} className="mt-0.5 shrink-0 text-emerald-400" aria-hidden />{s}</li>)}</ul>
      </div>
    )}
    {feedback.improvements.length > 0 && (
      <div>
        <h4 className="mb-1 text-xs font-semibold text-amber-300">To improve</h4>
        <ul className="list-disc space-y-1 pl-5 text-sm">{feedback.improvements.map((s) => <li key={s}>{s}</li>)}</ul>
      </div>
    )}
    <p className="text-xs text-text-tertiary">A strong answer shows: {focus}</p>
    {feedback.betterAnswer && (
      <div>
        <button type="button" className="inline-flex items-center gap-1 text-xs font-semibold text-text-secondary hover:text-text-primary" onClick={onToggleBetter} aria-expanded={showBetter}>
          <ChevronDown size={13} className={showBetter ? 'rotate-180' : ''} aria-hidden /> {showBetter ? 'Hide' : 'Show'} a stronger answer
        </button>
        {showBetter && <p className="mt-2 whitespace-pre-wrap rounded-lg border border-border-subtle bg-bg-primary px-3 py-2 text-sm leading-relaxed">{feedback.betterAnswer}</p>}
      </div>
    )}
  </div>
);

const ReportView: React.FC<{ session: PracticeSession; questionById: Map<string, PracticeQuestion>; onAgain: () => void }> = ({ session, questionById, onAgain }) => {
  const r = session.report;
  return (
    <section className="mx-auto max-w-2xl space-y-5">
      <div className="flex items-baseline gap-3">
        <span className={`text-4xl font-bold ${r?.averageScore != null ? scoreTone(r.averageScore) : 'text-text-tertiary'}`}>{r?.averageScore ?? '–'}<span className="text-lg text-text-tertiary">/10</span></span>
        <span className="text-sm text-text-secondary">Average score · {r?.answered ?? session.answers.length} of {session.questions.length} questions answered</span>
      </div>
      {r?.starCoverage && (
        <p className="text-sm text-text-secondary">STAR structure: {r.starCoverage.complete} of {r.starCoverage.behavioral} behavioural answers covered all four parts.</p>
      )}
      {r?.delivery && (
        <p className="text-sm text-text-secondary">
          Delivery across {r.delivery.spokenAnswers} spoken {r.delivery.spokenAnswers === 1 ? 'answer' : 'answers'}:
          {r.delivery.averageWpm !== null && <> about <b className="text-text-primary">{r.delivery.averageWpm} words a minute</b>,</>}
          {' '}<b className="text-text-primary">{r.delivery.totalFillers}</b> filler {r.delivery.totalFillers === 1 ? 'word' : 'words'}
          {r.delivery.topFillers.length > 0 && <> (mostly {r.delivery.topFillers.map((f) => `"${f.word}"`).join(', ')})</>}
          {r.delivery.longAnswers > 0 && <>, {r.delivery.longAnswers} long {r.delivery.longAnswers === 1 ? 'answer' : 'answers'}</>}.
        </p>
      )}
      {r?.focusAreas && r.focusAreas.length > 0 && (
        <div>
          <h3 className="mb-1 text-xs font-semibold text-amber-300">Focus on next time</h3>
          <ul className="list-disc space-y-1 pl-5 text-sm">{r.focusAreas.map((f) => <li key={f}>{f}</li>)}</ul>
        </div>
      )}
      <div>
        <h3 className="mb-2 text-xs font-semibold text-text-secondary">Question by question</h3>
        <ul className="space-y-2">
          {session.questions.map((q) => {
            const a = session.answers.find((x) => x.questionId === q.id);
            return (
              <li key={q.id} className="rounded-lg border border-border-subtle px-3 py-2">
                <div className="flex items-start justify-between gap-3">
                  <span className="text-sm">{questionById.get(q.id)?.text}</span>
                  <span className={`shrink-0 text-sm font-bold ${a?.feedback ? scoreTone(a.feedback.score) : 'text-text-tertiary'}`}>{a?.feedback ? `${a.feedback.score}/10` : a ? '–' : 'Skipped'}</span>
                </div>
                {a?.feedback?.verdict && <p className="mt-1 text-xs text-text-secondary">{a.feedback.verdict}</p>}
              </li>
            );
          })}
        </ul>
      </div>
      <button type="button" className={`${SETTINGS_BTN} px-4`} onClick={onAgain}>Practise again <ArrowRight size={12} aria-hidden /></button>
    </section>
  );
};
