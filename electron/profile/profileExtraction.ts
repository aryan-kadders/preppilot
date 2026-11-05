// Pure résumé / JD extraction helpers: the prompts, the model-output parser,
// normalisation into the field names the rest of the app reads, a heuristic
// fallback for when no model answers, and the context block answers are given.
// No I/O and no platform branches, so every function is unit-testable.

import type { ExtractionMode, JobFacts, ResumeEducation, ResumeExperience, ResumeFacts, ResumeProject } from './types';

/** Characters of document text sent to the model. Longer documents are cut. */
export const MAX_EXTRACTION_CHARS = 24_000;

const clip = (text: string, max = MAX_EXTRACTION_CHARS) => (text.length > max ? `${text.slice(0, max)}\n[…truncated]` : text);

export function buildResumeExtractionPrompt(text: string): string {
  return `Extract the facts from this résumé as JSON. Use only what the résumé states; never invent or infer anything. Leave a field out (or use an empty list) when the résumé does not state it.

Return ONLY a JSON object with exactly these keys:
{
  "name": string,
  "email": string,
  "phone": string,
  "location": string,
  "links": string[],
  "headline": string,            // the professional title line, if any
  "summary": string,             // the summary/objective, max 3 sentences, résumé wording
  "skills": string[],            // each skill once, as written
  "experience": [{ "role": string, "company": string, "start_date": string, "end_date": string, "location": string, "bullets": string[] }],
  "projects": [{ "name": string, "description": string, "technologies": string[] }],
  "education": [{ "institution": string, "degree": string, "field": string, "end_date": string }],
  "certifications": string[]
}
Dates as written in the résumé (e.g. "Jan 2021", "2019", "Present"). Experience newest first.

RÉSUMÉ:
"""
${clip(text)}
"""`;
}

export function buildJobExtractionPrompt(text: string): string {
  return `Extract the facts from this job description as JSON. Use only what it states; never invent or infer anything. Leave a field out (or use an empty list) when it is not stated.

Return ONLY a JSON object with exactly these keys:
{
  "title": string,
  "company": string,
  "location": string,
  "level": string,                 // e.g. "Senior", "Entry", as stated
  "employment_type": string,       // e.g. "Full-time", as stated
  "min_years_experience": number,  // only if a number of years is stated
  "compensation_hint": string,     // salary/range text, only if stated
  "description_summary": string,   // max 2 sentences
  "requirements": string[],        // must-haves
  "nice_to_haves": string[],
  "responsibilities": string[],
  "technologies": string[],        // tools, languages, platforms named
  "keywords": string[]             // other important terms an interviewer may probe
}

JOB DESCRIPTION:
"""
${clip(text)}
"""`;
}

/** Parse the first JSON object out of a model reply (fences and prose tolerated). */
export function parseModelJson(reply: unknown): Record<string, unknown> | null {
  if (typeof reply !== 'string') return null;
  const unfenced = reply.replace(/```(?:json)?/gi, '');
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(unfenced.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// ── Coercion ────────────────────────────────────────────────────────────────

const str = (v: unknown): string | undefined => {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v !== 'string') return undefined;
  const t = v.replace(/\s+/g, ' ').trim();
  return t && !/^(n\/?a|none|null|unknown|not stated)$/i.test(t) ? t : undefined;
};

const strList = (v: unknown, max = 60): string[] => {
  const items = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,;\n•|]/) : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const s = str(typeof item === 'object' && item ? (item as any).name ?? (item as any).skill : item);
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
};

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN;
  return Number.isFinite(n) && n >= 0 && n < 80 ? n : undefined;
};

/** Skills may come as a list or as {category: [..]}; flatten either. */
const flattenSkills = (v: unknown): string[] => {
  if (v && typeof v === 'object' && !Array.isArray(v)) return strList(Object.values(v).flat());
  return strList(v);
};

export function normalizeResumeFacts(raw: Record<string, unknown> | null, mode: ExtractionMode): ResumeFacts {
  const r: any = raw ?? {};
  const identity: any = r.identity && typeof r.identity === 'object' ? r.identity : {};
  const name = str(r.name) ?? str(identity.name);
  const experience: ResumeExperience[] = (Array.isArray(r.experience) ? r.experience : [])
    .map((e: any) => ({
      role: str(e?.role) ?? str(e?.title) ?? str(e?.position) ?? '',
      company: str(e?.company) ?? str(e?.organization) ?? str(e?.employer) ?? '',
      start_date: str(e?.start_date),
      end_date: str(e?.end_date),
      location: str(e?.location),
      bullets: strList(e?.bullets ?? e?.highlights ?? e?.responsibilities, 12),
    }))
    .filter((e: ResumeExperience) => e.role || e.company)
    .slice(0, 20);
  const projects: ResumeProject[] = (Array.isArray(r.projects) ? r.projects : [])
    .map((p: any) => ({
      name: str(p?.name) ?? str(p?.title) ?? '',
      description: str(p?.description) ?? str(p?.summary) ?? '',
      technologies: strList(p?.technologies ?? p?.tech_stack ?? p?.tools, 20),
    }))
    .filter((p: ResumeProject) => p.name || p.description)
    .slice(0, 20);
  const education: ResumeEducation[] = (Array.isArray(r.education) ? r.education : [])
    .map((e: any) => ({
      institution: str(e?.institution) ?? str(e?.school) ?? str(e?.university) ?? '',
      degree: str(e?.degree),
      field: str(e?.field) ?? str(e?.major),
      end_date: str(e?.end_date),
    }))
    .filter((e: ResumeEducation) => e.institution || e.degree)
    .slice(0, 10);
  const skills = flattenSkills(r.skills);
  return {
    identity: {
      name,
      email: str(r.email) ?? str(identity.email),
      phone: str(r.phone) ?? str(identity.phone),
      location: str(r.location) ?? str(identity.location),
      links: strList(r.links ?? identity.links, 10),
    },
    name,
    headline: str(r.headline),
    summary: str(r.summary),
    skills,
    skills_flat: skills,
    experience,
    projects,
    education,
    certifications: strList(r.certifications, 20),
    total_experience_years: totalExperienceYears(experience),
    _extraction_mode: mode,
  };
}

export function normalizeJobFacts(raw: Record<string, unknown> | null, mode: ExtractionMode): JobFacts {
  const r: any = raw ?? {};
  return {
    title: str(r.title) ?? str(r.role) ?? str(r.position) ?? str(r.jobTitle),
    company: str(r.company),
    location: str(r.location),
    level: str(r.level),
    employment_type: str(r.employment_type),
    min_years_experience: num(r.min_years_experience),
    compensation_hint: str(r.compensation_hint),
    description_summary: str(r.description_summary),
    requirements: strList(r.requirements, 30),
    nice_to_haves: strList(r.nice_to_haves, 30),
    responsibilities: strList(r.responsibilities, 30),
    technologies: strList(r.technologies, 40),
    keywords: strList(r.keywords, 40),
    _extraction_mode: mode,
  };
}

// ── Dates and experience ────────────────────────────────────────────────────

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
};

/** Parse a résumé date ("Jan 2021", "2021-03", "03/2021", "2021", "Present") to a month index. */
export function parseResumeMonth(value: string | undefined, now: Date = new Date()): number | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (/^(present|current|now|today|ongoing)$/.test(v)) return now.getFullYear() * 12 + now.getMonth();
  let m = v.match(/^([a-z]{3,9})\.?\s+(\d{4})$/);
  if (m && MONTHS[m[1].slice(0, m[1] === 'sept' ? 4 : 3)] !== undefined) {
    return Number(m[2]) * 12 + MONTHS[m[1].slice(0, m[1] === 'sept' ? 4 : 3)];
  }
  m = v.match(/^(\d{4})[-/.](\d{1,2})$/);
  if (m) return Number(m[1]) * 12 + Math.min(11, Math.max(0, Number(m[2]) - 1));
  m = v.match(/^(\d{1,2})[-/.](\d{4})$/);
  if (m) return Number(m[2]) * 12 + Math.min(11, Math.max(0, Number(m[1]) - 1));
  m = v.match(/^(\d{4})$/);
  if (m) return Number(m[1]) * 12;
  return null;
}

/**
 * Total years of experience: the union of dated roles (overlaps counted once),
 * to one decimal. Undefined when no role has a usable start date.
 */
export function totalExperienceYears(experience: ResumeExperience[], now: Date = new Date()): number | undefined {
  const spans: Array<[number, number]> = [];
  for (const e of experience) {
    const start = parseResumeMonth(e.start_date, now);
    if (start === null) continue;
    const end = parseResumeMonth(e.end_date ?? 'present', now) ?? start;
    if (end >= start) spans.push([start, end + 1]);
  }
  if (!spans.length) return undefined;
  spans.sort((a, b) => a[0] - b[0]);
  let months = 0;
  let [curStart, curEnd] = spans[0];
  for (const [s, e] of spans.slice(1)) {
    if (s <= curEnd) curEnd = Math.max(curEnd, e);
    else { months += curEnd - curStart; [curStart, curEnd] = [s, e]; }
  }
  months += curEnd - curStart;
  return Math.round((months / 12) * 10) / 10;
}

// ── Heuristic fallback (no model available) ─────────────────────────────────

const lines = (text: string) => text.split(/\r?\n/).map((l) => l.trim());
const BULLET = /^[-•*·▪●◦]\s*/;

/** Section names résumés and job descriptions use. */
const KNOWN_SECTION = /^(?:(?:work|professional|relevant)\s+)?(?:experience|employment(?: history)?|education|projects?|skills|technical skills|summary|profile|objective|certifications?|awards|achievements|publications|languages|interests|references|contact|requirements|qualifications|responsibilities|benefits|perks|about(?: us| the role| the company)?|nice to haves?|preferred(?: qualifications)?|what you('|’)ll (?:do|need)|who you are|how to apply)$/i;

/**
 * A section heading: a short line, not a bullet, naming a known section in any
 * case, with or without a colon ("EDUCATION", "Work Experience", "Skills:").
 * Anything else is content: skills are often listed one per line, and "AWS",
 * "SQL" or "Python" on their own must not end the Skills section.
 */
export function isHeadingLine(line: string): boolean {
  if (!line || line.length > 40 || BULLET.test(line)) return false;
  return KNOWN_SECTION.test(line.replace(/:$/, '').trim());
}

/** Lines under the first heading matching `heading`, until the next heading. */
export function section(text: string, heading: RegExp): string[] {
  const all = lines(text);
  const at = all.findIndex((l) => l.length < 60 && heading.test(l));
  if (at < 0) return [];
  const out: string[] = [];
  for (const l of all.slice(at + 1)) {
    if (!l) continue;
    if (out.length && isHeadingLine(l)) break;
    out.push(l.replace(BULLET, ''));
    if (out.length >= 40) break;
  }
  return out;
}

export function heuristicResumeFacts(text: string): ResumeFacts {
  const first = lines(text).find(Boolean) ?? '';
  const name = /^[A-Za-z][A-Za-z.'-]+( [A-Za-z][A-Za-z.'-]+){1,3}$/.test(first) ? first : undefined;
  const email = text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/)?.[0];
  const phone = text.match(/\+?\d[\d\s().-]{7,}\d/)?.[0]?.trim();
  const links = [...new Set(text.match(/(?:https?:\/\/|www\.)[^\s)]+|linkedin\.com\/[^\s)]+|github\.com\/[^\s)]+/gi) ?? [])].slice(0, 10);
  const skills = section(text, /^(technical\s+)?skills\b|^core competencies|^technologies/i).join(', ');
  return normalizeResumeFacts({ name, email, phone, links, skills }, 'heuristic');
}

export function heuristicJobFacts(text: string): JobFacts {
  const first = lines(text).find(Boolean) ?? '';
  return normalizeJobFacts({
    title: first.length <= 80 ? first : undefined,
    requirements: section(text, /^(requirements|qualifications|what you('|’)ll need|must[- ]haves?|you have)\b/i),
    nice_to_haves: section(text, /^(nice[- ]to[- ]haves?|preferred|bonus|pluses)\b/i),
    responsibilities: section(text, /^(responsibilities|what you('|’)ll do|the role|your role|duties)\b/i),
  }, 'heuristic');
}

// ── Summaries and the answer context ────────────────────────────────────────

export function resumeSummary(facts: Partial<ResumeFacts> | null | undefined): { name: string; role: string; totalExperienceYears: number | null } {
  const latest = facts?.experience?.[0];
  return {
    name: facts?.identity?.name ?? facts?.name ?? '',
    role: latest?.role ?? facts?.headline ?? '',
    totalExperienceYears: typeof facts?.total_experience_years === 'number' ? facts.total_experience_years : null,
  };
}

const join = (items: string[] | undefined, max: number) => (items ?? []).slice(0, max).join('; ');

/**
 * The profile block put in front of an answer's context: who the candidate is
 * and what the target job asks for, compact and only from stored facts.
 */
export function buildProfileContextBlock(resume: Partial<ResumeFacts> | null, jd: Partial<JobFacts> | null): string {
  const parts: string[] = [];
  if (resume) {
    const r: string[] = [];
    const s = resumeSummary(resume);
    if (s.name) r.push(`Name: ${s.name}`);
    if (resume.headline) r.push(`Headline: ${resume.headline}`);
    if (s.totalExperienceYears !== null) r.push(`Total experience: ${s.totalExperienceYears} years`);
    for (const e of (resume.experience ?? []).slice(0, 5)) {
      const dates = [e.start_date, e.end_date].filter(Boolean).join(' – ');
      const head = [e.role, e.company && `at ${e.company}`, dates && `(${dates})`].filter(Boolean).join(' ');
      r.push(`- ${head}${e.bullets?.length ? `: ${join(e.bullets, 3)}` : ''}`);
    }
    for (const p of (resume.projects ?? []).slice(0, 4)) {
      r.push(`- Project ${p.name}${p.description ? `: ${p.description}` : ''}${p.technologies?.length ? ` [${join(p.technologies, 6)}]` : ''}`);
    }
    if (resume.skills?.length) r.push(`Skills: ${join(resume.skills, 30)}`);
    for (const ed of (resume.education ?? []).slice(0, 2)) {
      r.push(`Education: ${[ed.degree, ed.field, ed.institution && `— ${ed.institution}`, ed.end_date && `(${ed.end_date})`].filter(Boolean).join(' ')}`);
    }
    if (r.length) parts.push(`<candidate_profile source="resume">\n${r.join('\n')}\n</candidate_profile>`);
  }
  if (jd) {
    const j: string[] = [];
    const head = [jd.title, jd.company && `at ${jd.company}`].filter(Boolean).join(' ');
    if (head) j.push(`Role: ${head}`);
    if (jd.level) j.push(`Level: ${jd.level}`);
    if (typeof jd.min_years_experience === 'number') j.push(`Minimum experience: ${jd.min_years_experience} years`);
    if (jd.requirements?.length) j.push(`Requirements: ${join(jd.requirements, 10)}`);
    if (jd.responsibilities?.length) j.push(`Responsibilities: ${join(jd.responsibilities, 8)}`);
    if (jd.technologies?.length) j.push(`Technologies: ${join(jd.technologies, 20)}`);
    if (jd.nice_to_haves?.length) j.push(`Nice to have: ${join(jd.nice_to_haves, 6)}`);
    if (j.length) parts.push(`<target_job source="job_description">\n${j.join('\n')}\n</target_job>`);
  }
  if (!parts.length) return '';
  return `${parts.join('\n\n')}\n<profile_use_rule>These are the user's own résumé and target job. Use them only when relevant to the question; never invent experience, employers, dates or numbers they do not contain.</profile_use_rule>`;
}
