export interface AiSetupProvider {
  id: 'groq' | 'gemini';
  name: string;
  badge: string;
  blurb: string;
  keyUrl: string;
  keyPrefix: string;
}

export const AI_SETUP_PROVIDERS: AiSetupProvider[];
export const OLLAMA_DOWNLOAD_URL: string;
export function needsAiSetup(input: { hasOwnAiKey: boolean; isOllama: boolean }): boolean;
export function cleanPastedKey(raw: unknown): string;
export function precheckKey(providerId: string, key: string): string | null;
export function friendlyKeyError(providerName: string, rawError: unknown): string;
