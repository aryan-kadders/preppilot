// Words a tech interview is full of, as transcription hints (PrepPilot).
// On-device and cloud recognizers alike turn "React" into "reaction", "Python"
// into "final", "Kubernetes" into nonsense; Auto Answer then answers the wrong
// question. These go to providers with a vocabulary input (Deepgram keyterm,
// Soniox, Google) through sttContextTerms' domain slot, never into Whisper
// prompts (Whisper can echo a prompt on silence).
//
// Pure: the résumé and JD facts are passed in. No platform branches.

// In priority order: Deepgram keeps only the first ~600 characters of hints
// (~450 on its multilingual model), after the résumé's and JD's own words. So
// the interview words speech-to-text gets WRONG come first (measured
// 2026-11-18 on Indian-accented speech: "Scrum" written in Telugu script,
// "Agile" heard as "asylum", "Docker" as "doctor", "SOW" as "ESOde Blue"),
// and the everyday ones it already hears right ("Python", "Java") last.
export const TECH_INTERVIEW_TERMS: readonly string[] = [
  'Agile', 'Scrum', 'Scrum master', 'sprint', 'product backlog', 'user story', 'Kanban', 'JIRA', 'waterfall',
  'BRD', 'SRS', 'SOW', 'FRD', 'stakeholder', 'requirement gathering', 'UAT', 'SDLC',
  'Kubernetes', 'Docker', 'microservices', 'REST API', 'GraphQL', 'Kafka', 'Redis', 'MongoDB', 'PostgreSQL',
  'DynamoDB', 'Terraform', 'CI/CD', 'Jenkins', 'AWS', 'Azure', 'GCP',
  'OOP', 'polymorphism', 'encapsulation', 'inheritance', 'SOLID', 'multithreading', 'recursion', 'Big O',
  'hash map', 'linked list', 'binary tree', 'dynamic programming', 'system design', 'load balancer', 'sharding', 'caching',
  'React', 'Next.js', 'Angular', 'Node.js', 'TypeScript', 'Django', 'FastAPI', 'Flask', 'Spring Boot', '.NET', 'C#', 'C++',
  'Golang', 'Kotlin', 'pandas', 'NumPy', 'PyTorch', 'TensorFlow', 'LLM', 'ETL', 'Power BI', 'Tableau', 'Spark', 'Snowflake',
  'Selenium', 'Jest', 'unit testing', 'design patterns', 'API gateway', 'Elasticsearch', 'RabbitMQ',
  'JavaScript', 'Python', 'Java', 'SQL', 'MySQL', 'Git', 'Linux',
];

/** Résumé and JD tech words first (the ones this interview will use), then the general list. */
export function techInterviewTerms(profile?: { resume?: Record<string, unknown> | null; jd?: Record<string, unknown> | null }): string[] {
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const own = [
    ...strings(profile?.jd?.technologies),
    ...strings(profile?.resume?.skills_flat),
    ...strings(profile?.resume?.skills),
  ].map((t) => t.trim()).filter((t) => t && t.length <= 40);
  return [...own, ...TECH_INTERVIEW_TERMS];
}
