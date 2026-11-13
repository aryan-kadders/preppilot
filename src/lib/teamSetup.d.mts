export type CloudSetupState = 'signed_in' | 'signed_out' | 'revoked' | null | undefined;
export type TeamSetupStep = 'join' | 'profile' | null;

export const PROFILE_STEP_SKIPPED_KEY: string;
export const FOCUS_INVITE_EVENT: string;
export function teamSetupStep(s: { cloudState: CloudSetupState; hasOwnAi: boolean; profileReady: boolean; profileSkipped?: boolean }): TeamSetupStep;
export function startBlockMessage(step: TeamSetupStep, cloudState: CloudSetupState): string | null;
