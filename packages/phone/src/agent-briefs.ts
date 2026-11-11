/**
 * The Briefs tab, the owner's journey, at 390 (docs/AGENT_REPO.md §V2.16).
 *
 * The UI suite proves the behaviour against a mocked API; this proves a person
 * can do it on a phone against the real one: find the list, read a brief, edit
 * it (counter and save bar in reach), open History and read a diff, meet the
 * conflict sheet when someone saved in between, and reach the delete
 * confirmation — with nothing scrolling sideways and every control big enough
 * to tap. Each step leaves a screenshot in `.out/` named `briefs-*-390`.
 *
 * Slice 2b (§V2.17) adds a brief bound to a repository: bound through the real
 * API (the seeded owner is an administrator), it reads "not checked" from the
 * real server — the suite runs no worker and no GitLab. The states a worker
 * would produce — behind, drift, the mirror's merge request — are answered for
 * one load by request interception over the real response, the way the topics
 * sweep tests a state its seed cannot make.
 */
import type { HTTPRequest, Page } from 'puppeteer-core';
import type { BriefStaleDto, RepoAgentDto } from '@onmyradar/contract';
import type { Seeded } from './seed.js';
import type { Check, SweepResult } from './sweep.js';
import { shot, PHONE, PATIENCE_MS } from './harness.js';

/** The smallest tap target this suite accepts, as the idiom sweep does. */
const TAP = 44;

export async function runAgentBriefs(
  page: Page,
  outDir: string,
  seeded: Seeded,
): Promise<SweepResult> {
  const checks: Check[] = [];
  const failures: string[] = [];
  const check = (name: string, ok: boolean, detail: unknown = null) => {
    checks.push({ name, ok, detail });
    if (!ok) failures.push(name);
  };
  const call = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
    const response = await fetch(seeded.baseUrl + path, {
      method,
      headers: { 'content-type': 'application/json', cookie: seeded.ownerCookie },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok)
      throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
    return (response.status === 204 ? undefined : await response.json()) as T;
  };

  const [cookieName, cookieValue] = seeded.ownerCookie.split('=');
  if (cookieName && cookieValue) {
    await page.browser().setCookie({
      name: cookieName,
      value: cookieValue,
      domain: new URL(seeded.baseUrl).hostname,
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
    });
  }
  const goto = async (path: string) => {
    await page.goto(seeded.baseUrl + path, { waitUntil: 'networkidle0', timeout: PATIENCE_MS });
  };
  const waitFor = (fn: () => boolean) =>
    page.waitForFunction(fn, { timeout: PATIENCE_MS }).then(
      () => true,
      () => false,
    );
  const sideways = () =>
    page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  const visibleText = (text: string) =>
    page.evaluate((t: string) => document.body.innerText.includes(t), text);
  /** Painted buttons inside `scope` smaller than a fingertip, by label and size. */
  const tooSmall = (scope: string) =>
    page.evaluate(
      (selector: string, min: number) =>
        [...document.querySelectorAll<HTMLElement>(`${selector} button, ${selector} a.btn`)]
          .filter((b) => b.getClientRects().length > 0)
          .map((b) => {
            const r = b.getBoundingClientRect();
            return {
              label: (b.textContent.trim() || b.getAttribute('aria-label')) ?? '?',
              w: Math.round(r.width),
              h: Math.round(r.height),
            };
          })
          .filter((b) => b.w < min || b.h < min),
      scope,
      TAP,
    );
  const clickButton = (label: string, scope = 'body') =>
    page.evaluate(
      (text: string, selector: string) => {
        const button = [...document.querySelectorAll<HTMLElement>(`${selector} button`)].find(
          (b) =>
            b.getClientRects().length > 0 &&
            ((b.textContent.trim() || b.getAttribute('aria-label')) ?? '').startsWith(text),
        );
        button?.click();
        return Boolean(button);
      },
      label,
      scope,
    );
  /**
   * A sheet fades in over 220 ms (`.ping-in`); a picture taken before that ends
   * shows it half transparent, as if under the scrim. Wait for every animation
   * in it to finish, then prove it is fully opaque and that its head and foot
   * controls are what a tap at their centre would hit — paint order, not
   * geometry (`getBoundingClientRect` passes while something paints over it).
   */
  const sheetOnTop = (scope: string) =>
    page.evaluate(async (selector: string) => {
      const sheet = document.querySelector<HTMLElement>(selector);
      if (!sheet) return { found: false, opacity: '', buried: [] as string[] };
      await Promise.all(
        sheet.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => undefined)),
      );
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
      const buried = [
        ...sheet.querySelectorAll<HTMLElement>('.modal-head button, .modal-foot button'),
      ]
        .filter((button) => button.getClientRects().length > 0)
        .filter((button) => {
          const r = button.getBoundingClientRect();
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return !hit || !button.contains(hit);
        })
        .map((button) => (button.textContent.trim() || button.getAttribute('aria-label')) ?? '?');
      return { found: true, opacity: getComputedStyle(sheet).opacity, buried };
    }, scope);
  /** The same four questions at every step, then the picture. */
  const step = async (name: string, scope: string) => {
    if (scope === '.modal-panel') {
      const sheet = await sheetOnTop(scope);
      check(
        `briefs 390 ${name}: the sheet has finished arriving, fully opaque and on top`,
        sheet.found && sheet.opacity === '1' && sheet.buried.length === 0,
        sheet,
      );
    }
    check(`briefs 390 ${name}: does not scroll sideways`, !(await sideways()));
    const small = await tooSmall(scope);
    check(`briefs 390 ${name}: every control is big enough to tap`, small.length === 0, small);
    await shot(page, outDir, `briefs-${name}-390`);
  };

  /* ---- seed: one agent with two briefs, one of them revised ---- */
  const { agent } = await call<{ agent: RepoAgentDto }>('/api/repo-agents', 'POST', {
    name: 'Brief keeper',
    prompt: 'You keep the facts.',
  });
  const facts = [
    '# Commander',
    '',
    'The project-lifecycle control plane.',
    '',
    '## Deploy',
    '',
    'Every change is a run of idempotent steps: check, execute, verify, compensate.',
    '',
    '| Step | What it proves |',
    '| --- | --- |',
    '| check | the precondition holds |',
    '| verify | the effect is visible |',
    '',
  ].join('\n');
  await call(`/api/repo-agents/${agent.id}/briefs/commander`, 'PUT', {
    description: 'Commander: how to run, test and deploy it',
    body: facts,
    note: 'first cut',
  });
  await call(`/api/repo-agents/${agent.id}/briefs/commander`, 'PUT', {
    body: facts.replace('control plane.', 'control plane for Roving Studio sites.'),
    expectedRevision: 1,
    note: 'say what it controls',
  });
  await call(`/api/repo-agents/${agent.id}/briefs/site-delivery`, 'PUT', {
    description: 'How a customer site ships, from branch to live',
    body: '# Site delivery\n\n1. Branch per blip.\n2. Review.\n3. Merge.\n',
  });

  await page.setViewport(PHONE);

  /* ---- the list ---- */
  await goto(`/repo/${agent.id}/briefs`);
  await waitFor(() => document.querySelectorAll('.memory-row').length === 2);
  check(
    'briefs 390 list: both briefs listed with what each covers',
    (await visibleText('commander')) &&
      (await visibleText('How a customer site ships, from branch to live')),
  );
  check(
    'briefs 390 list: the list stands alone — no brief opened behind it',
    (await page.$('article.md-doc')) === null,
  );
  await step('list', '.briefs-tab');

  /* ---- reading one ---- */
  await clickButton('commander', '.briefs-index');
  check(
    'briefs 390 view: the brief reads as a document',
    await waitFor(() => document.querySelector('article.md-doc table') !== null),
  );
  check('briefs 390 view: the list gives way, with a way back', await visibleText('All briefs'));
  check('briefs 390 view: who wrote it, and why', await visibleText('“say what it controls”'));
  await step('view', '.brief-view');

  /* ---- History and a diff ---- */
  await clickButton('History', '.brief-view');
  check(
    'briefs 390 history: the drawer shows what r2 changed',
    await waitFor(() => document.querySelector('.modal-panel .prompt-diff') !== null),
  );
  await step('history', '.modal-panel');
  await clickButton('r1', '.history-list');
  check(
    'briefs 390 history: the address follows the revision chosen',
    new URL(page.url()).searchParams.get('history') === '1',
    page.url(),
  );
  await page.keyboard.press('Escape');
  await waitFor(() => document.querySelector('.modal-panel') === null);

  /* ---- editing: counter and save bar in reach ---- */
  await goto(`/repo/${agent.id}/briefs?b=commander`);
  await waitFor(() => document.querySelector('article.md-doc') !== null);
  await clickButton('Edit', '.brief-view');
  check(
    'briefs 390 edit: the editor opens',
    await waitFor(() => document.querySelector('.md-rich [contenteditable]') !== null),
  );
  check(
    'briefs 390 edit: the byte counter reads against the cap',
    / of 16 KB$/.test(await page.$eval('.brief-size', (e) => e.textContent).catch(() => '')),
  );
  await step('edit', '.brief-editor');

  /* ---- the conflict sheet: someone saves in between ---- */
  await clickButton('View Markdown', '.brief-editor');
  await page.waitForSelector('textarea.md-source', { timeout: PATIENCE_MS });
  await page.$eval('textarea.md-source', (area) => {
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
  });
  await page.keyboard.type('Mine: run the whole gate.\n');
  await call(`/api/repo-agents/${agent.id}/briefs/commander`, 'PUT', {
    body: `${facts}\nTheirs: run the gate twice.\n`,
    expectedRevision: 2,
    note: 'from another tab',
  });
  await clickButton('Save as r3', '.md-savebar');
  check(
    'briefs 390 conflict: the sheet says it changed in another tab — the owner’s own save',
    await waitFor(() =>
      document.body.innerText.includes('This brief changed in another tab or window'),
    ),
  );
  check(
    'briefs 390 conflict: what they changed reads as words, not Markdown marks',
    !(
      await page.$eval('.modal-panel .prompt-diff', (e) => e.textContent).catch(() => '|')
    ).includes('|'),
  );
  await step('conflict', '.modal-panel');
  await clickButton('Keep editing', '.modal-panel');
  await waitFor(() => document.querySelector('.modal-panel') === null);
  // Leave the edit the way a person would: an unsaved edit guards the page
  // (beforeunload too), so a bare navigation would stall on the prompt.
  await clickButton('Cancel', '.md-savebar');
  await waitFor(() => document.body.innerText.includes('Discard your changes?'));
  await clickButton('Discard', '.modal-panel');
  await waitFor(() => document.querySelector('.brief-editor') === null);

  /* ---- bound to a repository (slice 2b) ---- */
  await call(`/api/repo-agents/${agent.id}/briefs/commander/binding`, 'PUT', {
    project: 'lucas/on-my-radar',
    path: 'docs/AGENT-BRIEF.md',
    ref: 'main',
    mirror: true,
  });
  await goto(`/repo/${agent.id}/briefs?b=commander`);
  await waitFor(() => document.querySelector('.brief-repo') !== null);
  check(
    'briefs 390 repo: a bound brief the server has not checked says so, with why',
    (await visibleText('not checked against lucas/on-my-radar')) &&
      (await visibleText('Not checked yet.')),
  );
  check(
    'briefs 390 repo: the mirror says it is off on this server — never an error',
    await visibleText('mirror: off on this server'),
  );
  await step('repo-not-checked', '.brief-view');

  // What the worker would have found: three commits, a hand edit, an open request.
  const found: BriefStaleDto = {
    repo: {
      project: 'lucas/on-my-radar',
      path: 'docs/AGENT-BRIEF.md',
      ref: 'main',
      mirror: true,
      url: 'https://gitlab.example.test/lucas/on-my-radar/-/blob/main/docs/AGENT-BRIEF.md',
    },
    state: 'behind',
    commitsBehind: 3,
    capped: false,
    revision: 3,
    checkedAt: new Date().toISOString(),
    reason: null,
    drift: {
      kind: 'edited',
      commit: 'abc1234',
      title: 'Tweak the deploy steps by hand',
      at: new Date().toISOString(),
      url: 'https://gitlab.example.test/lucas/on-my-radar/-/commit/abc1234',
    },
    mirror: {
      state: 'opened',
      revision: 3,
      mergeRequestUrl: 'https://gitlab.example.test/lucas/on-my-radar/-/merge_requests/7',
      reason: null,
    },
  };
  const briefsPath = `/api/repo-agents/${agent.id}/briefs`;
  const answer = (request: HTTPRequest) => {
    const url = new URL(request.url());
    const isList = url.pathname === briefsPath;
    const isOne = url.pathname === `${briefsPath}/commander`;
    if (request.method() !== 'GET' || (!isList && !isOne)) {
      void request.continue();
      return;
    }
    void call<Record<string, unknown>>(url.pathname + url.search).then(
      (body) => {
        const patch = (b: Record<string, unknown>) =>
          b['name'] === 'commander' ? { ...b, stale: found } : b;
        const patched = isList
          ? { briefs: (body['briefs'] as Array<Record<string, unknown>>).map(patch) }
          : { brief: patch(body['brief'] as Record<string, unknown>) };
        void request.respond({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(patched),
        });
      },
      () => void request.continue(),
    );
  };
  await page.setRequestInterception(true);
  page.on('request', answer);
  try {
    await goto(`/repo/${agent.id}/briefs`);
    await waitFor(() => document.querySelector('.brief-repo-chip') !== null);
    check(
      'briefs 390 repo list: the bound brief says how far behind, and drift',
      (await visibleText('3 commits behind')) && (await visibleText('drift')),
    );
    await step('repo-list', '.briefs-tab');

    await clickButton('commander', '.briefs-index');
    // The readout comes from the list; wait for the brief itself too, so the
    // picture has its byline and document.
    await waitFor(
      () =>
        document.querySelector('.brief-drift') !== null &&
        document.querySelector('article.md-doc') !== null,
    );
    check(
      'briefs 390 repo: "3 commits behind lucas/on-my-radar since r3", linked to the path',
      (await visibleText('3 commits behind lucas/on-my-radar since r3')) &&
        (await page.$('.brief-repo a[href*="docs/AGENT-BRIEF.md"]')) !== null,
    );
    check(
      'briefs 390 repo: drift says the edit stays in the repository and is not imported',
      (await visibleText('Drift: edited in repo.')) && (await visibleText('is not imported')),
    );
    check(
      'briefs 390 repo: the mirror names its merge request',
      await visibleText('mirror: merge request open for r3'),
    );
    const change = await page.evaluate(() => {
      const face = (el: Element | null | undefined) => {
        if (!el) return null;
        const cs = getComputedStyle(el);
        return {
          border: cs.borderTopWidth,
          background: cs.backgroundColor,
          radius: cs.borderTopLeftRadius,
        };
      };
      const buttons = [...document.querySelectorAll<HTMLElement>('.brief-view button')];
      const changeButton = buttons.find((b) => b.textContent.trim() === 'Change…');
      const history = buttons.find((b) => b.textContent.trim() === 'History');
      return {
        change: face(changeButton),
        history: face(history),
        height: changeButton ? Math.round(changeButton.getBoundingClientRect().height) : 0,
      };
    });
    check(
      'briefs 390 repo: Change… is a button with the face of History, at least 44px tall',
      change.change !== null &&
        JSON.stringify(change.change) === JSON.stringify(change.history) &&
        change.height >= TAP,
      change,
    );
    await step('repo-behind', '.brief-view');

    /* the binding dialog, from the readout */
    await clickButton('Change…', '.brief-repo');
    check(
      'briefs 390 repo bind: the dialog opens on the current binding',
      await waitFor(
        () =>
          document.querySelector<HTMLInputElement>('#binding-project')?.value ===
          'lucas/on-my-radar',
      ),
    );
    check(
      'briefs 390 repo bind: the mirror is explained — a merge request, never a push',
      await visibleText('Nothing is pushed straight to main'),
    );
    check(
      'briefs 390 repo bind: unbinding says what it does',
      await visibleText('Stop checking the repository'),
    );
    await step('repo-bind', '.modal-panel');
    await page.keyboard.press('Escape');
    await waitFor(() => document.querySelector('.modal-panel') === null);
  } finally {
    page.off('request', answer);
    await page.setRequestInterception(false);
  }

  /* ---- the delete confirmation ---- */
  await goto(`/repo/${agent.id}/briefs?b=site-delivery`);
  await waitFor(() => document.querySelector('article.md-doc') !== null);
  await clickButton('More actions for site-delivery', '.brief-view');
  await waitFor(() => document.querySelector('.modal-panel') !== null);
  await clickButton('Delete…', '.modal-panel');
  check(
    'briefs 390 delete: it says it goes for everyone, and wants the name typed back',
    (await waitFor(() =>
      document.body.innerText.includes('It goes for everyone this agent is shared with'),
    )) && (await visibleText('to confirm')),
  );
  check(
    'briefs 390 delete: Delete stays off until the name is typed',
    await page.evaluate(
      () =>
        [...document.querySelectorAll<HTMLButtonElement>('.modal-panel button')].find(
          (b) => b.textContent.trim() === 'Delete brief',
        )?.disabled === true,
    ),
  );
  await step('delete', '.modal-panel');
  return { checks, failures, notes: [] };
}
