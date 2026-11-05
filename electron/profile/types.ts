// PrepPilot Profile Intelligence: résumé and job-description (JD) documents.
//
// Upstream Natively shipped this as the private premium KnowledgeOrchestrator.
// This is PrepPilot's own implementation of the same public contract: the rest
// of the app reads `activeResume` / `activeJD` (structured_data + raw_text) and
// calls the methods listed in ProfileOrchestrator.ts. No platform branches: all
// file access goes through SafeDocumentTextExtractor and node:path.

/** Document kinds. The string values match what upstream stored. */
export enum DocType {
  RESUME = 'resume',
  JD = 'jd',
}

export type ExtractionMode = 'llm' | 'heuristic';

/** One stored document, in the shape the app reads as activeResume / activeJD. */
export interface ProfileDocument {
  id: string;
  doc_type: DocType;
  source_uri: string;
  file_name: string;
  raw_text: string;
  structured_data: Record<string, unknown>;
  extraction_mode: ExtractionMode;
  created_at: string;
  updated_at: string;
}

export interface ResumeExperience {
  role: string;
  company: string;
  start_date?: string;
  end_date?: string;
  location?: string;
  bullets: string[];
}

export interface ResumeProject {
  name: string;
  description: string;
  technologies: string[];
}

export interface ResumeEducation {
  institution: string;
  degree?: string;
  field?: string;
  end_date?: string;
}

/** Résumé facts, in the field names manualProfileIntelligence.ts reads. */
export interface ResumeFacts {
  identity: { name?: string; email?: string; phone?: string; location?: string; links?: string[] };
  name?: string;
  headline?: string;
  summary?: string;
  skills: string[];
  skills_flat: string[];
  experience: ResumeExperience[];
  projects: ResumeProject[];
  education: ResumeEducation[];
  certifications: string[];
  total_experience_years?: number;
  _extraction_mode: ExtractionMode;
}

/** JD facts, in the field names manualProfileIntelligence.ts reads. */
export interface JobFacts {
  title?: string;
  company?: string;
  location?: string;
  level?: string;
  employment_type?: string;
  min_years_experience?: number;
  compensation_hint?: string;
  description_summary?: string;
  requirements: string[];
  nice_to_haves: string[];
  responsibilities: string[];
  technologies: string[];
  keywords: string[];
  _extraction_mode: ExtractionMode;
}

export interface IngestResult {
  success: boolean;
  error?: string;
  docType?: DocType;
  documentId?: string;
  extractionMode?: ExtractionMode;
  /** True when the model could not structure the text and a heuristic pass was used. */
  degraded?: boolean;
}

/** Generates text from a list of content parts (main.ts wires LLMHelper). */
export type GenerateContentFn = (contents: Array<{ text: string } | string>) => Promise<string>;
