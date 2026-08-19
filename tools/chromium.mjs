// Finds a usable Chromium. Playwright's own download is preferred; when the
// image ships a browser under a different build number (as sandboxes often do)
// we point at that instead of failing.

import { existsSync, readdirSync } from 'fs';
import { join } from 'path';

export function resolveChromium() {
  const explicit = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (explicit && existsSync(explicit)) return { executablePath: explicit };

  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (root && existsSync(root)) {
    for (const dir of readdirSync(root).filter((d) => d.startsWith('chromium-')).sort().reverse()) {
      for (const rel of ['chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
        const candidate = join(root, dir, rel);
        if (existsSync(candidate)) return { executablePath: candidate };
      }
    }
  }
  return {};
}
