// Words a tech interview is full of, as transcription hints (PrepPilot).
// On-device and cloud recognizers alike turn "React" into "reaction", "Python"
// into "final", "Kubernetes" into nonsense; Auto Answer then answers the wrong
// question. These go to providers with a vocabulary input (Deepgram keyterm,
// Soniox, Google) through sttContextTerms' domain slot, never into Whisper
// prompts (Whisper can echo a prompt on silence).
//
// Pure: the résumé and JD facts are passed in. No platform branches.

export const TECH_INTERVIEW_TERMS: readonly string[] = [
  'React', 'React Native', 'Next.js', 'Angular', 'Vue', 'Node.js', 'Express', 'TypeScript', 'JavaScript',
  'Python', 'Django', 'Flask', 'FastAPI', 'Java', 'Spring Boot', 'Kotlin', 'Swift', 'Go', 'Golang', 'Rust',
  'C++', 'C#', '.NET', 'PHP', 'Laravel', 'Ruby on Rails',
  'SQL', 'MySQL', 'PostgreSQL', 'MongoDB', 'Redis', 'Kafka', 'RabbitMQ', 'Elasticsearch', 'DynamoDB', 'GraphQL', 'REST API',
  'AWS', 'Azure', 'GCP', 'Docker', 'Kubernetes', 'Terraform', 'Jenkins', 'CI/CD', 'Git', 'GitHub', 'Linux',
  'microservices', 'system design', 'load balancer', 'caching', 'sharding', 'API gateway',
  'data structures', 'algorithms', 'linked list', 'binary tree', 'hash map', 'Big O', 'recursion', 'dynamic programming',
  'OOP', 'polymorphism', 'inheritance', 'encapsulation', 'SOLID', 'design patterns', 'multithreading', 'async await',
  'machine learning', 'TensorFlow', 'PyTorch', 'pandas', 'NumPy', 'LLM',
  'Agile', 'Scrum', 'JIRA', 'unit testing', 'Jest', 'Selenium',
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
