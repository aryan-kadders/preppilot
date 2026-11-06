// Gemini, streamed with the server's key and normalised to ModelEvents.
import { ProviderError, type ChatBody, type ModelEvent } from './models.ts';

const API = 'https://generativelanguage.googleapis.com/v1beta/models';
const MAX_IMAGES = 4;
const MAX_IMAGE_BASE64 = 6_000_000;

/** The app's request as a Gemini generateContent body. */
export function toGeminiRequest(body: ChatBody, model: string): Record<string, unknown> {
  const contents = body.messages
    .filter((m) => typeof m?.content === 'string' && m.content.length > 0)
    .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content as string }] as any[] }));
  const lastUser = [...contents].reverse().find((c) => c.role === 'user');
  if (lastUser) for (const i of validImages(body)) lastUser.parts.push({ inlineData: { mimeType: i.mime_type, data: i.data } });
  return {
    contents,
    ...(body.system ? { systemInstruction: { parts: [{ text: body.system }] } } : {}),
    generationConfig: {
      maxOutputTokens: 65536,
      temperature: 0.4,
      // Flash-Lite accepts "minimal"; Flash needs at least "low" (a 400 otherwise).
      thinkingConfig: { thinkingLevel: model.includes('flash-lite') ? 'minimal' : 'low' },
    },
  };
}

export function validImages(body: ChatBody): Array<{ mime_type: string; data: string }> {
  return (body.images ?? []).slice(0, MAX_IMAGES)
    .filter((i): i is { mime_type: string; data: string } =>
      typeof i?.data === 'string' && i.data.length <= MAX_IMAGE_BASE64 && /^image\/(png|jpeg|webp|gif)$/.test(i.mime_type ?? ''));
}

const textOf = (chunk: any): string =>
  (chunk?.candidates?.[0]?.content?.parts ?? [])
    .filter((p: any) => typeof p?.text === 'string' && p.thought !== true)
    .map((p: any) => p.text).join('');

const usageOf = (meta: any) => ({
  input: Number(meta?.promptTokenCount) || 0,
  // Thinking tokens are billed as output.
  output: (Number(meta?.candidatesTokenCount) || 0) + (Number(meta?.thoughtsTokenCount) || 0),
});

/** Opens a Gemini stream; throws ProviderError when Gemini refuses before streaming. */
export async function geminiStream(model: string, body: ChatBody, signal: AbortSignal, deps: { fetch: typeof fetch; key: string }): Promise<AsyncIterable<ModelEvent>> {
  const res = await deps.fetch(`${API}/${model}:streamGenerateContent?alt=sse`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': deps.key },
    body: JSON.stringify(toGeminiRequest(body, model)),
    signal,
  });
  if (!res.ok || !res.body) {
    throw new ProviderError('gemini', model, res.status, (await res.text().catch(() => '')).slice(0, 500));
  }
  const reader = res.body.getReader();
  return (async function* () {
    const dec = new TextDecoder();
    let buf = '';
    let usage: { input: number; output: number } | null = null;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          let chunk: any;
          try { chunk = JSON.parse(line.slice(5).trim()); } catch { continue; }
          if (chunk?.usageMetadata) usage = usageOf(chunk.usageMetadata);
          const text = textOf(chunk);
          if (text) yield { text };
        }
      }
    } finally {
      reader.cancel().catch(() => {});
    }
    if (usage) yield { usage };
  })();
}
