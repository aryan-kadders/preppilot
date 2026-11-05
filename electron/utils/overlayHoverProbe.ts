// A second way for the overlay's click-through gate to reopen.
//
// While the pointer is over a transparent part of the overlay window the
// window ignores the mouse, and it is the overlay's page that reopens it, on
// the first mouse move it sees over the panel. An ignoring window gets no
// mouse moves of its own; setIgnoreMouseEvents' `forward: true` feeds them to
// it. On Windows that feed is a low-level mouse hook on the main thread, and
// Windows silently removes a low-level hook whose thread answers too slowly.
// With the feed gone nothing reopened the gate: the panel stayed click-through
// until the overlay was hidden and shown again.
//
// So, while the gate is shut, main tells the page where the pointer is a few
// times a second (only while the pointer is inside the window's rectangle) and
// the page answers with its usual hit-test. The page remains the only judge of
// what is panel and what is margin; main only makes sure it gets asked.
//
// Pure, no platform branch (see __tests__/OverlayHoverGateProbe2026_10_05.test.mjs).

/** How often main asks while the gate is shut. Well under the time a click takes to follow a move. */
export const HOVER_PROBE_INTERVAL_MS = 100;

export interface HoverProbeConditions {
  /** The overlay window is on screen. */
  visible: boolean;
  /** The user's click-through mode: the window is meant to ignore the mouse. */
  passthrough: boolean;
  /** The page's last verdict: true = pointer over the panel, gate open. */
  hoverInteractive: boolean;
  /** `forward: true` exists on this platform (the hover gate is off without it). */
  forwardSupported: boolean;
  /**
   * Click-through mode only: the page's last verdict that the pointer is over
   * the click-through button itself (PrepPilot's escape hatch, see
   * overlayIgnoresMouse).
   */
  escapeHover?: boolean;
}

/**
 * Should main be probing right now? While the window is shut to the mouse and
 * the page could reopen it: the hover gate over a margin, or click-through mode
 * with the pointer not (yet) over the click-through button.
 */
export function shouldProbeHover(c: HoverProbeConditions): boolean {
  if (!c.visible || !c.forwardSupported) return false;
  if (c.passthrough) return !c.escapeHover;
  return !c.hoverInteractive;
}

/**
 * Does the overlay window ignore the mouse right now?
 *
 * - Click-through mode: yes, everywhere except over the click-through button.
 *   Upstream made the whole window ignore the mouse, so the button that turned
 *   the mode on could not turn it off: only the keyboard shortcut could, and a
 *   user who did not know it saw an overlay where nothing responded. With
 *   `forward: true` the page still sees the pointer, reports when it is over
 *   the button, and the window takes that click. Without `forward` (Linux)
 *   there is no pointer feed, so the window keeps ignoring the mouse.
 * - Otherwise: only while the hover gate has the pointer over a transparent
 *   margin (needs `forward`, else margins stay interactive).
 */
export function overlayIgnoresMouse(c: Omit<HoverProbeConditions, 'visible'>): boolean {
  if (c.passthrough) return !(c.forwardSupported && c.escapeHover);
  return c.forwardSupported && !c.hoverInteractive;
}

/**
 * The pointer in window coordinates, or null when it is not inside the window.
 * Both inputs are Electron screen coordinates (DIPs), as getCursorScreenPoint()
 * and getBounds() return them on macOS and Windows.
 */
export function hoverProbePoint(
  cursor: { x: number; y: number },
  bounds: { x: number; y: number; width: number; height: number },
): { x: number; y: number } | null {
  const x = cursor.x - bounds.x;
  const y = cursor.y - bounds.y;
  if (x < 0 || y < 0 || x >= bounds.width || y >= bounds.height) return null;
  return { x, y };
}
