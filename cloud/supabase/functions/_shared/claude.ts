// Claude through the official Anthropic SDK (created in api/index.ts and
// injected here), normalised to ModelEvents.
//
// Tuned for a live assistant:
// - Claude Haiku 5.5 (fast tier): thinking off, effort low, for the earliest
//   first words. Haiku accepts `disabled` at effort high or below.
// - Claude Sonnet 5.5 (long tier): `between_tools` (Sonnet 5.5's thinking-off
//   mode; `disabled` is a 400 there) at effort medium, and the server-side
//   refusal fallback, so a safety decline is re-run on a fallback model in
//   the same call instead of ending the answer.
// - The system prompt is cached (it is large and repeats every question).
// - No temperature: non-default sampling values are rejected on these models.
import { ProviderError, type ChatBody, type ModelEvent } from './models.ts';
import { validImages } from './gemini.ts';

/** The part of the Anthropic SDK client used here (injected; faked in tests). */
export interface AnthropicLike {
  messages: { stream(params: Record<string, unknown>, options?: { signal?: AbortSignal }): AsyncIterable<any> };
  beta: { messages: { stream(params: Record<string, unknown>, options?: { signal?: AbortSignal }): AsyncIterable<any> } };
}

export function toClaudeRequest(body: ChatBody, model: string): Record<string, unknown> {
  const messages = body.messages
    .filter((m) => typeof m?.content === 'string' && m.content.length > 0)
    .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: [{ type: 'text', text: m.content as string }] as any[] }));
  // The API requires the conversation to start with the user.
  while (messages.length && messages[0].role !== 'user') messages.shift();
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  if (lastUser) {
    const images = validImages(body).map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mime_type, data: i.data } }));
    lastUser.content = [...images, ...lastUser.content];
  }
  const sonnet = model.includes('sonnet');
  return {
    model,
    max_tokens: sonnet ? 64000 : 16000,
    ...(body.system ? { system: [{ type: 'text', text: body.system, cache_control: { type: 'ephemeral' } }] } : {}),
    messages,
    thinking: sonnet ? { type: 'between_tools' } : { type: 'disabled' },
    output_config: { effort: sonnet ? 'medium' : 'low' },
    ...(sonnet ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}),
  };
}

/** Opens a Claude stream; the first event is awaited by the router, so a refusal before output fails over. */
export async function claudeStream(model: string, body: ChatBody, signal: AbortSignal, client: AnthropicLike): Promise<AsyncIterable<ModelEvent>> {
  const params = toClaudeRequest(body, model);
  const stream = params.betas ? client.beta.messages.stream(params, { signal }) : client.messages.stream(params, { signal });
  return (async function* () {
    let input = 0;
    let output = 0;
    try {
      for await (const event of stream) {
        if (event?.type === 'message_start') {
          const u = event.message?.usage ?? {};
          input = (Number(u.input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0);
        } else if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
          yield { text: event.delta.text as string };
        } else if (event?.type === 'message_delta') {
          if (event.usage?.output_tokens != null) output = Number(event.usage.output_tokens) || output;
          if (event.delta?.stop_reason === 'refusal') throw new ProviderError('claude', model, 200, 'refusal');
        }
      }
    } catch (e: any) {
      if (e instanceof ProviderError) throw e;
      if (signal.aborted) return;
      // The SDK's typed API errors carry the HTTP status.
      throw new ProviderError('claude', model, Number(e?.status) || 0, String(e?.message ?? e).slice(0, 500));
    }
    yield { usage: { input, output } };
  })();
}
