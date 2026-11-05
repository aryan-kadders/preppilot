// Where natively-api lives: NATIVELY_API_URL when set (a local or staging
// server), else the default below, with no trailing slash. One definition, so
// pointing the app at another server moves every managed route together (chat,
// usage, telemetry, reviews, reranking, entitlement, share links) rather than
// leaving one part quietly on production.
//
// PrepPilot: the default is NOT upstream's production server. Upstream's hosted
// API (billing, trials, reviews, usage audit, share links, the hosted "Natively"
// model/reranker/embedding routes) belongs to Natively's owners; this personal
// fork has no account there. With no override, every one of those routes is
// sent to a local port that refuses the connection at once, so nothing — not
// even a DNS lookup — reaches upstream, and each caller takes its existing
// "server unreachable" path. Set NATIVELY_API_URL to use a server deliberately.

/** Upstream Natively's production API (not used unless NATIVELY_API_URL names it). */
export const UPSTREAM_NATIVELY_API_URL = 'https://api.natively.software';

/** Port 9 (discard) on the loopback: refused immediately on macOS and Windows. */
export const DEFAULT_NATIVELY_API_URL = 'http://127.0.0.1:9';

export function nativelyApiBase(env: NodeJS.ProcessEnv = process.env): string {
    return (env.NATIVELY_API_URL || DEFAULT_NATIVELY_API_URL).replace(/\/+$/, '');
}
