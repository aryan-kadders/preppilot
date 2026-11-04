# PrepPilot

An AI interview-practice assistant for macOS and Windows: it listens along,
transcribes, and answers or coaches in real time, with your own AI and
speech-to-text providers.

PrepPilot is a personal, non-commercial fork of
[Natively](https://github.com/Natively-AI-assistant/natively-cluely-ai-assistant)
(v3.1.0), used under the Natively Personal Use Source License (see `LICENSE`).
It is not for publishing or commercial use.

## What changed from Natively

- No premium, plans, trial, Pro, quota, checkout, refund or donation UI.
- No telemetry: install pings, funnel events and usage reports are off.
- No server-issued free trial; bring your own provider keys or local models.
- Updates point at this fork's own repository and never check automatically.
- Rebranded user-facing text to PrepPilot.

Planned work lives in [`TASKS.md`](TASKS.md). How to pull fixes from upstream
Natively is in [`UPSTREAM.md`](UPSTREAM.md).

## Requirements

- Node.js 22.6 or newer
- Rust (for the native audio module)
- macOS: Xcode Command Line Tools. Windows: Visual Studio Build Tools (C++).

## Run from source

```bash
npm install
npm start          # Vite renderer + Electron, in development mode
```

Copy `.env.example` to `.env` to configure cloud providers or local Ollama.
At least one speech-to-text provider and one LLM provider are needed, unless
you use the supported local ones. Never commit `.env`.

## Checks

```bash
npm run typecheck:electron
npm run typecheck:ts7     # renderer
npm run build
npm test                  # Electron service tests
npm run test:lib
npm run test:scripts
```

## Permissions

- **macOS:** Microphone, and Screen Recording for system audio. Speech
  Recognition when using Apple Speech.
- **Windows:** Microphone privacy setting. Screen capture needs no permission.

## License

Source-available under the Natively Personal Use Source License v1.0, ©
Natively AI Private Limited. Personal, educational and non-commercial use only.
