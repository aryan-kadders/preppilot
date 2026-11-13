# Pulling fixes from upstream Natively

This repo's history was reset, so it shares no commits with upstream.
Port useful upstream changes as patches instead of merging.

Last reviewed upstream commit: `d669697b` (2026-11-13). Last full sync: `f35230f5` (v3.1.0, 2026-11-04).

```bash
git fetch upstream main
git log --oneline <last-synced>..upstream/main          # see what's new

# Take a single fix:
git format-patch -1 <sha> --stdout | git am -3

# Or take everything new (expect conflicts in files we removed or rebranded):
git diff <last-synced> upstream/main | git apply -3
```

Then update the "Last synced" line above.

Changes that touch removed areas (premium, trial, plans, telemetry,
Natively API) can be skipped.

## Sync log

### 2026-11-13 (`f35230f5..d669697b`, 75 commits reviewed)

Ported 23 (each ported commit names its upstream sha in an `Upstream:` line):
auto-answer judge fixes (Nov 10), screenshot speed and screen memory, replaced
questions and answers reaching the overlay, Real-time prompt / skills / Cue
Cards everywhere, prompt-cache ordering, claim pass cache reuse, local STT
partials and model switch, phone answers streaming, screenshot preset prompt
(#726, #723), 30 s for long hosted answers (also our Cloud path), BYOK Soniox
v6 and ElevenLabs Scribe v3, system audio restart after a failed init (#729).

Skipped:
- `73cab2e9`, `d669697b`: Auto Answer locked to Pro, or free only when meeting
  transcripts are uploaded to Natively.
- `0b6b97b0`: Natively Pro STT (our Cloud gives Deepgram tokens instead).
- Plans, pricing, packs, trial, paywall, licence, funnel, key-email and
  `premium` / `natively-api` submodule commits.
- Theme and Settings styling (lavender accent, Inter titles, banner rework).

The #729 Rust changes need a native rebuild with full Xcode; the JS side runs
on the older prebuilt `.node` without them.

