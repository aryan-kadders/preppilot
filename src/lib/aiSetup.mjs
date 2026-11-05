// "Connect an AI" — the one setup step PrepPilot cannot do for the user.
//
// Transcription works out of the box (an on-device default), but answers need
// an AI: a key from a provider, or a local model. Like Pluely ("paste one key")
// and free-cluely (local Ollama), the Launcher offers exactly that while no AI
// is connected. Pure helpers, so the decisions and wording are unit-tested;
// the card itself is src/components/AiSetupCard.tsx. No platform branches: the
// links open in the default browser on macOS and Windows alike.

/** Free-to-start providers offered on the card, simplest first. */
export const AI_SETUP_PROVIDERS = [
  {
    id: 'groq',
    name: 'Groq',
    badge: 'Free',
    blurb: 'Fast and free to start. Sign in with Google, create a key, paste it here.',
    keyUrl: 'https://console.groq.com/keys',
    keyPrefix: 'gsk_',
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    badge: 'Free tier',
    blurb: 'Free with a Google account. Create a key in Google AI Studio, paste it here.',
    keyUrl: 'https://aistudio.google.com/apikey',
    keyPrefix: 'AIza',
  },
];

export const OLLAMA_DOWNLOAD_URL = 'https://ollama.com/download';

/**
 * Show the card while the user has no way to get an answer: no AI key or
 * sign-in of their own, and not running on a local Ollama model.
 */
export function needsAiSetup({ hasOwnAiKey, isOllama }) {
  return !hasOwnAiKey && !isOllama;
}

/** Trim what was pasted: whitespace, newlines and surrounding quotes. */
export function cleanPastedKey(raw) {
  return String(raw ?? '').trim().replace(/^["'`]+|["'`]+$/g, '').replace(/\s+/g, '');
}

/**
 * A quick local check before contacting the provider: an empty field, or a
 * key that plainly belongs to the other provider, gets an answer at once.
 */
export function precheckKey(providerId, key) {
  if (!key) return 'Paste your key first.';
  const provider = AI_SETUP_PROVIDERS.find((p) => p.id === providerId);
  const other = AI_SETUP_PROVIDERS.find((p) => p.id !== providerId && key.startsWith(p.keyPrefix));
  if (provider && other) return `That looks like a ${other.name} key. Choose ${other.name} above, or paste your ${provider.name} key.`;
  return null;
}

/**
 * The provider's answer to "does this key work?" in plain words. The raw
 * error is for the log; the user needs to know what to do next.
 */
export function friendlyKeyError(providerName, rawError) {
  const e = String(rawError ?? '').toLowerCase();
  if (/401|403|invalid|unauthori[sz]ed|incorrect|api key not valid|permission/.test(e)) {
    return `${providerName} didn't accept that key. Copy it again (all of it) and paste it here.`;
  }
  if (/429|rate|quota|exceeded|limit/.test(e)) {
    return `${providerName} says this key has hit its limit for now. Try again in a minute, or create a new key.`;
  }
  if (/network|fetch|enotfound|econn|timeout|timed out|offline|dns/.test(e)) {
    return `Couldn't reach ${providerName}. Check your internet connection and try again.`;
  }
  return `${providerName} couldn't be reached with that key. Check the key and your connection, then try again.`;
}
