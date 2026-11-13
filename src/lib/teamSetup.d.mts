export type CloudSetupState = 'signed_in' | 'signed_out' | 'revoked' | null | undefined;
export type TeamSetupStep = 'join' | null;

export const FOCUS_INVITE_EVENT: string;
export function teamSetupStep(s: { cloudState: CloudSetupState; hasOwnAi: boolean }): TeamSetupStep;
export function startBlockMessage(step: TeamSetupStep, cloudState: CloudSetupState): string | null;
