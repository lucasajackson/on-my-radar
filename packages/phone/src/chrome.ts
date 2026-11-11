/**
 * Finding a browser to drive.
 *
 * puppeteer-core deliberately ships no browser, so the suite has to be told
 * where one is. The order below is "whatever the environment said" first, then
 * the two places a browser actually lands in practice: puppeteer's own cache on
 * a developer's machine, and the distribution package in CI.
 *
 * It never downloads anything. A suite that quietly pulls 170MB the first time
 * somebody runs it is a suite that appears to have hung.
 */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Explicit wins. `PUPPETEER_EXECUTABLE_PATH` is the conventional spelling. */
const FROM_ENV = ['OMR_CHROME', 'PUPPETEER_EXECUTABLE_PATH', 'CHROME_PATH'] as const;

/** Where a distribution puts it. `chromium` is what Debian bookworm installs. */
const SYSTEM = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

/** Leaf path inside one `chrome/<build>/` directory of puppeteer's cache. */
const CACHE_LEAVES = [
  'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  'chrome-linux64/chrome',
];

function fromPuppeteerCache(): string | null {
  const root = join(
    process.env['PUPPETEER_CACHE_DIR'] ?? join(homedir(), '.cache', 'puppeteer'),
    'chrome',
  );
  if (!existsSync(root)) return null;
  // Newest build wins. The directory names are `<platform>-<version>`, which
  // sorts close enough to version order that reversing puts the newest first.
  for (const build of readdirSync(root).sort().reverse()) {
    for (const leaf of CACHE_LEAVES) {
      const candidate = join(root, build, leaf);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export function findChrome(): string {
  for (const key of FROM_ENV) {
    const value = process.env[key];
    if (!value) continue;
    if (existsSync(value)) return value;
    throw new Error(`${key} is set to ${value}, which does not exist`);
  }

  const cached = fromPuppeteerCache();
  if (cached) return cached;

  for (const candidate of SYSTEM) {
    if (existsSync(candidate)) return candidate;
  }

  throw new Error(
    [
      'No Chrome to drive. This suite needs a real browser and never downloads one.',
      '',
      '  macOS / local:   pnpm dlx @puppeteer/browsers install chrome@stable',
      '  Debian / CI:     apt-get install -y --no-install-recommends chromium',
      '',
      'Or point OMR_CHROME at an executable you already have.',
    ].join('\n'),
  );
}
