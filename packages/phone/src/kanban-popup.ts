/** Genuine served board popup gestures and persistence; isolated synthetic accounts only. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import type { Page } from 'puppeteer-core';
import { LIMITS, type BlipDto, type RadarDto } from '@onmyradar/contract';
import { must, PHONE, IOS_UA, PATIENCE_MS } from './harness.js';
import type { Seeded } from './seed.js';
import type { Check, SweepResult } from './sweep.js';

type Phase =
  | 'setup'
  | 'body-open'
  | 'edit'
  | 'invalid-save'
  | 'save'
  | 'comment'
  | 'lane'
  | 'close'
  | 'reload'
  | 'keyboard'
  | 'escape'
  | 'nested'
  | 'drag'
  | 'notification'
  | 'compact'
  | 'delete'
  | 'viewer';

async function nativeButton(page: Page, label: string, scope: string) {
  const buttons = await page.$$(`${scope} button`);
  try {
    for (const button of buttons) {
      if (
        await button.evaluate(
          (node, text) =>
            node.getAttribute('aria-label') === text ||
            (node.classList.contains('board-pager-lane')
              ? node.firstChild?.textContent?.trim()
              : node.textContent.trim()) === text,
          label,
        )
      ) {
        await button.click();
        return;
      }
    }
    throw new Error('Synthetic board control unavailable');
  } finally {
    await Promise.all(buttons.map((button) => button.dispose()));
  }
}

async function replaceText(page: Page, selector: string, text: string) {
  await page.click(selector);
  // Select what is there the way the control itself does, so it is the same on every platform
  // (Control+A is "start of line" on macOS), then type over it as a person does.
  await page.$eval(selector, (node) => {
    if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) node.select();
  });
  await page.keyboard.type(text);
}

export async function viewerLogin(base: string, email: string) {
  const challenge = await fetch(base + '/api/auth/request-code', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
    signal: AbortSignal.timeout(PATIENCE_MS),
  });
  assert(challenge.ok, 'Synthetic viewer challenge refused');
  const code = must(((await challenge.json()) as { devCode?: string }).devCode);
  const cookie = challenge.headers
    .getSetCookie()
    .map((part) => part.split(';')[0])
    .join('; ');
  const response = await fetch(base + '/api/auth/verify-code', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ email, code }),
    signal: AbortSignal.timeout(PATIENCE_MS),
  });
  assert(response.ok, 'Synthetic viewer login refused');
  return must(
    response.headers
      .getSetCookie()
      .map((part) => part.split(';')[0])
      .find((part) => part?.startsWith('omr_session=')),
  );
}

async function geometry(page: Page) {
  await page.$eval('.modal-panel', async (panel) => {
    await Promise.all(panel.getAnimations().map((animation) => animation.finished));
  });
  const result = await page.evaluate(() => {
    const panel = document.querySelector('[role="dialog"]');
    const bounds = panel?.getBoundingClientRect();
    const body = document.querySelector('.modal-body');
    const title = document.querySelector('.modal-head h2');
    const reading = document.querySelector('.kanban-detail .reading-body');
    const detail = document.querySelector('.kanban-detail');
    return {
      viewport: innerWidth,
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
      panelWidth: bounds?.width ?? 0,
      panelHeight: bounds?.height ?? 0,
      panelTop: bounds?.top ?? 0,
      panelRight: bounds?.right ?? 0,
      panelBottom: bounds?.bottom ?? 0,
      panelLeft: bounds?.left ?? 0,
      viewportHeight: innerHeight,
      scrollBody: body instanceof HTMLElement && getComputedStyle(body).overflowY === 'auto',
      panelVisible: Boolean(bounds && bounds.width > 0 && bounds.height > 0),
      panelContained: Boolean(
        bounds &&
        bounds.left >= -1 &&
        bounds.right <= innerWidth + 1 &&
        bounds.top >= -1 &&
        bounds.bottom <= innerHeight + 1,
      ),
      comments: document.querySelectorAll('[role="dialog"] .comment').length,
      editor: document.querySelector('[role="dialog"] textarea[id^="body-"]') !== null,
      dark: getComputedStyle(document.documentElement).colorScheme === 'dark',
      titleFont: title ? parseFloat(getComputedStyle(title).fontSize) : 0,
      bodyFont: reading ? parseFloat(getComputedStyle(reading).fontSize) : 0,
      detailPaddingLeft: detail ? parseFloat(getComputedStyle(detail).paddingLeft) : -1,
    };
  });
  console.log('[kanban-popup-geometry]', result);
  return result;
}

async function cardGeometry(page: Page, selector: string) {
  return page.$eval(selector, (node) => {
    const bounds = node.getBoundingClientRect();
    const title = node.querySelector('h3')?.getBoundingClientRect();
    const meta = node.querySelector('.blip-meta')?.getBoundingClientRect();
    const body = node.querySelector('.blip-body')?.getBoundingClientRect();
    const actions = node.querySelector('.blip-actions');
    const actionBounds = actions?.getBoundingClientRect();
    return {
      height: bounds.height,
      titleDistance: title ? title.top - bounds.top : -1,
      metadataHeight: meta?.height ?? 0,
      actionsAfterBody: Boolean(body && actionBounds && actionBounds.top >= body.bottom),
      visibleActions: Boolean(
        actions &&
        getComputedStyle(actions).opacity === '1' &&
        getComputedStyle(actions).pointerEvents === 'auto',
      ),
      contained: Boolean(
        actionBounds &&
        actionBounds.left >= bounds.left - 1 &&
        actionBounds.right <= bounds.right + 1,
      ),
    };
  });
}

export async function runKanbanPopup(
  page: Page,
  outDir: string,
  seeded: Seeded,
  template: 'kanban' | 'helpdesk' = 'kanban',
): Promise<SweepResult> {
  const checks: Check[] = [],
    failures: string[] = [];
  const evidence: unknown[] = [];
  const prefix = `${template}-popup`;
  const initialStatus = template === 'helpdesk' ? 'new' : 'backlog';
  const movedStatus = template === 'helpdesk' ? 'scheduled' : 'todo';
  const movedLabel = template === 'helpdesk' ? 'Scheduled' : 'To do';
  const check = (name: string, ok: boolean, detail: unknown = null) => {
    checks.push({ name, ok, detail });
    if (!ok) failures.push(name);
    assert(ok, name);
  };
  const call = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
    const response = await fetch(seeded.baseUrl + path, {
      method,
      headers: { cookie: seeded.ownerCookie, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(PATIENCE_MS),
    });
    assert(response.ok, 'Synthetic board API refused');
    return (await response.json()) as T;
  };
  for (const width of [390, 1280]) {
    const context = await page.browser().createBrowserContext();
    const human = await context.newPage();
    await human.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    human.setDefaultTimeout(PATIENCE_MS);
    await human.setViewport(width === 390 ? PHONE : { width, height: 900 });
    if (width === 390) await human.setUserAgent({ userAgent: IOS_UA });
    await context.setCookie({
      name: 'omr_session',
      value: seeded.ownerCookie.slice('omr_session='.length),
      domain: new URL(seeded.baseUrl).hostname,
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
    });
    let phase: Phase = 'setup';
    let status: number | null = null;
    const errors: string[] = [];
    const httpErrors: number[] = [];
    const expectedValidation: number[] = [];
    const validationProbe = { path: '' };
    human.on('response', (response) => {
      if (response.status() < 400) return;
      if (
        response.request().method() === 'PATCH' &&
        response.status() === 400 &&
        new URL(response.url()).pathname === validationProbe.path
      )
        expectedValidation.push(400);
      else if (httpErrors.length < 32) httpErrors.push(response.status());
    });
    human.on('pageerror', () => {
      if (errors.length < 64) errors.push('page-error');
    });
    human.on('console', (message) => {
      if (message.type() === 'error' && errors.length < 64) errors.push('console-error');
    });
    const tag = `[${template} popup ${width}]`;
    try {
      const { radar } = await call<{ radar: RadarDto }>('/api/radars', 'POST', {
        name: `${template} popup scratch ${width}`,
        template,
        commentsEnabled: true,
        reactionsEnabled: false,
      });
      const title = `Popup card ${width}`;
      const ending = `Full-body ending ${width}`;
      const longBody = `# ${title}\n**Readable markdown** and [nested source](${seeded.baseUrl}/radar/${radar.id}). #popup\n\n${'Long synthetic prose for compact board cards. '.repeat(60)}${ending}`;
      const { blip } = await call<{ blip: BlipDto }>(`/api/radars/${radar.id}/blips`, 'POST', {
        body: longBody,
      });
      const { blip: fileCard } = await call<{ blip: BlipDto }>(
        `/api/radars/${radar.id}/blips`,
        'POST',
        {
          title: `File notes ${width}`,
          kind: 'file',
          body: 'Synthetic file-kind notes; no uploaded bytes claimed. '.repeat(30),
        },
      );
      const { blip: linkCard } = await call<{ blip: BlipDto }>(
        `/api/radars/${radar.id}/blips`,
        'POST',
        {
          title: `Source link ${width}`,
          kind: 'link',
          url: `${seeded.baseUrl}/radar/${radar.id}`,
          body: 'Long source commentary. '.repeat(50),
        },
      );
      const initialComment = `Existing comment ${width}`;
      await call(`/api/blips/${blip.id}/comments`, 'POST', { body: initialComment });
      validationProbe.path = `/api/blips/${blip.id}`;
      const card = `.board-card [data-blip-id="${blip.id}"]`;
      const bodySelector = `${card} .blip-body`;
      const opener = `${card} [data-open-blip]`;
      const dialog = '[role="dialog"]';
      const titleField = `${dialog} input[id="title-${blip.id}"]`;
      const bodyField = `${dialog} textarea[id="body-${blip.id}"]`;
      const commentField = `${dialog} textarea[id="comment-${blip.id}"]`;
      const patchResponse = () =>
        human.waitForResponse(
          (response) =>
            response.request().method() === 'PATCH' &&
            new URL(response.url()).pathname === `/api/blips/${blip.id}`,
        );
      await human.goto(`${seeded.baseUrl}/radar/${radar.id}`, { waitUntil: 'networkidle2' });
      await human.waitForSelector(bodySelector, { visible: true });
      phase = 'compact';
      const preview = await human.$eval(
        bodySelector,
        (node, marker) => ({
          height: node.getBoundingClientRect().height,
          fullEnding: node.textContent.includes(marker),
          clamped: getComputedStyle(node).getPropertyValue('-webkit-line-clamp') === '4',
        }),
        ending,
      );
      check(
        `${tag} long markdown stays a short in-lane preview`,
        preview.height <= 97 && !preview.fullEnding && preview.clamped,
        preview,
      );
      await human.screenshot({
        path: `${outDir}/${prefix}-${width}-board.png`,
        fullPage: false,
      });
      const restingCard = await cardGeometry(human, card);
      console.log('[kanban-card-geometry]', { width, ...restingCard });
      check(
        `${tag} title promptly follows compact metadata and visible bottom actions`,
        restingCard.titleDistance > 0 &&
          restingCard.titleDistance <= 65 &&
          restingCard.metadataHeight <= 48 &&
          restingCard.actionsAfterBody &&
          restingCard.visibleActions &&
          restingCard.contained,
        restingCard,
      );
      if (width === 1280) {
        await human.hover(card);
        const hoveredCard = await cardGeometry(human, card);
        check(
          `${tag} board hover has no height jump`,
          hoveredCard.height === restingCard.height,
          hoveredCard,
        );
        await human.screenshot({
          path: `${outDir}/${prefix}-1280-board-hover.png`,
          fullPage: false,
        });
        await human.focus(`${card} [data-open-blip]`);
        const focusedCard = await cardGeometry(human, card);
        check(
          `${tag} board keyboard focus has no height jump`,
          focusedCard.height === restingCard.height,
          focusedCard,
        );
        await human.screenshot({
          path: `${outDir}/${prefix}-1280-board-focus.png`,
          fullPage: false,
        });
      }
      check(
        `${tag} file-kind and link cards retain compact bodies and source affordance`,
        await human.evaluate(
          (ids) => {
            const file = document.querySelector(
              `.board-card [data-blip-id="${ids.file}"] .blip-body`,
            );
            const link = document.querySelector(`.board-card [data-blip-id="${ids.link}"]`);
            const linkBody = link?.querySelector('.blip-body');
            return (
              file instanceof HTMLElement &&
              file.getBoundingClientRect().height <= 97 &&
              link?.querySelector('.source-link') instanceof HTMLAnchorElement &&
              linkBody instanceof HTMLElement &&
              linkBody.getBoundingClientRect().height <= 97
            );
          },
          { file: fileCard.id, link: linkCard.id },
        ),
      );
      phase = 'body-open';
      await human.click(bodySelector);
      await human.waitForSelector(`${dialog} .comment`, { visible: true });
      check(
        `${tag} native body opens full card and existing comments`,
        await human.$eval(dialog, (node, text) => node.textContent.includes(text), initialComment),
      );
      const readGeometry = await geometry(human);
      const toolbar = await human.$eval(dialog, (node) => {
        const meta = node.querySelector('.blip-meta')?.getBoundingClientRect();
        const actions = node.querySelector('.kanban-detail-actions')?.getBoundingClientRect();
        const lane = node
          .querySelector('.kanban-detail-actions .select-trigger')
          ?.getBoundingClientRect();
        const edit = node.querySelector('button[title="Edit"]')?.getBoundingClientRect();
        const scroller = node.querySelector('.modal-body');
        return {
          metadataHeight: meta?.height ?? 0,
          actionHeight: actions?.height ?? 0,
          selectWidth: lane?.width ?? 0,
          actionWidth: actions?.width ?? 0,
          laneEditAligned: Boolean(lane && edit && Math.abs(lane.top - edit.top) < 10),
          initialScroll: scroller?.scrollTop ?? -1,
        };
      });
      console.log('[kanban-toolbar-geometry]', { width, ...toolbar });
      check(
        `${tag} initial popup toolbar is compact and unscrolled`,
        toolbar.initialScroll === 0 &&
          toolbar.selectWidth > 0 &&
          toolbar.selectWidth < toolbar.actionWidth &&
          (width === 390
            ? toolbar.actionHeight <= 100 && toolbar.metadataHeight <= 170
            : toolbar.laneEditAligned &&
              toolbar.actionHeight <= 45 &&
              toolbar.metadataHeight <= 95),
        toolbar,
      );
      await human.screenshot({
        path: `${outDir}/${prefix}-${width}-initial.png`,
        fullPage: false,
      });
      await human.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
      check(
        `${tag} initial dark popup retains containment`,
        (await geometry(human)).panelContained,
      );
      await human.screenshot({
        path: `${outDir}/${prefix}-${width}-dark-initial.png`,
        fullPage: false,
      });
      await human.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
      check(
        `${tag} prominent title and flush detail surface use actual computed styles`,
        readGeometry.titleFont > readGeometry.bodyFont &&
          readGeometry.titleFont >= (width === 390 ? 17 : 20) &&
          readGeometry.detailPaddingLeft === 0,
        readGeometry,
      );
      check(
        `${tag} popup has one title, searchable tag, readable measure and explicit edit`,
        await human.$eval(
          dialog,
          (node, expectedTitle) => {
            const content = node.querySelector('.kanban-detail');
            const reading = content?.querySelector('.reading-body');
            const width = content?.getBoundingClientRect().width ?? 0;
            return (
              node.querySelector('.modal-head h2')?.textContent === expectedTitle &&
              content?.querySelector('h3')?.textContent === 'Comments' &&
              node.querySelectorAll('a[href="/t/popup"]').length === 1 &&
              node.querySelector('button[title="Edit"]')?.textContent === 'Edit' &&
              width > 0 &&
              width <= 833 &&
              reading instanceof HTMLElement &&
              parseFloat(getComputedStyle(reading).lineHeight) >= 27
            );
          },
          title,
        ),
      );
      check(
        `${tag} readable popup stays within viewport`,
        readGeometry.panelVisible &&
          readGeometry.panelContained &&
          !readGeometry.overflow &&
          readGeometry.scrollBody &&
          readGeometry.panelHeight >= readGeometry.viewportHeight - 40 &&
          (width === 390 ? readGeometry.panelWidth >= 388 : readGeometry.panelWidth >= 900),
        readGeometry,
      );
      check(
        `${tag} full popup retains unabridged body and markdown link`,
        await human.$eval(
          dialog,
          (node, marker) =>
            node.textContent.includes(marker) &&
            node.querySelector('.blip-body a') !== null &&
            node.querySelector('.blip-body')?.classList.contains('line-clamp-4') === false,
          ending,
        ),
      );
      await human.screenshot({ path: `${outDir}/${prefix}-${width}-read.png`, fullPage: false });
      await human.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
      const darkRead = await geometry(human);
      check(`${tag} dark read remains contained`, darkRead.dark && darkRead.panelContained);
      await human.screenshot({
        path: `${outDir}/${prefix}-${width}-dark-read.png`,
        fullPage: false,
      });
      await human.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
      await human.click(`${dialog} button[aria-label="Close"]`);
      await human.waitForFunction(() => !document.querySelector('[role="dialog"]'));
      const surface = must(await human.$(card));
      try {
        await surface.click({ offset: { x: 6, y: 24 } });
      } finally {
        await surface.dispose();
      }
      await human.waitForSelector(`${dialog} .comment`, { visible: true });
      check(`${tag} plain noninteractive card padding also opens details`, true);
      for (let tab = 0; tab < 4; tab++) {
        await human.keyboard.press('Tab');
        check(
          `${tag} Tab ${tab} remains inside details`,
          await human.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]'))),
        );
      }
      phase = 'edit';
      await human.click(`${dialog} button[title="Edit"]`);
      await human.waitForSelector(bodyField, { visible: true });
      const changedBody = `${longBody}\nSaved popup text ${width}. #popup`;
      const changedTitle = `Edited popup ${width}`;
      await replaceText(human, bodyField, changedBody);
      await replaceText(human, titleField, changedTitle);
      const editGeometry = await geometry(human);
      check(
        `${tag} comments remain present beside editing`,
        editGeometry.editor && editGeometry.comments >= 1 && !editGeometry.overflow,
        editGeometry,
      );
      await human.screenshot({ path: `${outDir}/${prefix}-${width}-edit.png`, fullPage: false });
      await human.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
      const darkEdit = await geometry(human);
      check(
        `${tag} dark edit retains comments and containment`,
        darkEdit.dark &&
          darkEdit.editor &&
          darkEdit.comments >= 1 &&
          darkEdit.panelContained &&
          !darkEdit.overflow,
      );
      await human.screenshot({
        path: `${outDir}/${prefix}-${width}-dark-edit.png`,
        fullPage: false,
      });
      await human.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
      phase = 'invalid-save';
      await replaceText(human, titleField, 'x'.repeat(LIMITS.blipTitle + 1));
      const [invalid] = await Promise.all([patchResponse(), nativeButton(human, 'Save', dialog)]);
      status = invalid.status();
      check(
        `${tag} real validation failure keeps draft and retry`,
        status === 400 &&
          (await human.$eval(
            bodyField,
            (node, text) => node instanceof HTMLTextAreaElement && node.value === text,
            changedBody,
          )),
      );
      phase = 'save';
      await replaceText(human, titleField, changedTitle);
      const [saved] = await Promise.all([patchResponse(), nativeButton(human, 'Save', dialog)]);
      status = saved.status();
      check(`${tag} native save succeeds`, status === 200);
      await human.waitForFunction((selector) => !document.querySelector(selector), {}, bodyField);
      const stored = (await call<{ blip: BlipDto }>(`/api/blips/${blip.id}`)).blip;
      check(
        `${tag} real service retains body/title and original lane`,
        stored.body === changedBody &&
          stored.title === changedTitle &&
          stored.status === initialStatus,
      );
      phase = 'comment';
      await human.type(commentField, `Posted in popup ${width}`);
      const [posted] = await Promise.all([
        human.waitForResponse(
          (response) =>
            response.request().method() === 'POST' &&
            new URL(response.url()).pathname === `/api/blips/${blip.id}/comments`,
        ),
        nativeButton(human, 'Post comment', dialog),
      ]);
      status = posted.status();
      check(`${tag} native comment is accepted`, status === 201);
      await human.waitForFunction(
        (text) => document.querySelector('[role="dialog"]')?.textContent.includes(text),
        {},
        `Posted in popup ${width}`,
      );
      phase = 'lane';
      await human.click(`${dialog} button[id="state-${blip.id}"]`);
      await human.waitForSelector('[role="option"]', { visible: true });
      const options = await human.$$('[role="option"]');
      try {
        const labels = await Promise.all(
          options.map((option) => option.evaluate((node) => node.textContent.trim())),
        );
        const target = must(options[labels.indexOf(movedLabel)]);
        const [moved] = await Promise.all([patchResponse(), target.click()]);
        status = moved.status();
        check(`${tag} native lane change succeeds`, status === 200);
      } finally {
        await Promise.all(options.map((option) => option.dispose()));
      }
      await human.waitForFunction(
        (id, expected) =>
          document
            .querySelector(`[role="dialog"] button[id="state-${id}"]`)
            ?.getAttribute('data-value') === expected,
        {},
        blip.id,
        movedStatus,
      );
      check(
        `${tag} moving lanes preserves popup and comments`,
        await human.$eval(
          dialog,
          (node, text) => node.textContent.includes(text),
          `Posted in popup ${width}`,
        ),
      );
      phase = 'close';
      await human.click(`${dialog} button[aria-label="Close"]`);
      await human.waitForFunction(() => !document.querySelector('[role="dialog"]'));
      await human.waitForFunction(
        (selector) => document.activeElement === document.querySelector(selector),
        {},
        opener,
      );
      check(`${tag} close returns focus to moved card`, true);
      phase = 'reload';
      await human.reload({ waitUntil: 'networkidle2' });
      if (width === 390) await nativeButton(human, movedLabel, '.board-pager');
      await human.waitForSelector(opener, { visible: true });
      const persisted = (await call<{ blip: BlipDto }>(`/api/blips/${blip.id}`)).blip;
      check(
        `${tag} reload retains edits and moved lane`,
        persisted.body === changedBody &&
          persisted.title === changedTitle &&
          persisted.status === movedStatus,
      );
      phase = 'keyboard';
      await human.focus(opener);
      await human.keyboard.press('Enter');
      await human.waitForSelector(`${dialog} .comment`, { visible: true });
      check(
        `${tag} keyboard opens retained conversation`,
        await human.$eval(
          dialog,
          (node, text) => node.textContent.includes(text),
          `Posted in popup ${width}`,
        ),
      );
      await human.keyboard.press('Escape');
      await human.waitForFunction(() => !document.querySelector('[role="dialog"]'));
      phase = 'escape';
      await human.click(`${card} button[title="Edit"]`);
      await human.waitForSelector(bodyField, { visible: true });
      await human.focus(bodyField);
      await human.keyboard.press('Escape');
      await human.waitForFunction((selector) => !document.querySelector(selector), {}, bodyField);
      check(`${tag} editor Escape leaves popup open`, (await human.$(dialog)) !== null);
      await human.keyboard.press('Escape');
      await human.waitForFunction(() => !document.querySelector('[role="dialog"]'));
      check(`${tag} second Escape closes popup`, true);
      phase = 'nested';
      const [pinned] = await Promise.all([
        patchResponse(),
        human.click(`${card} button[title="Pin to the top"]`),
      ]);
      check(
        `${tag} nested pin keeps its own action`,
        pinned.status() === 200 && (await human.$(dialog)) === null,
      );
      // The PATCH answering is not the board settling: the card repaints, moved to
      // the top, from the refetch that follows it. Drag only from the settled board.
      await human.waitForSelector(`${card} button[title="Unpin"]`);
      if (width === 1280) {
        phase = 'drag';
        const source = must(await human.$(bodySelector));
        const destination = must(await human.$('.board-column'));
        const deadline = Date.now() + PATIENCE_MS;
        try {
          await source.scrollIntoView();
          const sourceReady = await source.evaluate((node) => {
            const point = node.getBoundingClientRect();
            const hit = document.elementFromPoint(
              point.left + point.width / 2,
              point.top + point.height / 2,
            );
            return (
              hit !== null &&
              node.contains(hit) &&
              hit.closest('a,button,input,textarea,select') === null
            );
          });
          check(`${tag} native drag starts on noninteractive card body`, sourceReady);
          const response = human.waitForResponse(
            (reply) =>
              reply.request().method() === 'PATCH' &&
              new URL(reply.url()).pathname === `/api/blips/${blip.id}`,
            { timeout: Math.max(1, deadline - Date.now()) },
          );
          const gesture = new Promise<void>((resolve, reject) => {
            const timer = setTimeout(
              () => {
                void human.close().then(
                  () => reject(new Error('Native board drag exceeded its deadline')),
                  () => reject(new Error('Native board drag cleanup failed')),
                );
              },
              Math.max(1, deadline - Date.now()),
            );
            void destination.drop(source).then(
              () => {
                clearTimeout(timer);
                resolve();
              },
              () => {
                clearTimeout(timer);
                reject(new Error('Native board drop failed'));
              },
            );
          });
          const [moved] = await Promise.all([response, gesture]);
          check(
            `${tag} native drag moves card without popup`,
            moved.status() === 200 && (await human.$(dialog)) === null,
          );
          await human.waitForFunction(
            (id, expected) =>
              document
                .querySelector(`.board-card [data-blip-id="${id}"] button[id="state-${id}"]`)
                ?.getAttribute('data-value') === expected,
            { timeout: Math.max(1, deadline - Date.now()) },
            blip.id,
            initialStatus,
          );
          check(
            `${tag} service persists native drag destination`,
            (await call<{ blip: BlipDto }>(`/api/blips/${blip.id}`)).blip.status === initialStatus,
          );
        } finally {
          await Promise.all([source.dispose(), destination.dispose()]);
        }
        // This is the next normal pointer gesture, not a new route or editor button.
        await human.click(bodySelector);
        await human.waitForSelector(`${dialog} .comment`, { visible: true });
        check(`${tag} immediate plain click after drag opens details`, true);
        await human.screenshot({
          path: `${outDir}/${prefix}-${width}-after-drag.png`,
          fullPage: false,
        });
        await human.click(`${dialog} button[aria-label="Close"]`);
        await human.waitForFunction(() => !document.querySelector('[role="dialog"]'));
      }
      if (width === 390 && template === 'helpdesk') {
        // The phone paints one lane. A native drop back into that lane must not
        // mutate the request or turn its trailing click into an opener.
        phase = 'drag';
        const source = must(await human.$(bodySelector));
        const destination = must(await human.$('.board-column'));
        const deadline = Date.now() + PATIENCE_MS;
        try {
          await source.scrollIntoView();
          await source.evaluate((node, id) => {
            const card = node.closest('.board-card');
            if (card)
              card.addEventListener(
                'dragstart',
                (event) => {
                  if (event instanceof DragEvent)
                    card.setAttribute(
                      'data-native-drag-start',
                      String(
                        event.isTrusted &&
                          event.target instanceof Node &&
                          card.contains(event.target),
                      ),
                    );
                },
                { once: true },
              );
            const lane = node.closest('.board-column');
            if (lane)
              lane.addEventListener(
                'drop',
                (event) => {
                  if (event instanceof DragEvent)
                    lane.setAttribute(
                      'data-native-drop',
                      String(event.isTrusted && event.dataTransfer?.getData('text/plain') === id),
                    );
                },
                { once: true },
              );
          }, blip.id);
          const gesture = new Promise<void>((resolve, reject) => {
            const timer = setTimeout(
              () => {
                void human.close().then(
                  () => reject(new Error('Native board drag exceeded its deadline')),
                  () => reject(new Error('Native board drag cleanup failed')),
                );
              },
              Math.max(1, deadline - Date.now()),
            );
            void destination.drop(source).then(
              () => {
                clearTimeout(timer);
                resolve();
              },
              () => {
                clearTimeout(timer);
                reject(new Error('Native board drop failed'));
              },
            );
          });
          await gesture;
          check(
            `${tag} real same-lane drag owns its native events without opening details`,
            await human.$eval(
              card,
              (node) =>
                node.closest('.board-card')?.getAttribute('data-native-drag-start') === 'true' &&
                node.closest('.board-column')?.getAttribute('data-native-drop') === 'true' &&
                !document.querySelector('[role="dialog"]'),
            ),
          );
          check(
            `${tag} same-lane drag preserves stored destination`,
            (await call<{ blip: BlipDto }>(`/api/blips/${blip.id}`)).blip.status === movedStatus,
          );
        } finally {
          await Promise.all([source.dispose(), destination.dispose()]);
        }
        await human.click(bodySelector);
        await human.waitForSelector(`${dialog} .comment`, { visible: true });
        check(`${tag} next plain phone click after drag opens details`, true);
        await human.click(`${dialog} button[aria-label="Close"]`);
        await human.waitForFunction(() => !document.querySelector('[role="dialog"]'));
      }
      phase = 'notification';
      // Exact existing notification/deep-link route; no claim a notification was clicked.
      await human.goto(`${seeded.baseUrl}/radar/${radar.id}?blip=${blip.id}`, {
        waitUntil: 'networkidle2',
      });
      await human.waitForSelector(`${dialog} .comment`, { visible: true });
      check(
        `${tag} freshly authorized linked popup shows its current title once`,
        await human.$eval(
          dialog,
          (node, expectedTitle) =>
            node.querySelector('.modal-head h2')?.textContent === expectedTitle &&
            !node
              .querySelector('.kanban-detail .reading-body')
              ?.textContent.includes(expectedTitle),
          changedTitle,
        ),
      );
      const linkedGeometry = await geometry(human);
      check(
        `${tag} notification target uses wide full-body details`,
        linkedGeometry.panelContained &&
          !linkedGeometry.overflow &&
          linkedGeometry.scrollBody &&
          (width === 390 ? linkedGeometry.panelWidth >= 388 : linkedGeometry.panelWidth >= 900) &&
          (await human.$eval(dialog, (node, marker) => node.textContent.includes(marker), ending)),
        linkedGeometry,
      );
      await human.screenshot({
        path: `${outDir}/${prefix}-${width}-notification.png`,
        fullPage: false,
      });
      await human.click(`${dialog} button[title="Edit"]`);
      await human.waitForSelector(bodyField, { visible: true });
      check(
        `${tag} notification editor keeps full draft and comments`,
        (await human.$eval(
          bodyField,
          (node, marker) => node instanceof HTMLTextAreaElement && node.value.includes(marker),
          ending,
        )) && (await geometry(human)).comments >= 1,
      );
      await human.focus(bodyField);
      await human.keyboard.press('Escape');
      await human.waitForFunction((selector) => !document.querySelector(selector), {}, bodyField);
      await human.keyboard.press('Escape');
      await human.waitForFunction(() => !document.querySelector('[role="dialog"]'));
      phase = 'delete';
      for (const mode of ['read', 'edit', 'linked'] as const) {
        const { blip: disposable } = await call<{ blip: BlipDto }>(
          `/api/radars/${radar.id}/blips`,
          'POST',
          {
            title: `Disposable delete ${mode} ${width}`,
            body: 'Synthetic disposable deletion fixture only.',
            status: movedStatus,
          },
        );
        await human.goto(
          `${seeded.baseUrl}/radar/${radar.id}${mode === 'linked' ? `?blip=${disposable.id}` : ''}`,
          { waitUntil: 'networkidle2' },
        );
        if (mode !== 'linked') {
          if (width === 390) await nativeButton(human, movedLabel, '.board-pager');
          await human.click(
            `.board-card [data-blip-id="${disposable.id}"] ${mode === 'edit' ? 'button[title="Edit"]' : '[data-open-blip]'}`,
          );
        }
        await human.waitForSelector(`${dialog} .kanban-detail`, { visible: true });
        const parent = `${dialog}[aria-label="Disposable delete ${mode} ${width}"]`;
        await human.click(`${parent} button[title="Delete"]`);
        const confirmation = '[role="dialog"][aria-label="Delete this blip?"]';
        await human.waitForSelector(confirmation, { visible: true });
        if (mode === 'read') {
          await nativeButton(human, 'Cancel', confirmation);
          await human.waitForFunction(
            () => document.querySelectorAll('[role="dialog"]').length === 1,
          );
          check(
            `${tag} cancelled deletion keeps the same read popup`,
            await human.$eval(parent, (node) => node.isConnected),
          );
          await human.click(`${parent} button[title="Delete"]`);
          await human.waitForSelector(confirmation, { visible: true });
        }
        const confirmButton = must(await human.$(`${confirmation} .btn-danger`));
        try {
          const [removed] = await Promise.all([
            human.waitForResponse(
              (response) =>
                response.request().method() === 'DELETE' &&
                new URL(response.url()).pathname === `/api/blips/${disposable.id}`,
            ),
            confirmButton.click(),
          ]);
          check(
            `${tag} disposable ${mode} deletion reaches the real service`,
            removed.status() === 204,
            { status: removed.status() },
          );
        } finally {
          await confirmButton.dispose();
        }
        await human.waitForFunction(() => !document.querySelector('[role="dialog"]'));
        await human.waitForFunction(
          (id) => !document.querySelector(`.board-card [data-blip-id="${id}"]`),
          {},
          disposable.id,
        );
        await human.waitForFunction(
          () =>
            document.activeElement !== document.body &&
            Boolean(document.activeElement?.isConnected),
        );
        check(
          `${tag} own ${mode} deletion closes popup and returns to board`,
          await human.evaluate(
            () =>
              Boolean(document.querySelector('.board-column')) &&
              !document.querySelector('[role="dialog"]') &&
              document.activeElement !== document.body &&
              Boolean(document.activeElement?.isConnected),
          ),
        );
      }
      await human.screenshot({
        path: `${outDir}/${prefix}-${width}-deleted.png`,
        fullPage: false,
      });
      phase = 'viewer';
      const email = `${template}-popup-viewer-${width}@example.test`;
      const viewerCookie = await viewerLogin(seeded.baseUrl, email);
      await call(`/api/radars/${radar.id}/members`, 'POST', { email, role: 'viewer' });
      await context.setCookie({
        name: 'omr_session',
        value: viewerCookie.slice('omr_session='.length),
        domain: new URL(seeded.baseUrl).hostname,
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
      });
      await human.goto(`${seeded.baseUrl}/radar/${radar.id}`, { waitUntil: 'networkidle2' });
      if (width === 390) await nativeButton(human, movedLabel, '.board-pager');
      await human.waitForSelector(opener, { visible: true });
      await human.click(opener);
      await human.waitForSelector(`${dialog} .comment`, { visible: true });
      const readOnly = await human.evaluate(() => ({
        edit: document.querySelector('[role="dialog"] button[title="Edit"]') !== null,
        lane: document.querySelector('[role="dialog"] .select-trigger') !== null,
        editor: document.querySelector('[role="dialog"] textarea[id^="body-"]') !== null,
      }));
      check(
        `${tag} viewer can read without edit/lane controls`,
        !readOnly.edit && !readOnly.lane && !readOnly.editor,
        readOnly,
      );
      const forbidden = await fetch(`${seeded.baseUrl}/api/blips/${blip.id}`, {
        method: 'PATCH',
        headers: { cookie: viewerCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ body: 'Forbidden viewer edit' }),
        signal: AbortSignal.timeout(PATIENCE_MS),
      });
      check(`${tag} real service refuses viewer edits`, forbidden.status === 403);
      await human.screenshot({
        path: `${outDir}/${prefix}-${width}-viewer.png`,
        fullPage: false,
      });
      // Expected real400 validation emits a browser console error; every other
      // page exception remains fatal. Do not serialize messages or URLs.
      check(
        `${tag} no unexpected browser or HTTP errors`,
        !errors.includes('page-error') &&
          httpErrors.length === 0 &&
          expectedValidation.length === 1 &&
          errors.filter((error) => error === 'console-error').length <= expectedValidation.length,
        {
          pageErrors: errors.filter((error) => error === 'page-error').length,
          consoleErrors: errors.filter((error) => error === 'console-error').length,
          expectedValidation: expectedValidation.length,
          httpErrorCount: httpErrors.length,
        },
      );
      evidence.push({
        width,
        preview,
        readGeometry,
        editGeometry,
        linkedGeometry,
        validationStatus: 400,
        viewerStatus: forbidden.status,
        completedChecks: checks.length,
      });
    } catch {
      await human
        .screenshot({ path: `${outDir}/${prefix}-${width}-failure.png`, fullPage: false })
        .catch(() => null);
      console.log('[board-popup-failure]', {
        template,
        width,
        phase,
        status: status !== null && status >= 100 && status <= 599 ? status : null,
        completedChecks: checks.length,
      });
      throw new Error('Native synthetic board popup failed; request details withheld');
    } finally {
      await context.close();
    }
  }
  writeFileSync(
    `${outDir}/${prefix}-provenance.json`,
    JSON.stringify(
      {
        sourceSha: process.env['CI_COMMIT_SHA'] ?? null,
        pipelineId: process.env['CI_PIPELINE_ID'] ?? null,
        jobId: process.env['CI_JOB_ID'] ?? null,
        setup:
          'Ordinary scratch owner/viewer sessions and real API/served UI; native gestures, no interception, SQL patch or production data.',
        evidence,
      },
      null,
      2,
    ),
  );
  return {
    checks,
    failures,
    notes: ['Hosted Chromium only; physical Safari/Android acceptance remains separate.'],
  };
}
