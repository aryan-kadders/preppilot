// Click-through mode's escape hatch (PrepPilot).
//
// Upstream made the whole overlay ignore the mouse in click-through mode, so
// the button that turned the mode on could not turn it off: only ⌘⇧B / Ctrl+
// Shift+B could, and a user who did not know the shortcut was left with an
// overlay where nothing responded. Now the click-through button alone takes
// clicks while the pointer is over it; everything else still passes through.
//
// overlayIgnoresMouse is pure and platform-parameterised (forwardSupported),
// so the macOS/Windows branch (forward: true) and the Linux branch (no
// forward) both run here. The wiring checks read the sources.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const COMPILED = path.join(ROOT, 'dist-electron/electron/utils/overlayHoverProbe.js');
const HAVE_BUILD = fs.existsSync(COMPILED);
const { overlayIgnoresMouse } = HAVE_BUILD ? require(COMPILED) : {};
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const MAC_OR_WINDOWS = { forwardSupported: true };
const LINUX = { forwardSupported: false };

describe('overlayIgnoresMouse', { skip: HAVE_BUILD ? false : 'run `npm run build:electron` first' }, () => {
  test('macOS / Windows, click-through on: ignores the mouse except over the click-through button', () => {
    assert.equal(overlayIgnoresMouse({ ...MAC_OR_WINDOWS, passthrough: true, escapeHover: false, hoverInteractive: true }), true);
    assert.equal(overlayIgnoresMouse({ ...MAC_OR_WINDOWS, passthrough: true, escapeHover: false, hoverInteractive: false }), true);
    assert.equal(overlayIgnoresMouse({ ...MAC_OR_WINDOWS, passthrough: true, escapeHover: true, hoverInteractive: true }), false);
    assert.equal(overlayIgnoresMouse({ ...MAC_OR_WINDOWS, passthrough: true, hoverInteractive: true }), true, 'no escape reported = ignore');
  });

  test('macOS / Windows, click-through off: the margin hover gate is unchanged, escape is irrelevant', () => {
    assert.equal(overlayIgnoresMouse({ ...MAC_OR_WINDOWS, passthrough: false, hoverInteractive: true }), false);
    assert.equal(overlayIgnoresMouse({ ...MAC_OR_WINDOWS, passthrough: false, hoverInteractive: false }), true);
    assert.equal(overlayIgnoresMouse({ ...MAC_OR_WINDOWS, passthrough: false, escapeHover: true, hoverInteractive: true }), false);
  });

  test('Linux (no forward): click-through always ignores; margins stay interactive', () => {
    assert.equal(overlayIgnoresMouse({ ...LINUX, passthrough: true, escapeHover: true, hoverInteractive: true }), true);
    assert.equal(overlayIgnoresMouse({ ...LINUX, passthrough: false, hoverInteractive: false }), false);
  });
});

describe('wiring', () => {
  test('WindowHelper decides through overlayIgnoresMouse and forgets the escape when the mode or page changes', () => {
    const wh = read('electron/WindowHelper.ts');
    assert.match(wh, /const overlayIgnore = overlayIgnoresMouse\(\{\s*passthrough,\s*escapeHover: this\.overlayPassthroughEscape,/);
    assert.match(wh, /if \(!passthrough\) this\.overlayPassthroughEscape = false;/);
    assert.match(wh, /public setOverlayPassthroughEscape\(overButton: boolean\): void \{\s*const next = overButton && this\.appState\.getOverlayMousePassthrough\(\);/);
    // Reset on show and on a renderer reload, beside the hover gate's own reset.
    assert.equal((wh.match(/this\.overlayPassthroughEscape = false;/g) ?? []).length, 3);
    assert.match(wh, /escapeHover: this\.overlayPassthroughEscape,\s*\}\);\s*if \(!want\)/, 'the probe keeps running in click-through');
  });

  test('only the overlay window may open the escape', () => {
    const ipc = read('electron/ipcHandlers.ts');
    const at = ipc.indexOf("safeHandle('overlay-passthrough-escape-hover'");
    assert.ok(at > 0);
    const body = ipc.slice(at, at + 500);
    assert.match(body, /if \(overlayWin\.webContents\.id !== event\.sender\.id\) return;/);
    assert.match(body, /setOverlayPassthroughEscape\(!!overButton\)/);
    assert.match(read('electron/preload.ts'), /ipcRenderer\.invoke\('overlay-passthrough-escape-hover', overButton\)/);
  });

  test('the overlay reports the pointer over the click-through button from moves and from the probe', () => {
    const ui = read('src/components/NativelyInterface.tsx');
    assert.match(ui, /<div className="relative" ref=\{clickThroughButtonRef\}>\s*<ClickThroughToggle/);
    assert.match(ui, /const over = isMousePassthroughRef\.current\s*&& pointerOverPanel\(point, clickThroughButtonRef\.current\?\.getBoundingClientRect\(\) \?\? null, 2\);/);
    assert.match(ui, /lastMoveAt = performance\.now\(\);\s*reportClickThroughHover\(\{ x: e\.clientX, y: e\.clientY \}\);/);
    assert.match(ui, /onOverlayHoverProbe\?\.\(\(point\) => \{[\s\S]{0,200}reportClickThroughHover\(point\);/);
  });
});
