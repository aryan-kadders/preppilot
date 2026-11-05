// Copying .env.example to .env leaves lines like OPENAI_API_KEY=your_openai_api_key_here.
// Read as real keys, the app tries those providers first and every call fails
// with 401 before it reaches the one key the user actually filled in. A value
// in that example form is never a real credential, so it is dropped. Pure and
// platform-independent: it only edits the env object it is given.

const PLACEHOLDER = /^your_[a-z0-9_]*_here$/i;

export function isEnvPlaceholder(value: string | undefined): boolean {
  return PLACEHOLDER.test(String(value ?? '').trim());
}

/** Deletes example placeholder values from `env`; returns the names removed. */
export function dropEnvPlaceholders(env: Record<string, string | undefined>): string[] {
  const removed: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (isEnvPlaceholder(value)) {
      delete env[name];
      removed.push(name);
    }
  }
  return removed;
}
