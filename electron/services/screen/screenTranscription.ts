import { composeScreenDescription } from './screenDescription';
import { hasOnDeviceScreenText } from '../../context-intelligence/question/on-device-screen';
import {
  getScreenshotDescription,
  hashImageSet,
  putScreenshotDescription,
} from './ScreenshotDescriptionStore';

/**
 * Transcribe a screenshot for the CONVERSATION RECORD, once per distinct screen.
 *
 * WHY THIS IS A SEPARATE CALL FROM THE ONE THAT ANSWERS THE TURN
 * One `understand()` call cannot serve both jobs. The answering call is asked to
 * "analyze the attached screenshot and answer concisely", which is correct for
 * the question in front of the user and worthless as a record. Verified live on
 * a real profile: the text stored for a build-failure screenshot was
 *
 *   "Your build failed because you've run out of disk quota. You need to free up
 *    some space and then rerun the command with the --no-cache flag."
 *
 * — second person, paraphrased, and containing neither the FATAL error code nor
 * the ticket reference the user asked about two turns later. Reusing it was the
 * reason a follow-up could never recover an identifier.
 *
 * Widening the answering prompt instead was rejected: it changes the shape of
 * every screenshot answer to serve a consumer the user never sees, which is how
 * the coding-template regression happened.
 *
 * COST AND LATENCY
 * Off the critical path by contract — every caller invokes this AFTER its answer
 * has been delivered. Cached on the attachment set, so a re-captured screen is
 * free, and skipped entirely when the set is already described.
 */
export async function transcribeScreenForMemory(
  imagePaths: readonly string[],
  /** The turn's question, passed only as disambiguation context. */
  transcriptHint?: string,
  /** `allowOAuthRecord: false` for automatic captures (see VisionProviderBuildInputs). */
  options: { allowOAuthRecord?: boolean } = {},
): Promise<string> {
  if (!imagePaths.length) return '';
  try {
    const sha = hashImageSet(imagePaths);
    if (!sha) return '';
    const { getScreenUnderstandingService } = require('./ScreenUnderstandingService');
    const { SettingsManager } = require('../SettingsManager');
    const { CredentialsManager } = require('../CredentialsManager');
    const settings = SettingsManager.getInstance();
    const cached = getScreenshotDescription(sha);
    // A description made while this screenshot was being KEPT ON THIS DEVICE
    // is reused only while that setting is still on. With it off, the user is
    // sending this very screenshot to a provider again, so it is read again
    // under today's setting (and the row replaced) rather than recorded as
    // text no cloud model may ever be shown.
    const stale = hasOnDeviceScreenText(cached?.description) && settings.getScreenUnderstandingMode() !== 'private_vision';
    if (cached?.description && !stale) return cached.description;

    const credentials = CredentialsManager.getInstance();
    const providerScopes = settings.get('providerDataScopes') || {};

    const result = await getScreenUnderstandingService().understand({
      modeId: 'screen-memory',
      transcript: transcriptHint,
      // The whole point: this reaches STRUCTURED_EXTRACTION_SYSTEM_PROMPT,
      // which every existing call site missed.
      userAction: 'transcribe',
      allowOAuthRecord: options.allowOAuthRecord,
      qualityMode: 'balanced',
      imagePaths: [...imagePaths],
      // ONE policy, read the same way as the other call sites — a transcription
      // is still a screenshot leaving the device, and `private_vision` and a
      // denied `screenshots` scope bind it exactly as they bind the answer.
      screenUnderstandingMode: settings.getScreenUnderstandingMode(),
      technicalInterviewVisionFirst: settings.getTechnicalInterviewVisionFirst(),
      providerPolicy: {
        localOnly: settings.getScreenUnderstandingMode() === 'private_vision',
        allowScreenshots: providerScopes.screenshots !== false,
        visionAvailable: credentials.anyVisionProviderConfigured?.() ?? true,
        localVisionAvailable: credentials.anyLocalVisionProviderConfigured?.() ?? false,
      },
    });

    const text = composeScreenDescription(result);
    if (text) {
      putScreenshotDescription(sha, text, result?.providerUsed ?? '', result?.modelUsed ?? '');
    }
    return text;
  } catch (error: any) {
    // NEVER silent: with no transcription the next follow-up cannot answer about
    // this screen, and that is indistinguishable from a bad answer.
    console.warn('[screen-memory] transcription failed — this screenshot will not be recallable:',
      error?.message ?? error);
    return '';
  }
}

/**
 * Wait for a description only up to `waitMs`. Resolves with the text if it
 * came in time, else with null, and `late` still resolves with the eventual
 * text (or '' on failure) so the caller can fill it in afterwards.
 *
 * For a user action that must not hang on a slow reader: Notes › Attach image
 * waited out the whole record, which is 30 s for a signed-in Codex /
 * Antigravity model and 45 s for Ollama.
 */
export async function awaitDescriptionWithin(
  describing: Promise<string>,
  waitMs: number,
): Promise<{ text: string | null; late: Promise<string> }> {
  const late = describing.then((text) => String(text ?? '').trim()).catch(() => '');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const text = await Promise.race([
    late,
    new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), waitMs); }),
  ]);
  clearTimeout(timer);
  return { text: text || null, late };
}

/**
 * Descriptions still being written for images already attached to the notes,
 * by entry object. Notes › Attach image returns after the pre-pass budget and
 * lets a slower reader finish in the background; the notes writer waits for
 * these before it reads the descriptions (awaitPendingImageDescriptions), so
 * an image attached just before Stop is still described. A WeakMap, not a
 * field on the entry: the entry is saved with the meeting and a Promise is not
 * data.
 */
const pendingDescriptions = new WeakMap<object, Promise<string>>();

export function notePendingImageDescription(entry: object, late: Promise<string>): void {
  const settled: Promise<string> = late
    .catch(() => '')
    .finally(() => { if (pendingDescriptions.get(entry) === settled) pendingDescriptions.delete(entry); });
  pendingDescriptions.set(entry, settled);
}

/**
 * Wait for any still-pending descriptions of these entries, up to the longest
 * record time limit (the Ollama one, 45 s). Never throws; returns at once when
 * nothing is pending.
 */
export async function awaitPendingImageDescriptions(entries: unknown): Promise<void> {
  if (!Array.isArray(entries)) return;
  const pending = entries
    .map((e) => (e && typeof e === 'object' ? pendingDescriptions.get(e) : undefined))
    .filter((p): p is Promise<string> => !!p);
  if (!pending.length) return;
  const { OLLAMA_RECORD_BUDGET_MS } = require('./ScreenUnderstandingService');
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled(pending),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, OLLAMA_RECORD_BUDGET_MS); }),
  ]);
  clearTimeout(timer);
}
