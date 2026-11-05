// When microphone and system audio are captured by Chromium in a hidden window
// instead of the native module.
//
// Windows: whenever the native module did not load (missing VC++ runtime,
// antivirus quarantine, wrong architecture). Before this both channels were
// dead: the meeting started with a "Native audio engine unavailable" banner
// and no transcript. Interview Coder captures on Windows exactly this way
// (getUserMedia + getDisplayMedia with loopback audio).
// macOS: whenever the native module did not load, too (PrepPilot). Upstream
// kept macOS on the native path only, so a Mac without the module (a source
// checkout whose Rust module needs full Xcode to build, or a damaged install)
// had no audio at all. Chromium's loopback uses the Core Audio tap from macOS
// 14.2; with the module present the native tap and ScreenCaptureKit paths stay
// the only ones, exactly as before. A development build can still force the
// fallback with NATIVELY_FORCE_RENDERER_AUDIO=1.

export interface FallbackPolicyInput {
  platform: NodeJS.Platform;
  /** The native capture class this wrapper would use exists. */
  nativeAvailable: boolean;
  isPackaged: boolean;
  forceEnv: string | undefined;
}

export function useRendererCaptureFallback(input: FallbackPolicyInput): boolean {
  switch (input.platform) {
    case 'win32':
      return !input.nativeAvailable;
    case 'darwin':
      return !input.nativeAvailable || (!input.isPackaged && input.forceEnv === '1');
    default:
      return false;
  }
}

/** The policy for this process. Electron's app is read lazily: tests load this file under plain Node. */
export function rendererCaptureFallbackActive(nativeAvailable: boolean): boolean {
  let isPackaged = true;
  try {
    isPackaged = (require('electron') as typeof import('electron')).app?.isPackaged ?? true;
  } catch {
    /* not running inside Electron */
  }
  return useRendererCaptureFallback({
    platform: process.platform,
    nativeAvailable,
    isPackaged,
    forceEnv: process.env.NATIVELY_FORCE_RENDERER_AUDIO,
  });
}
