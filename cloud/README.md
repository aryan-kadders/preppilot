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
| Tables, access rules, server functions | `supabase/migrations/*.sql` (core, dashboard, then owners, recruiters and interviews) |
| The `api` function (routes, Gemini, Deepgram) | `supabase/functions/_shared/*.ts`, wrapped by `supabase/functions/api/index.ts` |
| Tests | `tests/db.test.mjs` and `tests/roles.test.mjs` (database rules), `tests/api.test.ts` (API end to end) |

## Roles

| Role | Can |
|---|---|
| owner | The people who build PrepPilot. Every organization: lists them all (Companies), creates them, and works in one at a time as its admin. Added only from the SQL editor |
| admin | Everything in the organization: teams, staff, settings, all candidates, interviews, the audit log |
| manager | Their teams' candidates: add, invite, give minutes, book slots, assign, revoke devices, add interviews |
| recruiter | Their teams: add the client interviews candidates prepare for and record the results. No minutes, slots or invites |
| coach | Their teams: read candidates and sessions, comment on sessions, mark a candidate ready (or not) for an interview |
| candidate | The desktop app only, while minutes last (and inside a booked slot, if the organization requires slots) |

**The flow.** A recruiter adds a client interview (company, role, date, job
description); that creates a prep mock interview for the candidate, due on the
interview date. The manager makes sure the candidate has minutes. The candidate
practises in the app; a coach reviews the sessions and marks them ready or
needing work. After the interview the recruiter records the result, and the
Interviews page shows the selection rate.

## The rules, as the server applies them

- **Invite.** A manager creates a one-time code (`XXXX-XXXX-XXXX-XXXX`, valid 7
  days). The app trades it for an access token (15 minutes) and a refresh
  token (30 days, single use, rotated on every refresh). Only SHA-256 hashes
  are stored. A refresh token used twice locks the device out.
- **Session.** It starts any time the candidate has minutes left, or only
  inside a booked slot when the organization requires slots (Teams & staff ›
  Practice rules; off by default). It runs until the minutes run out, the
  slot ends, or the assignment's time limit is reached, whichever comes first.
  Minutes given during a session extend it.
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
   Optional:
   - `ANTHROPIC_API_KEY`: Claude answers first once it is set (Haiku 5.5 for
     live answers, Sonnet 5.5 for whole-project builds); Gemini stays as the
     fallback. Without it, Gemini answers alone. No redeploy needed.
   - `MODEL_ROUTES`: the order models are tried in, per tier, e.g.
     `{"fast":["claude:claude-haiku-5-5","gemini:gemini-3.1-flash-lite"],"long":["claude:claude-sonnet-5-5","gemini:gemini-3.8-flash"]}`.
     Default: `_shared/models.ts`.
   - `MODEL_PRICES` (USD per 1M tokens, `{"model":[input,output]}`) to match your
     bills; `GEMINI_PRICES` is still read.
   - `MIN_APP_VERSION=3.1.0`.

   How answers are routed: each model gets until its first words (6 s live,
   20 s builds) to start; an error, a refusal or a silence before that moves
   to the next model without the candidate seeing it. Usage is billed to the
   model that actually answered; the built-in Gemini prices are estimates.
4. Create the first admin. Sign up once under **Authentication → Users**, then
   run this in the SQL Editor:
   ```sql
   select public.pp_bootstrap_org('Your company', 'you@example.com');
   ```
   To make yourself the owner (see every organization, create new ones), sign
   up the same way and run:
   ```sql
   select public.pp_bootstrap_owner('you@example.com');
   ```
   Then open the dashboard's **Companies** page, open a company, and invite
   its admin from **Teams & staff**.
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

## Manager dashboard (`dashboard/`)

A React app for admins, managers and coaches. It signs in with Supabase Auth
and reads everything through the same row-level security, so each person sees
only their teams.

| Page | What it does |
|---|---|
| Candidates | Search and filter, minutes left, slot, status; add a candidate with starting minutes |
| Candidate | Give or take back minutes, create an invite code (shown once), book slots (repeat on weekdays), assignments, computers with Sign out, sessions with time, AI cost and coach notes, archive |
| Usage & cost | Minutes, sessions, AI answers and estimated cost per candidate for 7/30/90 days; CSV export |
| Teams & staff | Teams; staff roles (admin, manager, recruiter, coach) and team membership; invite staff (admins), which returns a one-time link to send; Practice rules (require booked slots) |
| Interviews | Client interviews: add one (it creates the prep mock interview), practice done for it, ready or not, result; selection rate |
| Audit log | Admins only |
| Companies | Owners only: every organization with its staff, candidates, practice, cost and upcoming interviews; open one or create one |

Run it locally (`npm install`, then `npm run dev`, at http://localhost:3000)
or build it (`npm run build`) and host `dist/` on any static host (Vercel,
Netlify, Cloudflare Pages). Add the hosted address under Supabase
**Authentication → URL Configuration** (Site URL and Redirect URLs), so invite
and password-reset links come back to it. `src/config.ts` holds the project URL
and its publishable key, which is meant for browsers; never put the secret key
in the dashboard.

Staff invitations: `POST /v1/staff/invite` on the `api` function, with the
admin's Supabase session token. The function checks the caller is an admin
before it creates a login, then returns a one-time link (an invite for new
people, a sign-in link for existing ones).

## Not in Phase 1

- The desktop sign-in and session client (Phase 2).
- Rate limits, monitoring and backups (Phase 4).
- Measuring Deepgram audio per candidate: the app streams to Deepgram
  directly, so transcription cost is read from Deepgram's own usage report.
