// /v1/chat → Gemini, with the server's key, answering in the app's format.
import { json, type Deps } from './core.ts';

export interface ChatBody {
  messages: Array<{ role?: string; content?: unknown }>;
  system?: string;
  stream?: boolean;
  images?: Array<{ mime_type?: string; data?: string }>;
  /** "long" for a whole-project build (Gemini Flash); anything else is the fast tier. */
  model_tier?: string;
}

export const FAST_MODEL = 'gemini-3.1-flash-lite';
export const LONG_MODEL = 'gemini-3.8-flash';
const API = 'https://generativelanguage.googleapis.com/v1beta/models';

// USD per 1M tokens [input, output]. ESTIMATES for the usage report only; set
// GEMINI_PRICES to the rates on your Google bill to make the costs exact.
export const DEFAULT_PRICES: Record<string, [number, number]> = {
  [FAST_MODEL]: [0.10, 0.40],
  [LONG_MODEL]: [0.30, 2.50],
};

const MAX_IMAGES = 4;
const MAX_IMAGE_BASE64 = 6_000_000;

export function pickModel(body: ChatBody): string {
  return body.model_tier === 'long' ? LONG_MODEL : FAST_MODEL;
}

/** The app's request as a Gemini generateContent body. */
export function toGeminiRequest(body: ChatBody, model: string): Record<string, unknown> {
  const contents = body.messages
    .filter((m) => typeof m?.content === 'string' && m.content.length > 0)
    .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content as string }] as any[] }));
  const images = (body.images ?? []).slice(0, MAX_IMAGES)
    .filter((i) => typeof i?.data === 'string' && i.data.length <= MAX_IMAGE_BASE64 && /^image\/(png|jpeg|webp)$/.test(i.mime_type ?? ''));
  const lastUser = [...contents].reverse().find((c) => c.role === 'user');
  if (lastUser) for (const i of images) lastUser.parts.push({ inlineData: { mimeType: i.mime_type, data: i.data } });
  return {
    contents,
    ...(body.system ? { systemInstruction: { parts: [{ text: body.system }] } } : {}),
    generationConfig: {
      maxOutputTokens: 65536,
      temperature: 0.4,
      // Flash-Lite accepts "minimal"; Flash needs at least "low" (a 400 otherwise).
      thinkingConfig: { thinkingLevel: model === FAST_MODEL ? 'minimal' : 'low' },
    },
  };
}

export function costUsd(model: string, input: number, output: number, prices: Record<string, [number, number]>): number {
  const [pin, pout] = prices[model] ?? [0, 0];
  return Math.round(((input * pin + output * pout) / 1_000_000) * 1e6) / 1e6;
}

const textOf = (chunk: any): string =>
  (chunk?.candidates?.[0]?.content?.parts ?? [])
    .filter((p: any) => typeof p?.text === 'string' && p.thought !== true)
    .map((p: any) => p.text).join('');

function usageOf(meta: any): { input: number; output: number } {
  return {
    input: Number(meta?.promptTokenCount) || 0,
    // Thinking tokens are billed as output.
    output: (Number(meta?.candidatesTokenCount) || 0) + (Number(meta?.thoughtsTokenCount) || 0),
  };
}

export async function geminiChat(body: ChatBody, sessionId: string, signal: AbortSignal, deps: Deps): Promise<Response> {
  const model = pickModel(body);
  const stream = body.stream === true;
  const url = `${API}/${model}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`;
  const upstream = await deps.fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': deps.env.geminiKey },
    body: JSON.stringify(toGeminiRequest(body, model)),
    signal,
  });
  const prices = deps.env.prices ?? DEFAULT_PRICES;
  const record = (u: { input: number; output: number }) =>
    deps.rpc('pp_record_usage', {
      p_session: sessionId, p_kind: 'llm', p_model: model, p_input: u.input, p_output: u.output,
      p_audio_seconds: null, p_cost: costUsd(model, u.input, u.output, prices),
    }).catch((e) => deps.log?.('[api] usage not recorded', { error: String(e?.message ?? e) }));

  if (!upstream.ok) {
    // The provider's words stay in the server log: they can name the account
    // (billing, spending cap), which is the admin's business, not the candidate's.
    const detail = (await upstream.text().catch(() => '')).slice(0, 500);
    deps.log?.('[api] gemini refused', { status: upstream.status, model, detail });
    return json(502, { error: 'upstream_unavailable', upstream_status: upstream.status });
  }

  if (!stream) {
    const data = await upstream.json();
    await record(usageOf(data?.usageMetadata));
    return json(200, { content: textOf(data), model });
  }

  const enc = new TextEncoder();
  const dec = new TextDecoder();
  let usage = { input: 0, output: 0 };
  const reader = upstream.body!.getReader();
  const out = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (payload: unknown) => controller.enqueue(enc.encode(`data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`));
      let buf = '';
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
            const delta = textOf(chunk);
            if (delta) send({ delta, model });
          }
        }
        send('[DONE]');
      } catch (e) {
        if (!signal.aborted) send({ error: 'upstream_stream_failed' });
      } finally {
        // Record before closing: an Edge isolate may retire once the response ends.
        await record(usage);
        try { controller.close(); } catch { /* client gone */ }
      }
    },
    cancel() { reader.cancel().catch(() => {}); },
  });
  return new Response(out, { status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } });
}
