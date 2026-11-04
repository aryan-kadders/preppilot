# PrepPilot — Task List

Personal learning project: an AI interview-practice assistant, forked from
[Natively](https://github.com/Natively-AI-assistant/natively-cluely-ai-assistant)
v3.1.0 (personal-use license — not for publishing or commercial use).

Every task must keep macOS **and** Windows working (see `CLAUDE.md`).
Stealth features (undetectable mode, disguise, content protection, the
`com.apple.corespeechd` appId) are kept on purpose.

## Phase 0 — Fresh start ✅

- [x] Pull latest upstream (v3.1.0, `f35230f5`) and reset history to a single commit
- [x] Keep `upstream` remote for pulling future fixes (see `UPSTREAM.md`)
- [x] Back up old history in tag `backup/upstream-history-2026-11-04`

## Phase 1 — Baseline ✅

- [x] `npm install` on v3.1.0 (Electron binary had to be installed separately:
      `node node_modules/electron/install.js`)
- [x] Baseline on the untouched tree: typecheck ✅, build ✅, `test:lib` ✅,
      `npm test` ❌ (electron build failed without `premium/`), `test:scripts` ❌ (worktree-only)

## Phase 2 — Remove upstream business code ✅ (first pass)

- [x] Remove `premium` / `natively-api` submodules
- [x] Plans & Billing settings tab, Pro / Natively API settings, quota banner, refund page
- [x] Trial: renderer state, overlay chip and banner, trial-ended modal, trial meter;
      server trial requests and auto-trial disabled in main
- [x] Promotional cards (plans, API offer, Max/Ultra, profile/JD ads, review, support, demo film)
- [x] About page: author, socials, donate, affiliate, reviews → credits row
- [x] Launcher sponsor carousel (`FeatureSpotlight`); referral codes stripped from provider links
- [x] Telemetry off: install ping, funnel telemetry, usage outbox
- [x] Auto-update points at this fork's repo; no automatic startup check
- [x] Pro gate unlocked locally (`services/proAccess.ts`)
- [x] Root clutter: refund/terms/roadmap/changelog, upstream community docs
- [ ] Deeper pass: delete now-dead trial/licence code in `ipcHandlers.ts`, `main.ts`,
      `preload.ts`, `CredentialsManager`, `DonationManager`, `ReviewService`
      (currently unreachable, not deleted)
- [ ] Remove the hosted "Natively API" provider (STT, reranker, LLM routes) from settings

## Phase 3 — Rebrand to PrepPilot

- [x] User-facing renderer text, translations, window title, About
- [x] Main-process tray, menu, notifications, dialogs, OAuth callback page
- [x] README, package description
- [ ] AI prompt identity ("Natively", "Evin John" in `electron/llm/prompts.ts` and the
      leak validators) — changes answer behaviour, needs its own test pass
- [ ] On-disk identity (`productName`, executable, profile folder, packaging/uninstall
      scripts) — ~20 scripts on both platforms; needs a packaged build on mac + win
- [ ] App icons

## Phase 4 — Fix bugs

- [x] `build:electron` failed without `premium/` → premium imports external when absent
- [ ] `npm run test:intelligence` hangs (some test waits forever) — find and fix
- [ ] Launch the app (`npm start`) and walk through settings, overlay and a meeting
- [ ] Review the 42 `npm audit` findings (no `--force`)

## Phase 5 — Practice mode (core feature)

- [ ] Pick role / topic / difficulty
- [ ] Résumé + JD context (upstream's parser lived in premium; needs our own)
- [ ] AI interviewer asks questions (text + optional TTS)
- [ ] Capture spoken answer via existing mic STT pipeline (mac + win)
- [ ] AI feedback: score, strengths, improvements, model answer
- [ ] Session history and progress over time

## Backlog

- [ ] Persona-based interviewers (SWE, PM, HR, …)
- [ ] System-design question mode with diagram feedback
