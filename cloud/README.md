# PrepPilot Cloud

The server side of PrepPilot. Managers give candidates minutes, book their
time slots and set assignments. Candidates' desktop apps sign in with an invite
code, and every AI and transcription call goes through this server, which holds
the Gemini and Deepgram keys and enforces the time.

```
Manager dashboard ──(Supabase Auth + row-level security)──► Postgres
Desktop app ──(device tokens)──► Edge Function `api` ──► Postgres (pp_* functions)
                                         ├──► Gemini   (answers, streamed)
                                         └──► Deepgram (60-second key; the app streams audio directly)
```

| Part | Where |
|---|---|
| Tables, access rules, server functions | `supabase/migrations/20261106000001_core.sql` |
| The `api` function (routes, Gemini, Deepgram) | `supabase/functions/_shared/*.ts`, wrapped by `supabase/functions/api/index.ts` |
| Tests | `tests/db.test.mjs` (database rules), `tests/api.test.ts` (API end to end) |

## Roles

| Role | Can |
|---|---|
| admin | Everything in the organization: teams, staff, all candidates, the audit log |
| manager | Their teams' candidates: add, invite, give minutes, book slots, assign, revoke devices |
| coach | Read their teams' candidates and sessions; comment on sessions |
| candidate | The desktop app only, during a slot, while minutes last |

## The rules, as the server applies them

- **Invite.** A manager creates a one-time code (`XXXX-XXXX-XXXX-XXXX`, valid 7
  days). The app trades it for an access token (15 minutes) and a refresh
  token (30 days, single use, rotated on every refresh). Only SHA-256 hashes
  are stored. A refresh token used twice locks the device out.
- **Session.** It starts only inside a booked slot with minutes left. It runs
  until the slot ends, the minutes run out, or the assignment's time limit is
  reached, whichever comes first. Minutes given during a session extend it.
- **Charging.** The app checks in every 30 seconds. Each check-in deducts the
  seconds since the last one, once per sequence number, so a retry is never
  charged twice. 90 seconds of silence ends the session as stale, and the
  silence is not charged.
- **Calls.** `/v1/chat` and `/v1/stt/token` need an open session. A call that
  starts in time runs to the end, so the answer in progress is finished.

## API (base URL `https://<project>.supabase.co/functions/v1/api`)

Every request sends `x-preppilot-version: <app version>`. Authenticated routes
send `Authorization: Bearer <access token>` (the app's existing `x-natively-key`
header also works). `/v1/chat` and `/v1/stt/token` also send `x-preppilot-session`.

| Route | Body | Answer |
|---|---|---|
| `POST /v1/auth/redeem` | `{ code, device_name, platform, app_version }` | `{ access_token, refresh_token, device_id, *_expires_at }` |
| `POST /v1/auth/refresh` | `{ refresh_token }` | new token pair |
| `GET /v1/me` | | minutes left, current and next slot, assignments |
| `POST /v1/session/start` | `{ assignment_id? }` | `{ session_id, status, allowed_until, seconds_left, ... }` |
| `POST /v1/session/heartbeat` | `{ session_id, seq }` | same shape |
| `POST /v1/session/end` | `{ session_id, seq }` | same shape |
| `POST /v1/chat` | `{ messages, system?, stream?, images?, model_tier? }` | stream: `data: {"delta"}` … `data: [DONE]`; otherwise `{ content }` |
| `POST /v1/stt/token` | | `{ access_token, expires_in: 60 }` for Deepgram |

Errors: `401 invalid_token` (refresh), `403 device_revoked` (sign out),
`426 app_update_required`, `429 time_quota_exceeded` with a `reason`
(`no_active_slot`, `no_minutes`, `time_up`, `session_ended`, `attempts_exhausted`),
`409 session_stale` (start a new session), `502 upstream_unavailable`.

## Set up a project

1. Create a project at supabase.com. Keep the database password.
2. Apply the schema: open **SQL Editor**, paste
   `supabase/migrations/20261106000001_core.sql`, and run it. With the CLI, use
   `npx supabase link --project-ref <ref>` then `npx supabase db push`.
3. Deploy the function and set its secrets (CLI):
   ```
   npx supabase functions deploy api --no-verify-jwt
   npx supabase secrets set GEMINI_API_KEY=... DEEPGRAM_API_KEY=...
   ```
   Optional: `MIN_APP_VERSION=3.1.0`, and `GEMINI_PRICES='{"gemini-3.1-flash-lite":[0.10,0.40],"gemini-3.8-flash":[0.30,2.50]}'`
   (USD per 1M input/output tokens; the built-in values are estimates for the
   usage report).
4. Create the first admin. Sign up once under **Authentication → Users**, then
   run this in the SQL Editor:
   ```sql
   select public.pp_bootstrap_org('Your company', 'you@example.com');
   ```
5. Keep the service-role key and the database password out of the desktop app
   and out of git. The app only ever needs the function URL.

## Tests

```
cd cloud
npm install
npm test
```

They start a private Postgres with the local `initdb` and `pg_ctl` (PostgreSQL
16 or newer on PATH). Elsewhere, for example on Windows or in CI, point
`TEST_DATABASE_URL` at an empty database as a superuser, such as a
`postgres:16` container.

## Not in Phase 1

- The desktop sign-in and session client (Phase 2).
- The manager dashboard (Phase 3); until then, managers use the SQL Editor or
  Supabase's table editor.
- Rate limits, monitoring and backups (Phase 4).
- Measuring Deepgram audio per candidate: the app streams to Deepgram
  directly, so transcription cost is read from Deepgram's own usage report.
