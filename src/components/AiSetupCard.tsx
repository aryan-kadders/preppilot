// "Connect an AI" card on the Launcher, shown while no AI is connected.
//
// Transcription already works with no setup (an on-device default), so this is
// the one thing a new user must do: paste one free key (Groq or Gemini), or use
// a local Ollama model. It tests the key with the provider before saving it,
// explains failures in plain words, and disappears once an AI is connected.
// Logic and wording live in src/lib/aiSetup.mjs (unit-tested). Same on macOS
// and Windows: links open in the default browser through openExternal.

import React, { useCallback, useEffect, useState } from 'react';
import { Check, ExternalLink, Loader2, Sparkles } from 'lucide-react';
import {
  AI_SETUP_PROVIDERS,
  OLLAMA_DOWNLOAD_URL,
  cleanPastedKey,
  friendlyKeyError,
  needsAiSetup,
  precheckKey,
  type AiSetupProvider,
} from '../lib/aiSetup.mjs';
import { SETTINGS_BTN } from './settings/SettingsRow';

type Status = { kind: 'idle' } | { kind: 'checking' } | { kind: 'error'; text: string } | { kind: 'done'; text: string };

const openLink = (url: string) => {
  if (window.electronAPI?.openExternal) window.electronAPI.openExternal(url);
  else window.open(url, '_blank', 'noopener');
};

async function saveKey(provider: AiSetupProvider['id'], key: string): Promise<{ success: boolean; error?: string }> {
  const api = window.electronAPI;
  if (provider === 'groq') return (await api?.setGroqApiKey?.(key)) ?? { success: false, error: 'unavailable' };
  return (await api?.setGeminiApiKey?.(key)) ?? { success: false, error: 'unavailable' };
}

export const AiSetupCard: React.FC<{ className?: string }> = ({ className = '' }) => {
  const [visible, setVisible] = useState(false);
  const [providerId, setProviderId] = useState<AiSetupProvider['id']>('groq');
  const [key, setKey] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const provider = AI_SETUP_PROVIDERS.find((p) => p.id === providerId) ?? AI_SETUP_PROVIDERS[0];

  // Is an AI connected? Re-read whenever keys change anywhere in the app.
  const refresh = useCallback(async () => {
    const api = window.electronAPI;
    try {
      const [creds, llm, models] = await Promise.all([
        api?.getStoredCredentials?.().catch(() => undefined),
        api?.getCurrentLlmConfig?.().catch(() => undefined),
        api?.getAvailableOllamaModels?.().catch(() => [] as string[]),
      ]);
      setOllamaModels(Array.isArray(models) ? models : []);
      setVisible(needsAiSetup({ hasOwnAiKey: !!creds?.hasOwnAiKey, isOllama: !!llm?.isOllama }));
    } catch {
      setVisible(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const off = window.electronAPI?.onCredentialsChanged?.(() => { void refresh(); });
    return () => { try { off?.(); } catch { /* already gone */ } };
  }, [refresh]);

  const connect = async () => {
    const clean = cleanPastedKey(key);
    const pre = precheckKey(provider.id, clean);
    if (pre) { setStatus({ kind: 'error', text: pre }); return; }
    setStatus({ kind: 'checking' });
    try {
      const test = await window.electronAPI?.testLlmConnection?.(provider.id, clean);
      if (!test?.success) {
        console.warn(`[AiSetupCard] ${provider.name} key test failed:`, test?.error);
        setStatus({ kind: 'error', text: friendlyKeyError(provider.name, test?.error) });
        return;
      }
      const saved = await saveKey(provider.id, clean);
      if (!saved?.success) {
        console.warn(`[AiSetupCard] saving the ${provider.name} key failed:`, saved?.error);
        setStatus({ kind: 'error', text: `The key works, but PrepPilot couldn't save it. Restart PrepPilot and try again.` });
        return;
      }
      setKey('');
      setStatus({ kind: 'done', text: `${provider.name} is connected. You're ready to go.` });
      // The card stays a moment so the success is seen, then the refresh hides it.
      window.setTimeout(() => { void refresh(); }, 2500);
    } catch (e: any) {
      console.warn('[AiSetupCard] connect failed:', e);
      setStatus({ kind: 'error', text: friendlyKeyError(provider.name, e?.message) });
    }
  };

  const useOllama = async () => {
    setStatus({ kind: 'checking' });
    const res = await window.electronAPI?.switchToOllama?.(ollamaModels[0]).catch((e: any) => ({ success: false, error: e?.message }));
    if (res?.success) {
      setStatus({ kind: 'done', text: `Using ${ollamaModels[0]} on this computer. You're ready to go.` });
      window.setTimeout(() => { void refresh(); }, 2500);
    } else {
      setStatus({ kind: 'error', text: 'The local AI did not start. Make sure Ollama is running, then try again.' });
    }
  };

  if (!visible) return null;
  const busy = status.kind === 'checking';

  return (
    <section
      className={`rounded-2xl border border-border-subtle bg-bg-elevated p-5 text-text-primary ${className}`}
      aria-labelledby="ai-setup-title"
      data-testid="ai-setup-card"
    >
      <div className="flex items-start gap-3">
        <Sparkles size={20} className="mt-0.5 shrink-0 text-text-secondary" aria-hidden />
        <div className="min-w-0 flex-1">
          <h2 id="ai-setup-title" className="text-[15px] font-bold">Connect an AI to get answers</h2>
          <p className="mt-1 text-xs text-text-secondary">
            PrepPilot already listens and transcribes. To answer questions it needs an AI. Pick one below. It takes about a minute and is free to start.
          </p>

          <div className="mt-4 flex flex-wrap gap-2" role="radiogroup" aria-label="AI provider">
            {AI_SETUP_PROVIDERS.map((p) => (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={p.id === provider.id}
                onClick={() => { setProviderId(p.id); setStatus({ kind: 'idle' }); }}
                className={`${SETTINGS_BTN} ${p.id === provider.id ? 'ring-1 ring-text-secondary' : ''}`}
              >
                {p.name}
                <span className="text-[10px] text-text-tertiary">{p.badge}</span>
              </button>
            ))}
          </div>

          <ol className="mt-4 space-y-2 text-xs text-text-secondary">
            <li className="flex flex-wrap items-center gap-2">
              <span className="font-semibold text-text-primary">1.</span>
              {provider.blurb}
              <button type="button" className={SETTINGS_BTN} onClick={() => openLink(provider.keyUrl)}>
                Get a free {provider.name} key <ExternalLink size={12} aria-hidden />
              </button>
            </li>
            <li className="flex items-center gap-2">
              <span className="font-semibold text-text-primary">2.</span>
              <label htmlFor="ai-setup-key" className="sr-only">{provider.name} API key</label>
              <input
                id="ai-setup-key"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={key}
                onChange={(e) => { setKey(e.target.value); if (status.kind === 'error') setStatus({ kind: 'idle' }); }}
                onKeyDown={(e) => { if (e.key === 'Enter' && !busy) void connect(); }}
                placeholder={`Paste your ${provider.name} key (starts with ${provider.keyPrefix}…)`}
                className="min-w-0 flex-1 rounded-lg border border-border-subtle bg-bg-primary px-3 py-1.5 text-xs text-text-primary outline-none focus:border-text-secondary"
              />
              <button type="button" className={SETTINGS_BTN} onClick={() => void connect()} disabled={busy}>
                {busy ? <Loader2 size={12} className="animate-spin" aria-hidden /> : null}
                {busy ? 'Checking…' : 'Connect'}
              </button>
            </li>
          </ol>

          <div aria-live="polite" className="min-h-[18px] mt-2 text-xs">
            {status.kind === 'error' && <span className="text-red-400">{status.text}</span>}
            {status.kind === 'done' && <span className="inline-flex items-center gap-1 text-emerald-400"><Check size={12} aria-hidden />{status.text}</span>}
          </div>

          <p className="mt-2 text-[11px] text-text-tertiary">
            Prefer AI that runs on this computer?{' '}
            {ollamaModels.length > 0 ? (
              <button type="button" className="underline hover:text-text-secondary" onClick={() => void useOllama()} disabled={busy}>
                Use {ollamaModels[0]} (Ollama, found on this computer)
              </button>
            ) : (
              <button type="button" className="underline hover:text-text-secondary" onClick={() => openLink(OLLAMA_DOWNLOAD_URL)}>
                Install Ollama (free)
              </button>
            )}
            . Your key stays on this computer, encrypted with your system's secure storage.
          </p>
        </div>
      </div>
    </section>
  );
};
