// What the overlay says when a capture channel cannot start, in plain words.
//
// Upstream put the raw error in the banner ("System audio failed to start
// (Native audio engine unavailable — the audio capture module failed to load.
// Reinstall the app (dev: npm run build:native).)"), which means nothing to a
// normal user. The raw error still goes to the log (main.ts logs it first);
// the banner says what happened and what to do.
//
// AUDIO_PART_MISSING is matched by src/lib/audioWarningAction.mjs so the
// banner's button opens Settings → Audio, never a privacy pane: a missing
// module is not a permission problem. Same wording on macOS and Windows.

export const AUDIO_PART_MISSING = 'a part of PrepPilot that handles audio is missing';

const MODULE_MISSING = /native audio engine unavailable|capture module failed to load/i;

export function captureStartFailureMessage(channel: 'mic' | 'system', err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? '');
  if (MODULE_MISSING.test(raw)) {
    return channel === 'mic'
      ? `PrepPilot can't use your microphone because ${AUDIO_PART_MISSING}. Reinstall PrepPilot to fix this.`
      : `PrepPilot can't hear the call because ${AUDIO_PART_MISSING}. Reinstall PrepPilot to fix this.`;
  }
  return channel === 'mic'
    ? "Your microphone couldn't start. Check that it's connected and not in use by another app. PrepPilot keeps listening to the call."
    : "PrepPilot couldn't start listening to the call. It keeps listening to your microphone.";
}
