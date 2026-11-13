// PrepPilot team setup: before practising, a candidate on a team joins it with
// the invite code from their manager (PrepPilot Cloud). The résumé and the job
// description are then added on the home page (InterviewPrepCard).
//
// Someone with their own AI (the owner, or a solo user with a key or a local
// model) is not on a team and never sees the join step. Pure, so the decision
// is unit-tested; the card is src/components/TeamSetupCard.tsx and the Start
// check is in src/App.tsx. No platform branches.

/**
 * @param {{ cloudState: 'signed_in' | 'signed_out' | 'revoked' | null | undefined, hasOwnAi: boolean }} s
 * @returns {'join' | null}  the join step, or null when there is nothing to do
 */
export function teamSetupStep({ cloudState, hasOwnAi }) {
  if (cloudState === 'signed_in') return null;
  // A computer the manager signed out must join again, even with an AI of its own:
  // it was a team computer.
  if (cloudState === 'revoked') return 'join';
  return hasOwnAi ? null : 'join';
}

/**
 * Why Start must wait, in plain words, or null when it may go ahead. Only the
 * join step blocks: without a code there is no AI to answer. A missing résumé
 * does not block; the answers say when a story is a sample.
 * @param {'join' | null} step
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
