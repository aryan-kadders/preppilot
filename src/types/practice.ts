// Mock interview types shared by the preload bridge and the practice panel.
// Mirrors electron/practice/mockInterview.ts and PracticeService.ts.

export type InterviewKind = 'behavioral' | 'technical' | 'mixed';
export type InterviewLevel = 'entry' | 'mid' | 'senior';

export interface PracticeConfig {
  role: string;
  company?: string;
  level: InterviewLevel;
  kind: InterviewKind;
  questionCount: number;
  useProfile: boolean;
}

export interface PracticeQuestion {
  id: string;
  text: string;
  kind: 'behavioral' | 'technical' | 'situational' | 'intro';
  focus: string;
}

export interface AnswerFeedback {
  score: number;
  verdict: string;
  strengths: string[];
  improvements: string[];
  betterAnswer: string;
  star?: { situation: boolean; task: boolean; action: boolean; result: boolean };
}

export interface PracticeAnswer {
  questionId: string;
  answer: string;
  feedback: AnswerFeedback | null;
  feedbackError?: string;
  answeredAt: string;
  delivery?: DeliveryStats;
}

export interface DeliveryStats {
  wordCount: number;
  durationMs: number | null;
  wpm: number | null;
  pace: 'slow' | 'good' | 'fast' | null;
  fillerCount: number;
  fillerRate: number;
  fillers: Array<{ word: string; count: number }>;
  length: 'short' | 'good' | 'long';
  tips: string[];
}

export interface DeliverySummary {
  spokenAnswers: number;
  averageWpm: number | null;
  totalFillers: number;
  topFillers: Array<{ word: string; count: number }>;
  longAnswers: number;
  shortAnswers: number;
}

export interface PracticeReport {
  averageScore: number | null;
  answered: number;
  total: number;
  strongest: { questionId: string; score: number } | null;
  weakest: { questionId: string; score: number } | null;
  focusAreas: string[];
  starCoverage: { behavioral: number; complete: number } | null;
  delivery: DeliverySummary | null;
}

export interface PracticeSession {
  id: string;
  createdAt: string;
  updatedAt: string;
  config: PracticeConfig;
  questions: PracticeQuestion[];
  answers: PracticeAnswer[];
  usedFallbackQuestions: boolean;
  report: PracticeReport | null;
  status: 'active' | 'finished';
}

export interface PracticeSummary {
  id: string;
  createdAt: string;
  role: string;
  company?: string;
  kind: InterviewKind;
  averageScore: number | null;
  answered: number;
  total: number;
  status: 'active' | 'finished';
}

export type PracticeVoiceEvent =
  | { state: 'recording' }
  | { state: 'transcribing' }
  | { state: 'done'; text: string; durationMs?: number | null }
  | { state: 'error'; kind?: string; message: string };

export interface ProgressPoint {
  id: string;
  createdAt: string;
  role: string;
  kind: InterviewKind;
  averageScore: number;
}

export interface PracticeProgress {
  sessions: number;
  answers: number;
  averageScore: number | null;
  recent: ProgressPoint[];
  byKind: Array<{ kind: InterviewKind; sessions: number; averageScore: number }>;
  trend: number | null;
  focusAreas: string[];
  averageWpm: number | null;
}

export type PracticeResult<T> = ({ ok: true } & T) | { ok: false; error: string };

export interface PracticeApi {
  practiceStart: (config: Partial<PracticeConfig>) => Promise<PracticeResult<{ session: PracticeSession }>>;
  practiceAnswer: (sessionId: string, questionId: string, text: string, meta?: { spoken?: boolean; durationMs?: number | null }) => Promise<PracticeResult<{ session: PracticeSession; answer: PracticeAnswer }>>;
  practiceFinish: (sessionId: string) => Promise<PracticeResult<{ session: PracticeSession }>>;
  practiceGet: (sessionId: string) => Promise<PracticeResult<{ session: PracticeSession }>>;
  practiceHistory: () => Promise<PracticeResult<{ sessions: PracticeSummary[] }>>;
  practiceProgress: () => Promise<PracticeResult<{ progress: PracticeProgress }>>;
  practiceDelete: (sessionId: string) => Promise<{ ok: boolean; error?: string }>;
  practiceVoiceToggle: () => Promise<PracticeResult<{ state: string }>>;
  practiceVoiceCancel: () => Promise<{ ok: boolean }>;
  onPracticeVoice: (callback: (event: PracticeVoiceEvent) => void) => () => void;
}
