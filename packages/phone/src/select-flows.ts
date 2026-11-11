/** Real-browser accessibility and positioning regressions for the shared picker. */
import type { Page } from 'puppeteer-core';
import { PHONE, PATIENCE_MS, shot, must } from './harness.js';
import { chooseSelect } from './select.js';
import type { Seeded } from './seed.js';
import type { Check, SweepResult } from './sweep.js';

export async function runSelectFlows(
  page: Page,
  outDir: string,
  seeded: Seeded,
): Promise<SweepResult> {
  const checks: Check[] = [],
    failures: string[] = [];
  const check = (name: string, ok: boolean, detail: unknown = null) => {
    checks.push({ name, ok, detail });
    if (!ok) failures.push(name);
  };
  const openRadar = async () => {
    const handle = await page.evaluateHandle(
      () =>
        [...document.querySelectorAll<HTMLButtonElement>('main button')].find(
          (button) => button.textContent.trim() === 'New radar',
        ) ?? null,
    );
    try {
      const button = await must(handle.asElement(), 'New radar action').toElement('button');
      await button.click();
    } finally {
      await handle.dispose();
    }
  };
  const entranceRace = async (label: string) => {
    const deadline = Date.now() + PATIENCE_MS;
    const diagnostic = await page.evaluateHandle(() => {
      let panel: HTMLElement | null = null;
      let entrance: Animation | null = null;
      let frame = 0;
      let stopped = false;
      const snapshot = () => {
        const trigger = panel?.querySelector<HTMLElement>('[role="combobox"]');
        const id = trigger?.getAttribute('aria-controls');
        const menu = id ? document.getElementById(id) : null;
        const option = [...(menu?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])].find(
          (item) =>
            Boolean(item.getAttribute('data-value')) &&
            item.getAttribute('aria-disabled') !== 'true',
        );
        const rect = (element: Element | null | undefined) => {
          const box = element?.getBoundingClientRect();
          return box
            ? { left: box.left, top: box.top, right: box.right, bottom: box.bottom }
            : null;
        };
        const anchor = rect(trigger),
          bounds = rect(menu),
          item = rect(option);
        const x = item ? (item.left + item.right) / 2 : 0;
        const y = item ? (item.top + item.bottom) / 2 : 0;
        const hit = document.elementFromPoint(x, y);
        const side = menu?.getAttribute('data-side');
        const gap =
          anchor && bounds
            ? side === 'top'
              ? anchor.top - bounds.bottom
              : bounds.top - anchor.bottom
            : NaN;
        return {
          anchor,
          bounds,
          panel: rect(panel),
          x,
          y,
          value: option?.getAttribute('data-value') ?? null,
          active: entrance?.playState === 'running',
          currentTime: typeof entrance?.currentTime === 'number' ? entrance.currentTime : null,
          duration: entrance?.effect?.getComputedTiming().duration ?? null,
          transform: panel ? getComputedStyle(panel).transform : null,
          normalMotion: !matchMedia('(prefers-reduced-motion: reduce)').matches,
          portalOwned: Boolean(panel && menu && panel.contains(menu)),
          hitOwned: Boolean(option && hit && option.contains(hit)),
          anchored: Boolean(
            anchor &&
            bounds &&
            gap >= -1 &&
            gap <= 12 &&
            Math.min(Math.abs(anchor.left - bounds.left), Math.abs(anchor.right - bounds.right)) <=
              12,
          ),
        };
      };
      let during: ReturnType<typeof snapshot> | null = null;
      const delivered: {
        owner: string;
        trusted: boolean;
        pointerType: string;
        active: boolean;
        finished: boolean;
      }[] = [];
      const pointer = (event: PointerEvent) => {
        if (!panel || delivered.length >= 8) return;
        const target = event.target;
        const trigger = panel.querySelector('[role="combobox"]');
        const id = trigger?.getAttribute('aria-controls');
        const menu = id ? document.getElementById(id) : null;
        const owner =
          target instanceof Node && trigger?.contains(target)
            ? 'trigger'
            : target instanceof Element &&
                menu?.contains(target) &&
                target.closest('[role="option"]')?.getAttribute('data-value') === during?.value
              ? 'owned-option'
              : 'outside';
        delivered.push({
          owner,
          trusted: event.isTrusted,
          pointerType: event.pointerType,
          active: entrance?.playState === 'running',
          finished: entrance?.playState === 'finished',
        });
      };
      const sample = () => {
        if (stopped) return;
        const next = snapshot();
        if (!during && next.active && next.anchored && next.hitOwned && next.portalOwned)
          during = next;
        frame = requestAnimationFrame(sample);
      };
      const start = (event: AnimationEvent) => {
        if (!(event.target instanceof HTMLElement) || !event.target.matches('.modal-panel')) return;
        panel = event.target;
        entrance =
          panel
            .getAnimations()
            .find(
              (animation) =>
                animation instanceof CSSAnimation &&
                animation.animationName === event.animationName,
            ) ?? null;
        // The 220 ms window is shorter than a loaded runner's click round trip, and
        // the race is entered by that click. Run the same animation at a twentieth
        // of its speed until the click has landed (`resume`), so "during" is a state
        // reached, not a deadline met; completion is then still the real animation's.
        if (entrance) entrance.playbackRate = 0.05;
        frame = requestAnimationFrame(sample);
      };
      document.addEventListener('animationstart', start);
      document.addEventListener('pointerdown', pointer, { capture: true, passive: true });
      return {
        during: () => during,
        resume: () => {
          if (entrance) entrance.playbackRate = 1;
        },
        active: () => entrance?.playState === 'running',
        finished: () => entrance?.playState === 'finished',
        snapshot,
        events: () => delivered,
        stop: () => {
          stopped = true;
          cancelAnimationFrame(frame);
          document.removeEventListener('animationstart', start);
          document.removeEventListener('pointerdown', pointer, true);
        },
      };
    });
    try {
      await openRadar();
      await page.waitForSelector('.modal-panel [role="combobox"]', {
        timeout: Math.max(1, deadline - Date.now()),
      });
      const trigger = must(await page.$('.modal-panel [role="combobox"]'));
      await page.waitForFunction(
        (data) => data.active(),
        { timeout: Math.max(1, deadline - Date.now()) },
        diagnostic,
      );
      await trigger.click();
      await page.waitForFunction(
        (data) => Boolean(data.during()),
        { timeout: Math.max(1, deadline - Date.now()) },
        diagnostic,
      );
      const during = must(await diagnostic.evaluate((data) => data.during()));
      await diagnostic.evaluate((data) => data.resume());
      // Cross the actual animation's completion, not a guessed delay or a
      // position-stability wait. Keep the coordinates measured DURING entrance.
      await page.waitForFunction(
        (data) => data.finished(),
        { timeout: Math.max(1, deadline - Date.now()) },
        diagnostic,
      );
      const after = await diagnostic.evaluate((data) => data.snapshot());
      const eventsBefore = await diagnostic.evaluate((data) => data.events());
      check(
        `${label} picker opens during the real normal-motion entrance`,
        during.normalMotion &&
          during.active &&
          typeof during.duration === 'number' &&
          during.duration > 0 &&
          during.currentTime !== null &&
          during.currentTime < during.duration &&
          eventsBefore.some((event) => event.owner === 'trigger' && event.trusted && event.active),
        { during, eventsBefore },
      );
      check(
        `${label} picker stays anchored across actual entrance completion`,
        during.transform === 'none' &&
          after.transform === 'none' &&
          during.anchored &&
          after.anchored &&
          after.portalOwned &&
          after.hitOwned &&
          (['left', 'top', 'right', 'bottom'] as const).every(
            (edge) =>
              Math.abs((during.bounds?.[edge] ?? Infinity) - (after.bounds?.[edge] ?? -Infinity)) <=
              2,
          ),
        { during, after },
      );
      await page.mouse.click(during.x, during.y);
      const delivered = await diagnostic.evaluate((data) => data.events());
      check(
        `${label} original coordinates deliver a native owned option pointerdown after completion`,
        delivered.some(
          (event) =>
            event.owner === 'owned-option' &&
            event.trusted &&
            event.pointerType === 'mouse' &&
            event.finished,
        ),
        delivered,
      );
      // Radix commits the selection before FocusScope restores the trigger in
      // its deferred unmount callback. Observe both outcomes within this race's
      // existing deadline; a committed value alone is not a completed close.
      await page.waitForFunction(
        (element: Element, value: string | null) =>
          element.isConnected &&
          element.getAttribute('data-value') === value &&
          document.activeElement === element &&
          Boolean(element.closest('[role="dialog"]')),
        { timeout: Math.max(1, deadline - Date.now()) },
        trigger,
        during.value,
      );
      check(
        `${label} entrance-race selection commits and keeps focus in its modal`,
        await trigger.evaluate(
          (element, value) =>
            element.isConnected &&
            element.getAttribute('data-value') === value &&
            document.activeElement === element &&
            Boolean(element.closest('[role="dialog"]')),
          during.value,
        ),
      );
      await page.keyboard.press('Escape');
      await page.waitForSelector('.modal-panel', {
        hidden: true,
        timeout: Math.max(1, deadline - Date.now()),
      });
    } catch (cause) {
      const evidence = await diagnostic.evaluate((data) => ({
        during: data.during(),
        after: data.snapshot(),
        delivered: data.events(),
      }));
      throw new Error(`${label} real entrance race failed: ${JSON.stringify(evidence)}`, { cause });
    } finally {
      await diagnostic.evaluate((data) => data.stop());
      await diagnostic.dispose();
    }
  };
  const backgrounds = new Map<string, string>();
  await page.goto(`${seeded.baseUrl}/radars`, { waitUntil: 'networkidle2' });
  const originalTheme = await page.evaluate(() => localStorage.getItem('omr.theme'));
  try {
    for (const width of [390, 1366])
      for (const theme of ['light', 'dark']) {
        const label = `[select ${width} ${theme}]`;
        await page.setViewport(width === 390 ? PHONE : { width, height: 900 });
        await page.evaluate((value) => localStorage.setItem('omr.theme', value), theme);
        await page.goto(`${seeded.baseUrl}/radars`, { waitUntil: 'networkidle2' });
        await page.emulateMediaFeatures([
          { name: 'prefers-reduced-motion', value: 'no-preference' },
        ]);
        await entranceRace(label);
        const opened = await page.evaluate(() => {
          const trigger = [...document.querySelectorAll<HTMLButtonElement>('main button')].find(
            (button) => button.textContent.trim() === 'New radar',
          );
          trigger?.click();
          return Boolean(trigger);
        });
        if (!opened) throw new Error('Missing New radar action');
        await page.waitForSelector('.modal-panel [role="combobox"]', { visible: true });
        const triggers = await page.$$('.modal-panel [role="combobox"]');
        const topic = must(triggers[0]);
        const previous = await topic.evaluate((element) => element.getAttribute('data-value'));
        await topic.focus();
        await page.keyboard.press('ArrowDown');
        await page.waitForSelector('[role="listbox"]', { visible: true });
        await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'option');
        await page.keyboard.press('Home');
        await page.waitForFunction(() => document.activeElement?.getAttribute('data-value') === '');
        await page.keyboard.press('ArrowDown');
        await page.waitForFunction(() =>
          Boolean(document.activeElement?.getAttribute('data-value')),
        );
        await page.keyboard.press('Enter');
        await page.waitForSelector('[role="listbox"]', { hidden: true });
        await page.waitForFunction(
          (element: Element, prior: string | null) => {
            const value = element.getAttribute('data-value');
            return Boolean(value) && value !== prior;
          },
          {},
          topic,
          previous,
        );
        const selected = await topic.evaluate((element) => element.getAttribute('data-value'));
        check(`${label} keyboard selects a topic`, selected !== previous && Boolean(selected), {
          previous,
          selected,
        });
        await chooseSelect(page, '.modal-panel', '', `${label} empty topic reset`);
        check(
          `${label} empty topic value is selectable`,
          await topic.evaluate((element) => element.getAttribute('data-value') === ''),
        );
        const layout = must(triggers.at(-1));
        await layout.evaluate((element) => element.scrollIntoView({ block: 'end' }));
        await layout.click();
        await page.waitForSelector('[role="listbox"]', { visible: true });
        const bounds = await page.$eval('[role="listbox"]', (element) => {
          const rect = element.getBoundingClientRect(),
            viewport = window.visualViewport;
          return {
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
            width: viewport?.width ?? innerWidth,
            height: viewport?.height ?? innerHeight,
            background: getComputedStyle(element).backgroundColor,
            options: element.querySelectorAll('[role="option"]').length,
          };
        });
        backgrounds.set(`${width}-${theme}`, bounds.background);
        check(
          `${label} menu fits viewport`,
          bounds.left >= -1 &&
            bounds.top >= -1 &&
            bounds.right <= bounds.width + 1 &&
            bounds.bottom <= bounds.height + 1,
          bounds,
        );
        check(`${label} menu shows available options`, bounds.options > 1);
        await shot(page, outDir, `select-${width}-${theme}`);
        await page.keyboard.press('Escape');
        await page.waitForSelector('[role="listbox"]', { hidden: true });
        check(`${label} Escape closes only the picker`, Boolean(await page.$('.modal-panel')));
        await page.waitForFunction(
          () => document.activeElement?.getAttribute('role') === 'combobox',
        );
        check(
          `${label} Escape restores combobox focus`,
          await layout.evaluate((element) => document.activeElement === element),
        );
        await page.keyboard.press('Escape');
        await page.waitForSelector('.modal-panel', { hidden: true });
      }
    for (const width of [390, 1366])
      check(
        `[select ${width}] menu follows light and dark themes`,
        backgrounds.get(`${width}-light`) !== backgrounds.get(`${width}-dark`),
        Object.fromEntries(backgrounds),
      );
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await openRadar();
    await page.waitForSelector('.modal-panel', { visible: true });
    const reduced = await page.$eval('.modal-panel', (panel) => ({
      duration: getComputedStyle(panel).animationDuration,
      transform: getComputedStyle(panel).transform,
      running: panel.getAnimations().some((animation) => animation.playState === 'running'),
    }));
    check(
      'modal entrance respects reduced motion',
      reduced.duration === '0s' && reduced.transform === 'none' && !reduced.running,
      reduced,
    );
    await page.keyboard.press('Escape');
    await page.waitForSelector('.modal-panel', { hidden: true });
  } finally {
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
    await page.evaluate(
      (value) =>
        value === null
          ? localStorage.removeItem('omr.theme')
          : localStorage.setItem('omr.theme', value),
      originalTheme,
    );
  }
  return { checks, failures, notes: [] };
}
