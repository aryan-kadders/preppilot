// /v1/stt/token → a Deepgram key that lives 60 seconds. It only has to be
// valid when the app opens its streaming connection; the open stream then
// runs as long as the interview (Deepgram token-based auth). The real key
// never leaves the server.
import { json, type Deps } from './core.ts';

export const STT_TOKEN_TTL_SECONDS = 60;

export async function deepgramGrant(deps: Deps): Promise<Response> {
  const r = await deps.fetch('https://api.deepgram.com/v1/auth/grant', {
    method: 'POST',
    headers: { authorization: `Token ${deps.env.deepgramKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ttl_seconds: STT_TOKEN_TTL_SECONDS }),
  });
  if (!r.ok) {
    deps.log?.('[api] deepgram grant refused', { status: r.status, detail: (await r.text().catch(() => '')).slice(0, 300) });
    return json(502, { error: 'upstream_unavailable', upstream_status: r.status });
  }
  const data = await r.json();
  if (typeof data?.access_token !== 'string') return json(502, { error: 'upstream_unavailable' });
  return json(200, { access_token: data.access_token, expires_in: Number(data.expires_in) || STT_TOKEN_TTL_SECONDS });
}
