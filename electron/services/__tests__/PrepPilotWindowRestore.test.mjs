// Toggle Visibility (Cmd/Ctrl+B) brings the launcher back after its window was
// closed. On macOS the close button destroys the launcher (WindowHelper's
// hide-on-close handler is Windows/Linux only); in Undetectable there is no
// Dock icon, so the shortcut is the only way back. Source pin: the toggle path
// lives in main.ts's AppState, which needs a full Electron app to run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('a closed main window is recreated by Toggle Visibility, before the mode-specific toggle', () => {
  const main = read('electron/main.ts');
  const start = main.indexOf('public toggleMainWindow(onCurrentDisplay = false): void {');
  assert.ok(start > 0);
  const body = main.slice(start, main.indexOf('public setWindowDimensions', start));
  const recreate = body.search(/if \(this\.windowHelper\.getMainWindow\(\) === null\) \{[\s\S]*?this\.windowHelper\.createWindow\(\);\s*return;/);
  assert.ok(recreate > 0, 'recreates when the window is gone');
  assert.ok(recreate < body.indexOf("if (mode === 'launcher')"), 'before toggling');
  // The window it relies on: launcher close only hides on Windows/Linux, and 'closed' nulls it.
  const wh = read('electron/WindowHelper.ts');
  assert.match(wh, /if \(process\.platform !== 'darwin'\) \{\s*this\.launcherWindow\.on\('close'/);
  assert.match(wh, /this\.launcherWindow\.on\('closed', \(\) => \{[\s\S]*?this\.launcherWindow = null;/);
  assert.match(wh, /public createWindow\(\): void \{\s*if \(this\.launcherWindow !== null\) return;/);
});
