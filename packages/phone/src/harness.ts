/**
 * Drives On My Radar at a genuine iPhone viewport in headless Chrome.
 *
 * Two things are emulated here, and they are NOT the same thing:
 *
 *  - **the phone**: 390x844 CSS px, dpr 3, isMobile, hasTouch, a real iOS UA.
 *    That gives a true phone layout — every media query, every touch target,
 *    every `@media (hover: none)` rule. This part is genuine.
 *
 *  - **the keyboard**: iOS Safari shrinks only the VISUAL viewport when the
 *    keyboard comes up; the layout viewport stays 844 tall. Chrome has no way to
 *    reproduce that split, so `keyboard(page, 390)` shadows `visualViewport`'s
 *    own `height` and `offsetTop` with the values iOS would report and fires its
 *    resize event. That is exactly the signal a correct layout has to consult,
 *    so the assertion is real — but the occlusion is drawn, not felt. See
 *    docs/PHONE.md for what that leaves unverified.
 */
import { mkdirSync } from 'node:fs';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { findChrome } from './chrome.js';

export const IOS_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';

/** iPhone 14 / 15 / 16 in portrait — the shape the product owner actually captures on. */
export const PHONE = {
  width: 390,
  height: 844,
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  isLandscape: false,
};

/** Height iOS Safari leaves above the keyboard on a 390x844 phone, near enough. */
export const KEYBOARD_VISUAL_HEIGHT = 390;

/**
 * How long any single wait is allowed to take. Generous on purpose: this runs
 * beside other work on a developer's machine and beside other jobs on a CI
 * runner, and a suite that fails under load gets disabled rather than fixed.
 */
export const PATIENCE_MS = 20_000;

export interface Rect {
  selector: string;
  top: number;
  bottom: number;
  left: number;
  right: number;
  text: string;
}

export interface Harness {
  browser: Browser;
  page: Page;
  outDir: string;
}

declare global {
  interface Window {
    __omrKeyboard?: number | undefined;
    __omrKeyboardTop?: number | undefined;
  }
}

export async function open(outDir: string, baseUrl: string, cookie: string): Promise<Harness> {
  mkdirSync(outDir, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: true,
    // --no-sandbox because CI runs as root in a container, where Chrome's own
    // sandbox cannot start. --hide-scrollbars keeps a scrollbar out of the 390
    // so an overflow assertion measures the layout and not the chrome. The last flag makes a
    // desktop page a mouse device: headless Linux Chromium reports `hover: none`, which hides the
    // hover-only controls (and the 390 phone emulation still sets its own touch, no-hover media).
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      '--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4',
    ],
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(PATIENCE_MS);
  page.setDefaultNavigationTimeout(PATIENCE_MS);
  await page.setUserAgent({ userAgent: IOS_UA });
  await page.setViewport(PHONE);

  /*
   * esbuild's `keepNames`, which tsx turns on, rewrites every named inner
   * function into `__name(fn, "…")` so `fn.name` survives minification. Puppeteer
   * serialises an evaluate callback to source and runs it in the BROWSER, where
   * that helper does not exist — so any callback here containing a named inner
   * function dies on `ReferenceError: __name is not defined`.
   *
   * An identity `__name` is the whole fix. It is passed as a raw string on
   * purpose: written as a function it would itself be transpiled, and would then
   * need the very helper it is defining.
   */
  await page.evaluateOnNewDocument('globalThis.__name ??= function (fn) { return fn; };');

  // Installed before any app script runs, so the app sees the shim from its very
  // first read. Off by default — `keyboard()` is what turns it on.
  await page.evaluateOnNewDocument(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const proto = Object.getPrototypeOf(vv) as object;
    const realHeight = Object.getOwnPropertyDescriptor(proto, 'height')?.get?.bind(vv);
    const realOffsetTop = Object.getOwnPropertyDescriptor(proto, 'offsetTop')?.get?.bind(vv);
    if (!realHeight || !realOffsetTop) return;
    Object.defineProperty(vv, 'height', {
      configurable: true,
      get: () => window.__omrKeyboard ?? Number(realHeight()),
    });
    Object.defineProperty(vv, 'offsetTop', {
      configurable: true,
      get: () => (window.__omrKeyboard ? (window.__omrKeyboardTop ?? 0) : Number(realOffsetTop())),
    });
  });

  const [name, value] = cookie.split('=');
  if (name && value) {
    await browser.setCookie({
      name,
      value,
      domain: new URL(baseUrl).hostname,
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
    });
  }

  return { browser, page, outDir };
}

export const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(() => resolve(), ms);
  });

/** Raise (a height) or drop (null) the simulated iOS keyboard. */
export async function keyboard(page: Page, visualHeight: number | null): Promise<void> {
  await page.evaluate((h: number | null) => {
    window.__omrKeyboard = h ?? undefined;
    window.__omrKeyboardTop = 0;
    window.visualViewport?.dispatchEvent(new Event('resize'));
    window.dispatchEvent(new Event('resize'));
  }, visualHeight);
  await wait(300);
}

/**
 * Paints a stand-in keyboard over the region iOS would occlude, so a screenshot
 * shows what the person is actually looking at. Drawn last, above everything.
 * Purely for the artefact — no assertion ever reads it.
 */
export async function paintKeyboard(page: Page, visualHeight: number): Promise<void> {
  await page.evaluate((h: number) => {
    document.getElementById('__omr-kb')?.remove();
    const kb = document.createElement('div');
    kb.id = '__omr-kb';
    kb.style.cssText = `position:fixed;left:0;right:0;top:${h}px;bottom:0;z-index:2147483647;
      background:repeating-linear-gradient(45deg,#2b2b30,#2b2b30 10px,#232328 10px,#232328 20px);
      border-top:2px solid #6b6b78;color:#c9c9d4;font:600 13px/1.4 -apple-system,system-ui,sans-serif;
      display:flex;align-items:center;justify-content:center;letter-spacing:.08em;text-transform:uppercase;`;
    kb.textContent = 'iOS keyboard (simulated)';
    document.body.appendChild(kb);
  }, visualHeight);
}

export async function unpaintKeyboard(page: Page): Promise<void> {
  await page.evaluate(() => document.getElementById('__omr-kb')?.remove());
}

export async function shot(page: Page, outDir: string, name: string): Promise<void> {
  await page.screenshot({ path: `${outDir}/${name}.png` });
}

/** Rect of the first element matching any selector, in visual-viewport coords. */
export async function rectOf(page: Page, selectors: string[]): Promise<Rect | null> {
  return page.evaluate((list: string[]) => {
    for (const selector of list) {
      const node = document.querySelector(selector);
      if (!node) continue;
      const r = node.getBoundingClientRect();
      return {
        selector,
        top: Math.round(r.top),
        bottom: Math.round(r.bottom),
        left: Math.round(r.left),
        right: Math.round(r.right),
        text: node.textContent.trim().slice(0, 40),
      };
    }
    return null;
  }, selectors);
}

/**
 * "This is here", checked in Node rather than asserted with `!`: a missing
 * element or seed row fails with a sentence at the line that expected it.
 * Not for `page.evaluate` callbacks, which run in the browser where this
 * function does not exist.
 */
export function must<T>(value: T, what = 'a value'): NonNullable<T> {
  if (value === null || value === undefined) {
    throw new Error(`Expected ${what}, got ${String(value)}`);
  }
  return value;
}
