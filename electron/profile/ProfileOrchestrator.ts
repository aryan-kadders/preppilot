// PrepPilot's Profile Intelligence engine: the public-side contract upstream's
// private premium KnowledgeOrchestrator used to fill.
//
// main.ts constructs it as `new ProfileOrchestrator(new ProfileStore(sqliteDb))`
// when premium/ is absent (always, in this fork), wires the LLM in with
// setGenerateContentFn, and hands it to LLMHelper and the IPC handlers. What
// the rest of the app relies on:
//
//   activeResume / activeJD     { id, source_uri, created_at, updated_at,
//                                 structured_data, raw_text } — read by the
//                                 manual-profile route, Cue Cards and the V3
//                                 profile retrieval (v3ProfileSources indexes
//                                 raw_text for semantic search)
//   ingestDocument(path, type)  profile:upload-resume / profile:upload-jd
//   deleteDocumentsByType(type) profile:delete / profile:delete-jd
//   getStatus(), getProfileData()
//   isKnowledgeMode(), setKnowledgeMode(on)
//   processQuestion(q)          a compact profile block for answer context
//   feedForDepthScoring(msg)    called unguarded by LLMHelper; a no-op here
//
// Company research, negotiation coaching, cover letters and role insight were
// premium extras; they are absent (callers guard for them).

import path from 'node:path';
import { extractSafeDocumentText } from '../services/SafeDocumentTextExtractor';
import {
  buildJobExtractionPrompt,
  buildProfileContextBlock,
  buildResumeExtractionPrompt,
  heuristicJobFacts,
  heuristicResumeFacts,
  normalizeJobFacts,
  normalizeResumeFacts,
  parseModelJson,
  resumeSummary,
} from './profileExtraction';
import type { ProfileStore } from './ProfileStore';
import { DocType, type GenerateContentFn, type IngestResult, type JobFacts, type ProfileDocument, type ResumeFacts } from './types';

/** How long one extraction call may take before the heuristic pass is used. */
export const EXTRACTION_TIMEOUT_MS = 90_000;

/** Below this many characters of text, a file is treated as unreadable (e.g. a scanned PDF). */
export const MIN_DOCUMENT_CHARS = 40;

export interface ProfileOrchestratorDeps {
  /** Text extraction; injectable for tests. */
  extractText?: (filePath: string) => Promise<{ content: string; fileName: string }>;
  timeoutMs?: number;
}

export class ProfileOrchestrator {
  private generateContent: GenerateContentFn | null = null;
  private knowledgeMode = false;
  private resume: ProfileDocument | null;
  private jd: ProfileDocument | null;
  private readonly ingesting = new Set<DocType>();
  private readonly extractText: (filePath: string) => Promise<{ content: string; fileName: string }>;
  private readonly timeoutMs: number;

  constructor(private readonly store: ProfileStore, deps: ProfileOrchestratorDeps = {}) {
    this.extractText = deps.extractText ?? extractSafeDocumentText;
    this.timeoutMs = deps.timeoutMs ?? EXTRACTION_TIMEOUT_MS;
    this.resume = store.get(DocType.RESUME);
    this.jd = store.get(DocType.JD);
  }

  // ── Wiring (main.ts) ──────────────────────────────────────────────────────

  setGenerateContentFn(fn: GenerateContentFn): void { this.generateContent = fn; }
  /** Embeddings are handled by the V3 profile raw index (v3ProfileSources). */
  setEmbedFn(_fn: unknown): void { /* not needed: retrieval indexes raw_text */ }
  async ensureEmbeddingSpace(): Promise<void> { /* no embedding space of its own */ }

  // ── Read side ─────────────────────────────────────────────────────────────

  get activeResume(): ProfileDocument | null { return this.resume; }
  get activeJD(): ProfileDocument | null { return this.jd; }

  isKnowledgeMode(): boolean { return this.knowledgeMode; }
  setKnowledgeMode(on: boolean): void { this.knowledgeMode = Boolean(on); }
  isIngesting(docType: DocType): boolean { return this.ingesting.has(docType); }

  getStatus() {
    const facts = this.resume?.structured_data as Partial<ResumeFacts> | undefined;
    return {
      hasResume: Boolean(this.resume),
      hasActiveJD: Boolean(this.jd),
      activeMode: this.knowledgeMode,
      resumeSummary: this.resume ? resumeSummary(facts) : null,
    };
  }

  getProfileData() {
    if (!this.resume && !this.jd) return null;
    const r = (this.resume?.structured_data ?? {}) as Partial<ResumeFacts>;
    const j = (this.jd?.structured_data ?? null) as Partial<JobFacts> | null;
    return {
      identity: { name: r.identity?.name ?? r.name ?? '', email: r.identity?.email, location: r.identity?.location },
      headline: r.headline,
      summary: r.summary,
      experience: r.experience ?? [],
      experienceCount: r.experience?.length ?? 0,
      education: r.education ?? [],
      projects: r.projects ?? [],
      skills: r.skills ?? [],
      skillsFlat: r.skills_flat ?? r.skills ?? [],
      certifications: r.certifications ?? [],
      totalExperienceYears: r.total_experience_years ?? null,
      hasActiveJD: Boolean(this.jd),
      activeJD: j ? {
        company: j.company, title: j.title, location: j.location, level: j.level,
        technologies: j.technologies ?? [], requirements: j.requirements ?? [], keywords: j.keywords ?? [],
        compensation_hint: j.compensation_hint, min_years_experience: j.min_years_experience,
      } : null,
      // Company research was a premium extra; never "running" here.
      aotStatus: { companyResearch: 'idle' },
      resumeFileName: this.resume?.file_name,
      jdFileName: this.jd?.file_name,
      extractionMode: this.resume?.extraction_mode,
    };
  }

  // ── Answers ───────────────────────────────────────────────────────────────

  /** Called unguarded by LLMHelper before processQuestion. */
  feedForDepthScoring(_message: string): void { /* no depth scorer */ }
  feedInterviewerUtterance(_text: string): void { /* no negotiation tracker */ }

  /**
   * The résumé and target job as a compact context block, while profile mode is
   * on. Null when off or empty, so the caller answers as it would without it.
   */
  async processQuestion(_question: string): Promise<{ contextBlock: string } | null> {
    if (!this.knowledgeMode || (!this.resume && !this.jd)) return null;
    const block = buildProfileContextBlock(
      (this.resume?.structured_data ?? null) as Partial<ResumeFacts> | null,
      (this.jd?.structured_data ?? null) as Partial<JobFacts> | null,
    );
    return block ? { contextBlock: block } : null;
  }

  // ── Premium extras not built yet ──────────────────────────────────────────
  // Company research, negotiation coaching and cover letters were upstream
  // premium features. The IPC handlers call these directly (inside try/catch);
  // answering "nothing yet" keeps them quiet instead of logging a TypeError on
  // every panel open. Company research is planned (TASKS.md).

  getCompanyResearchEngine() {
    return {
      searchProvider: null,
      setSearchProvider: (_p: unknown) => {},
      getCachedDossier: (_company: string) => null,
      researchCompany: async (_company: string, _jdCtx?: unknown, _force?: boolean) => null,
    };
  }
  getNegotiationScript(): null { return null; }
  async generateNegotiationScriptOnDemand(): Promise<null> { return null; }
  getCoverLetter(): null { return null; }
  async generateCoverLetterOnDemand(): Promise<null> { return null; }
  getNegotiationTracker() { return { getState: () => null, isActive: () => false }; }
  resetNegotiationSession(): void {}

  // ── Write side ────────────────────────────────────────────────────────────

  async ingestDocument(filePath: string, docType: DocType): Promise<IngestResult> {
    if (docType !== DocType.RESUME && docType !== DocType.JD) {
      return { success: false, error: `Unknown document type: ${String(docType)}` };
    }
    if (this.ingesting.has(docType)) {
      return { success: false, error: 'This document is still being processed. Try again in a moment.' };
    }
    this.ingesting.add(docType);
    try {
      let content: string;
      let fileName: string;
      try {
        ({ content, fileName } = await this.extractText(filePath));
      } catch (e: any) {
        return { success: false, error: `Could not read the file: ${e?.message || 'unknown error'}` };
      }
      const text = (content ?? '').replace(/\u0000/g, '').trim();
      if (text.length < MIN_DOCUMENT_CHARS) {
        return {
          success: false,
          error: 'No readable text was found in this file. If it is a scanned PDF, export it as a text PDF or .docx and try again.',
        };
      }

      const isResume = docType === DocType.RESUME;
      const parsed = await this.extractWithModel(isResume ? buildResumeExtractionPrompt(text) : buildJobExtractionPrompt(text));
      const structured = parsed
        ? (isResume ? normalizeResumeFacts(parsed, 'llm') : normalizeJobFacts(parsed, 'llm'))
        : (isResume ? heuristicResumeFacts(text) : heuristicJobFacts(text));

      const doc = this.store.save({
        docType,
        sourceUri: path.resolve(filePath),
        fileName: fileName || path.basename(filePath),
        rawText: text,
        structured: structured as unknown as Record<string, unknown>,
        extractionMode: structured._extraction_mode,
      });
      if (isResume) this.resume = doc; else this.jd = doc;
      return {
        success: true,
        docType,
        documentId: doc.id,
        extractionMode: doc.extraction_mode,
        degraded: doc.extraction_mode !== 'llm',
      };
    } catch (e: any) {
      return { success: false, error: e?.message || 'Upload failed' };
    } finally {
      this.ingesting.delete(docType);
    }
  }

  deleteDocumentsByType(docType: DocType): void {
    this.store.delete(docType);
    if (docType === DocType.RESUME) this.resume = null;
    if (docType === DocType.JD) this.jd = null;
  }

  /** One model call, parsed as JSON. Null on no model, timeout, error or bad JSON. */
  private async extractWithModel(prompt: string): Promise<Record<string, unknown> | null> {
    if (!this.generateContent) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const reply = await Promise.race([
        this.generateContent([{ text: prompt }]),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), this.timeoutMs); }),
      ]);
      return parseModelJson(reply);
    } catch (e: any) {
      console.warn('[ProfileOrchestrator] model extraction failed, using heuristic pass:', e?.message || e);
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
