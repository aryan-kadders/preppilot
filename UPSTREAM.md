# Pulling fixes from upstream Natively

This repo's history was reset, so it shares no commits with upstream.
Port useful upstream changes as patches instead of merging.

Last synced upstream commit: `f35230f57af543ed0f5ee9ace645c0076adcb488` (v3.1.0, 2026-11-04)

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
