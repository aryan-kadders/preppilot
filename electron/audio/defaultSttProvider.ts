// The transcription provider PrepPilot uses when the user has not chosen one.
//
// Upstream's default was its paid, managed "Natively" speech service, which
// this fork does not use. With nothing selected the overlay said
// "Transcription Not Configured — No STT provider selected", which means
// nothing to a normal user. So, when nothing is chosen, use a free provider
// that runs on the computer and needs no key:
//
//   macOS    Apple Speech (the system's on-device recognizer) when its helper
//            is present; otherwise local Whisper
//   Windows  local Whisper (an on-device model, downloaded once on first use)
//   other    none: PrepPilot supports macOS and Windows only, and an
//            unsupported platform is not silently given another's provider
//
// Pure and platform-parameterised so every branch is unit-tested from any host.

export type AutoSttProvider = 'apple-speech' | 'local-whisper' | 'none';

export interface DefaultSttOptions {
  /** The Apple Speech helper binary exists (macOS only; built by build:apple-speech). */
  appleSpeechAvailable: boolean;
}

export function defaultSttProviderFor(platform: NodeJS.Platform, opts: DefaultSttOptions): AutoSttProvider {
  switch (platform) {
    case 'darwin':
      return opts.appleSpeechAvailable ? 'apple-speech' : 'local-whisper';
    case 'win32':
      return 'local-whisper';
    default:
      return 'none';
  }
}
