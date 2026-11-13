// PrepPilot team setup: the steps a candidate goes through before practising.
//
//   1. join    – enter the invite code from their manager (PrepPilot Cloud).
//   2. profile – upload their résumé, so answers use their real experience.
//
// Someone with their own AI (the owner, or a solo user with a key or a local
// model) is not on a team and never sees the join step. Pure, so the decision
// is unit-tested; the card is src/components/TeamSetupCard.tsx and the Start
// check is in src/App.tsx. No platform branches.

/** localStorage key: the candidate chose "Skip for now" on the profile step. */
export const PROFILE_STEP_SKIPPED_KEY = 'preppilot_profile_step_skipped_v1';

/**
 * @param {{ cloudState: 'signed_in' | 'signed_out' | 'revoked' | null | undefined,
 *           hasOwnAi: boolean, profileReady: boolean, profileSkipped?: boolean }} s
 * @returns {'join' | 'profile' | null}  the step to show, or null for none
 */
export function teamSetupStep({ cloudState, hasOwnAi, profileReady, profileSkipped = false }) {
  if (cloudState === 'signed_in') return profileReady || profileSkipped ? null : 'profile';
  // A computer the manager signed out must join again, even with an AI of its own:
  // it was a team computer.
  if (cloudState === 'revoked') return 'join';
  return hasOwnAi ? null : 'join';
}

/**
 * Why Start must wait, in plain words, or null when it may go ahead. Only the
 * join step blocks: without a code there is no AI to answer. A missing résumé
 * does not block; it is asked for, and the answers say when a story is a sample.
 * @param {'join' | 'profile' | null} step
 * @param {'signed_in' | 'signed_out' | 'revoked' | null | undefined} cloudState
 */
export function startBlockMessage(step, cloudState) {
  if (step !== 'join') return null;
  return cloudState === 'revoked'
    ? 'This computer was signed out by your manager. Enter a new invite code to start.'
    : 'To start, enter the invite code from your manager first.';
}

/** The window event that asks the card to bring its code box into view and focus it. */
export const FOCUS_INVITE_EVENT = 'preppilot:focus-invite-code';
