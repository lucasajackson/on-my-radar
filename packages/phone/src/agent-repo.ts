/**
 * The Agent Repo (v2), at 390 and at 1440.
 *
 * The server suites prove the rules. What only a browser proves is that a
 * person can find the thing (present at zero, in the rail and on the phone's
 * Radars screen), that an agent's own prompt edit is visibly live and says who
 * made it and in which tool, that the memory browser says who wrote what, that
 * Use in… renders a real checkout, and that none of it scrolls sideways.
 *
 * The agent side is seeded the way an agent would do it: a personal access
 * token, `load_agent` for a session, memories written inside it, and a prompt
 * edit — which in v2 is live at once (docs/AGENT_REPO.md §V2.3).
 */
import type { HTTPRequest, Page } from 'puppeteer-core';
import pg from 'pg';
import type {
  AgentSessionDto,
  AgentSessionInventoryDto,
  McpAvailabilityDto,
  RepoAgentDto,
  ProfileDto,
  CheckoutResult,
} from '@onmyradar/contract';
import type { Seeded } from './seed.js';
import { scratchDatabase } from './database.js';
import type { Check, SweepResult } from './sweep.js';
import { shot, PHONE, PATIENCE_MS } from './harness.js';

const DESKTOP = {
  width: 1440,
  height: 900,
  deviceScaleFactor: 1,
  isMobile: false,
  hasTouch: false,
};

export async function runAgentRepo(
  page: Page,
  outDir: string,
  seeded: Seeded,
  databaseUrl: string,
): Promise<SweepResult> {
  const checks: Check[] = [];
  const failures: string[] = [];
  const check = (name: string, ok: boolean, detail: unknown = null) => {
    checks.push({ name, ok, detail });
    if (!ok) failures.push(name);
  };
  const call = async <T>(
    path: string,
    method = 'GET',
    body?: unknown,
    bearer?: string,
  ): Promise<T> => {
    const response = await fetch(seeded.baseUrl + path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(bearer ? { authorization: `Bearer ${bearer}` } : { cookie: seeded.ownerCookie }),
      },
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
  const sideways = () =>
    page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  // `innerText` is rendered text only — a hidden desktop sidebar or a
  // display:none branch does not count — and unlike a leaf-node match it sees
  // a sentence that shares its element with a styled child.
  const visibleText = (text: string) =>
    page.evaluate((t: string) => document.body.innerText.includes(t), text);
  const clickAction = async (label: string) => {
    for (const element of await page.$$('button,a,summary')) {
      if (await element.evaluate((item, text) => item.textContent.trim() === text, label)) {
        await element.scrollIntoView();
        await element.click();
        return;
      }
    }
    throw new Error(`Agent setup action missing: ${label}`);
  };
  const setupGeometry = async (where: string, selector: string, minimumCount: number) => {
    const geometry = await page.evaluate((targets) => {
      const modal = document.querySelector<HTMLElement>('[role="dialog"]');
      const body = modal?.querySelector<HTMLElement>('.modal-body');
      const bounds = modal?.getBoundingClientRect();
      const controls = [...document.querySelectorAll<HTMLElement>(targets)]
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            label: element.getAttribute('aria-label') ?? element.textContent.trim(),
            width: rect.width,
            height: rect.height,
            left: rect.left,
            right: rect.right,
          };
        })
        .filter((rect) => rect.width > 0 && rect.height > 0);
      return {
        controls,
        count: controls.length,
        left: Math.max(0, bounds?.left ?? 0),
        right: Math.min(window.innerWidth, bounds?.right ?? window.innerWidth),
        documentOverflow: document.documentElement.scrollWidth - window.innerWidth,
        modalOverflow: body ? body.scrollWidth - body.clientWidth : 0,
      };
    }, selector);
    check(
      `${where}: rendered setup controls have 44px targets and fit horizontally`,
      geometry.count >= minimumCount &&
        geometry.documentOverflow <= 1 &&
        geometry.modalOverflow <= 1 &&
        geometry.controls.every(
          (control) =>
            control.width >= 44 &&
            control.height >= 44 &&
            control.left >= geometry.left - 1 &&
            control.right <= geometry.right + 1,
        ),
      geometry,
    );
  };
  const dialogControls =
    '[role="dialog"] [aria-label="Tool"], [role="dialog"] .onboard-pill, ' +
    '[role="dialog"] .snippet-copy, [role="dialog"] summary.min-h-11, ' +
    '[role="dialog"] a[href*="profile="], [aria-label="AI connection availability"] a, ' +
    '[aria-label="Step 3: Verify the connection"] button';

  /**
   * Automatic setup inside the selected-tool journey: inside the viewport, the
   * topmost thing at its own centre (so a tap lands on it), and a tap copies
   * the exact sentence — with the agent id on an agent page.
   */
  const ONBOARD = `Fetch and execute the appropriate instructions to set me up for On My Radar from ${seeded.baseUrl}/agent-setup/prompt.md`;
  const onboardPill = async (where: string, expected: string) => {
    await page.$eval('.onboard-pill', (element) => element.scrollIntoView({ block: 'center' }));
    const box = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('.onboard-pill');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const points = [
        [r.left + r.width / 2, r.top + r.height / 2],
        [r.left + 6, r.top + r.height / 2],
        [r.right - 6, r.top + r.height / 2],
      ];
      return {
        right: r.right,
        height: r.height,
        width: window.innerWidth,
        topmost: points.every(([x, y]) => {
          const hit = document.elementFromPoint(x ?? 0, y ?? 0);
          return hit !== null && el.contains(hit);
        }),
      };
    });
    check(`${where}: the automatic setup copy action is there`, box !== null, box);
    if (!box) return;
    check(`${where}: the pill fits the viewport`, box.right <= box.width + 0.5, box);
    check(`${where}: the pill is what a tap at its centre and edges hits`, box.topmost, box);
    await page.evaluate(() => {
      const w = window as unknown as { __copied?: string };
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: (text: string) => {
            w.__copied = text;
            return Promise.resolve();
          },
        },
      });
    });
    await page.click('.onboard-pill');
    const copied = await page.evaluate(
      () => (window as unknown as { __copied?: string }).__copied ?? null,
    );
    check(`${where}: a tap copies the setup sentence`, copied === expected, copied);
    check(`${where}: the pill says it copied`, await visibleText('Copied'));
  };

  /* ---- zero state first: the repo must be findable before anything exists ---- */
  await page.setViewport(PHONE);
  await goto('/radars');
  check('agents: the phone Radars screen links to the Agent Repo', await visibleText('Agents'));
  await goto('/repo');
  check('agents: the empty repo draws what an agent is', await visibleText('Define it here'));
  await shot(page, outDir, 'agents-empty-390');

  // Real owner editor and served services; only the historical invalid row is
  // injected into the harness-owned disposable database. No request mocking.
  for (const width of [390, 1280]) {
    await page.setViewport(width === 390 ? PHONE : { ...DESKTOP, width });
    const { agent: fixture } = await call<{ agent: RepoAgentDto }>(
      '/api/repo-agents/import',
      'POST',
      {
        name: `Profile validation ${width}`,
        slug: `profile-validation-${width}`,
        prompt: 'Synthetic hosted profile editor fixture.',
        primaryHarness: 'claude-code',
        profiles: { 'claude-code': { tools: 'Read' } },
      },
    );
    const progress: {
      phase:
        | 'read-profile'
        | 'navigation'
        | 'editor-input'
        | 'edit-input'
        | 'native-save'
        | 'put-response'
        | 'saved-toast'
        | 'invalid-alert'
        | 'capture'
        | 'checkout'
        | 'legacy-fixture';
      operation: 'invalid' | 'valid' | 'blank' | 'repair';
      responseStatus: number | null;
    } = { phase: 'navigation', operation: 'invalid', responseStatus: null };
    try {
      const profilesPath = `/api/repo-agents/${fixture.id}/profiles`;
      const readProfile = async () => {
        progress.phase = 'read-profile';
        const { profiles } = await call<{ profiles: ProfileDto[] }>(profilesPath);
        const profile = profiles.find((entry) => entry.harness === 'claude-code');
        if (!profile) throw new Error('Synthetic Claude profile missing');
        return profile;
      };
      const toolsInput = 'input[aria-labelledby="profile-field-tools"]';
      const openEditor = async () => {
        progress.phase = 'navigation';
        await goto(`/repo/${fixture.id}/tools?profile=claude-code`);
        progress.phase = 'editor-input';
        await page.waitForSelector(toolsInput, { timeout: PATIENCE_MS });
      };
      const enterTools = async (text: string) => {
        progress.phase = 'edit-input';
        const input = await page.$(toolsInput);
        if (!input) throw new Error('Native Tools input missing');
        await input.scrollIntoView();
        await input.click({ clickCount: 3 });
        await page.keyboard.press('Backspace');
        if (text) await input.type(text);
      };
      const clickProfileSave = async () => {
        progress.phase = 'native-save';
        await page.evaluate((selector) => {
          const card = document.querySelector(selector)?.closest<HTMLElement>('.profile-card');
          const save =
            card &&
            [...card.querySelectorAll<HTMLButtonElement>('button')].find(
              (button) => button.textContent.trim() === 'Save',
            );
          if (!card || !save) throw new Error('Synthetic profile Save missing');
          card.dataset['profilePointerSeen'] = 'false';
          card.dataset['profilePointerOwned'] = 'false';
          card.dataset['profilePointerTrusted'] = 'false';
          document.addEventListener(
            'pointerdown',
            (event) => {
              card.dataset['profilePointerSeen'] = 'true';
              card.dataset['profilePointerOwned'] = String(
                event.target instanceof Node && save.contains(event.target),
              );
              card.dataset['profilePointerTrusted'] = String(event.isTrusted);
            },
            { once: true, capture: true, passive: true },
          );
        }, toolsInput);
        await clickAction('Save');
      };
      const saveTools = async (text: string) => {
        await enterTools(text);
        const saved = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === `${profilesPath}/claude-code` &&
            response.request().method() === 'PUT',
          { timeout: PATIENCE_MS },
        );
        // Attach rejection handling at registration; the original awaited wait still fails.
        void saved.catch(() => undefined);
        progress.responseStatus = null;
        await clickProfileSave();
        progress.phase = 'put-response';
        const response = await saved;
        progress.responseStatus = response.status();
        check(
          `profile ${width}: native save accepted ${text || 'blank inheritance'}`,
          response.ok(),
        );
        progress.phase = 'saved-toast';
        await page.waitForFunction(() => document.body.innerText.includes('Profile saved'), {
          timeout: PATIENCE_MS,
        });
        return readProfile();
      };
      await openEditor();
      const before = await readProfile();
      await enterTools('All tools');
      await clickProfileSave();
      progress.phase = 'invalid-alert';
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll('[role="alert"]')].some((element) =>
            element.textContent.includes('unrecognized tool'),
          ),
        { timeout: PATIENCE_MS },
      );
      const rejected = await readProfile();
      check(
        `profile ${width}: invalid native edit leaves revision and settings unchanged`,
        rejected.revision === before.revision &&
          JSON.stringify(rejected.settings) === JSON.stringify(before.settings),
      );
      progress.phase = 'capture';
      await shot(page, outDir, `profile-invalid-${width}`);
      progress.operation = 'valid';
      const validTools = 'Read, Agent(worker, researcher), Task, mcp__omr__*';
      const valid = await saveTools(validTools);
      check(
        `profile ${width}: Agent Task MCP restrictions persist`,
        valid.revision === before.revision + 1 && valid.settings['tools'] === validTools,
      );
      await openEditor();
      check(
        `profile ${width}: saved restrictions render after reload`,
        (await page.$eval(toolsInput, (element) => element.value)) === validTools,
      );
      progress.operation = 'blank';
      const blank = await saveTools('');
      check(
        `profile ${width}: blank tools inherits without a stored restriction`,
        blank.revision === valid.revision + 1 && blank.settings['tools'] === undefined,
      );
      const checkoutPath = `/api/repo-agents/${fixture.id}/checkout?harness=claude-code&mode=helper`;
      progress.phase = 'checkout';
      const { checkout: inherited } = await call<{ checkout: CheckoutResult }>(checkoutPath);
      check(
        `profile ${width}: inherited helper omits tools frontmatter`,
        inherited.operations.some(
          (operation) =>
            operation.op === 'write' &&
            operation.path === `.claude/agents/${fixture.slug}.md` &&
            !/^tools:/m.test(operation.content),
        ),
      );

      progress.phase = 'legacy-fixture';
      const expectedDatabase = scratchDatabase(new URL(databaseUrl).pathname.slice(1));
      const db = new pg.Pool({ connectionString: databaseUrl, max: 1 });
      try {
        const identity = await db.query<{ name: string }>('SELECT current_database() AS name');
        if (identity.rows[0]?.name !== expectedDatabase)
          throw new Error('Profile fixture database identity mismatch');
        const legacy = await db.query(
          `UPDATE agent_profiles SET settings = jsonb_set(settings, '{tools}', '"All tools"'::jsonb)
         WHERE agent_id = $1 AND harness = 'claude-code' RETURNING agent_id`,
          [fixture.id],
        );
        if (legacy.rowCount !== 1) throw new Error('Synthetic legacy profile setup failed');
      } finally {
        await db.end();
      }
      progress.phase = 'checkout';
      const refused = await fetch(seeded.baseUrl + checkoutPath, {
        headers: { cookie: seeded.ownerCookie },
      });
      check(
        `profile ${width}: stored legacy invalid restriction refuses served checkout`,
        refused.status === 409,
      );
      progress.operation = 'repair';
      await openEditor();
      check(
        `profile ${width}: owner sees legacy value for repair`,
        (await page.$eval(toolsInput, (element) => element.value)) === 'All tools',
      );
      const repaired = await saveTools(validTools);
      check(
        `profile ${width}: owner repair persists`,
        repaired.revision === blank.revision + 1 && repaired.settings['tools'] === validTools,
      );
      progress.phase = 'checkout';
      const { checkout } = await call<{ checkout: CheckoutResult }>(checkoutPath);
      check(
        `profile ${width}: repaired served helper checkout contains the saved restriction`,
        checkout.operations.some(
          (operation) =>
            operation.op === 'write' &&
            operation.path === `.claude/agents/${fixture.slug}.md` &&
            operation.content.includes(`tools: ${JSON.stringify(validTools)}`),
        ),
      );
      check(`profile ${width}: native editor fits horizontally`, !(await sideways()));
      progress.phase = 'capture';
      await shot(page, outDir, `profile-repaired-${width}`);
    } catch (error) {
      const browser = page.browser();
      const ownedProcess = browser.process();
      const pid = ownedProcess?.pid;
      // open() launches this local browser itself. Pinned Puppeteer24.30
      // gives Linux Chrome its own detached process group; never stop a
      // connected browser or an unknown/non-Linux process to collect evidence.
      if (
        !ownedProcess ||
        !pid ||
        process.platform !== 'linux' ||
        ownedProcess.exitCode !== null ||
        ownedProcess.signalCode !== null
      ) {
        process.stdout.write(
          JSON.stringify({ kind: 'profile-diagnostic-unavailable', width, ...progress }) + '\n',
        );
        throw error;
      }
      const lifetime = { stopped: false, expired: false, closed: false, stopFailed: false };
      const closed = new Promise<void>((resolve) => {
        ownedProcess.once('close', () => {
          lifetime.closed = true;
          resolve();
        });
      });
      let disconnected: Promise<void> | undefined;
      const stop = () => {
        if (lifetime.stopped) return;
        lifetime.stopped = true;
        // Release pending CDP promises as well as terminating the owned group.
        disconnected = Promise.resolve().then(() => browser.disconnect());
        void disconnected.catch(() => undefined);
        if (!lifetime.closed) {
          try {
            process.kill(-pid, 'SIGKILL');
          } catch {
            lifetime.stopFailed = true;
            // Fallback is still the directly owned child, never another PID.
            try {
              ownedProcess.kill('SIGKILL');
            } catch {
              /* Join remains required. */
            }
          }
        }
      };
      const deadline = Date.now() + 2000;
      const timer = setTimeout(() => {
        lifetime.expired = true;
        stop();
      }, 2000);
      const currentDiagnostic = () => {
        if (lifetime.stopped || lifetime.expired || Date.now() >= deadline)
          throw new Error('Profile failure diagnostic expired.');
      };
      // Registered before its first dispatch, and joined after stop. There is
      // no race that abandons a screenshot's eventual filesystem write.
      const diagnostic = Promise.resolve().then(async () => {
        currentDiagnostic();
        const sample = await page
          .evaluate(() => {
            const input = document.querySelector<HTMLInputElement>(
              'input[aria-labelledby="profile-field-tools"]',
            );
            const card = input?.closest<HTMLElement>('.profile-card');
            const save =
              card &&
              [...card.querySelectorAll<HTMLButtonElement>('button')].find(
                (button) => button.textContent.trim() === 'Save',
              );
            const rect = save?.getBoundingClientRect();
            const hit =
              rect &&
              document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
            return {
              inputPresent: !!input,
              valueInvalid: input?.value === 'All tools',
              valueValid: input?.value === 'Read, Agent(worker, researcher), Task, mcp__omr__*',
              valueBlank: input?.value === '',
              savePresent: !!save,
              saveDisabled: save?.disabled ?? null,
              saveCenterOwned: !!save && hit instanceof Node && save.contains(hit),
              saveCenterAlert: hit instanceof Element && !!hit.closest('[role="alert"]'),
              pointerProbePresent: card?.dataset['profilePointerSeen'] !== undefined,
              pointerSeen: card?.dataset['profilePointerSeen'] === 'true',
              pointerOwned: card?.dataset['profilePointerOwned'] === 'true',
              pointerTrusted: card?.dataset['profilePointerTrusted'] === 'true',
              invalidAlert: [...document.querySelectorAll('[role="alert"]')].some((alert) =>
                alert.textContent.includes('unrecognized tool'),
              ),
              savedToast: document.body.innerText.includes('Profile saved'),
              saveTop: rect?.top ?? null,
              saveBottom: rect?.bottom ?? null,
              viewportHeight: window.innerHeight,
            };
          })
          .catch(() => null);
        currentDiagnostic();
        process.stdout.write(
          JSON.stringify({ kind: 'profile-caller-failure', width, ...progress, sample }) + '\n',
        );
        // Only the harness-owned synthetic profile page is captured before main closes it.
        currentDiagnostic();
        await shot(page, outDir, `profile-failure-${width}`).catch(() => undefined);
        currentDiagnostic();
      });
      void diagnostic.catch(() => undefined);
      try {
        await diagnostic.catch(() => undefined);
      } finally {
        stop();
        const closing = browser.close();
        void closing.catch(() => undefined);
        await Promise.allSettled([diagnostic, closed, disconnected, closing]);
        clearTimeout(timer);
      }
      process.stdout.write(
        JSON.stringify({
          kind: 'profile-diagnostic-settled',
          width,
          expired: lifetime.expired,
          processClosed: lifetime.closed,
          stopFailed: lifetime.stopFailed,
        }) + '\n',
      );
      throw error;
    }
  }

  /* ---- seed as an agent would ---- */
  const { agent } = await call<{ agent: RepoAgentDto }>('/api/repo-agents/import', 'POST', {
    name: 'Architect',
    slug: 'architect',
    description: 'Architect and maintainer. Use for any structural work.',
    prompt:
      'You are the architect.\n\n## Rules\n\n- Read the design record first.\n- Verify against a real database.',
    primaryHarness: 'claude-code',
    profiles: { 'claude-code': { model: 'opus', effort: 'high' } },
    memories: [
      {
        name: 'agent-boundary',
        type: 'feedback',
        description: 'An agent-facing refusal lives in the service, never in the tool router',
        body: '**Why:** three fences were walkable over REST.\n\n**How to apply:** grep for actor.kind.',
      },
      {
        name: 'harbor-estate',
        type: 'reference',
        description: 'Which Harbor credential really works',
        body: 'The committed admin password is stale.',
      },
    ],
  });
  const { token } = await call<{ token: { token: string } }>('/api/tokens', 'POST', {
    name: 'phone suite agent',
  });
  const pat = token.token;
  const { loaded } = await call<{ loaded: { session: { id: string } } }>(
    `/api/repo-agents/${agent.id}/load`,
    'POST',
    { harness: 'claude-code', workspace: '~/src/example' },
    pat,
  );
  await call(
    `/api/repo-agents/${agent.id}/memories`,
    'POST',
    {
      session: loaded.session.id,
      name: 'keyset-timestamp-precision',
      type: 'project',
      description: 'Never build a cursor from a JS Date — microseconds matter',
      body: 'Postgres keeps microseconds; a JS Date keeps milliseconds. The boundary row repeats or vanishes.',
    },
    pat,
  );
  // The agent's edit to its own prompt waits for the owner (ADR-0029): held, live stays v1.
  const edited = await call<{ proposalId?: string }>(
    `/api/repo-agents/${agent.id}/prompts`,
    'POST',
    {
      body: 'You are the architect.\n\n## Rules\n\n- Read the design record first.\n- Verify against a real database.\n- Take a screenshot of anything user-facing.',
      basedOn: 1,
      note: 'Three real bugs were found by screenshot',
      session: loaded.session.id,
    },
    pat,
  );
  const stillLive = await call<{ loaded: { prompt: { version: number } } }>(
    `/api/repo-agents/${agent.id}/load`,
    'POST',
    { harness: 'claude-code', workspace: '~/src/example' },
    pat,
  );
  check(
    'agents: an agent’s own prompt edit is held, and load_agent still serves v1',
    typeof edited.proposalId === 'string' && stillLive.loaded.prompt.version === 1,
    { edited, stillLive },
  );
  // The owner accepts it with the signed-in cookie, which makes it v2.
  const accepted = await call<{ prompt: { version: number; status: string } }>(
    `/api/repo-agents/${agent.id}/prompt-proposals/${edited.proposalId ?? ''}/accept`,
    'POST',
    {},
  );
  check(
    'agents: the owner accepting the proposal makes it live (v2)',
    accepted.prompt.status === 'live' && accepted.prompt.version === 2,
    accepted,
  );
  const { user } = await call<{ user: { id: string } }>('/api/auth/session');
  const inventory = await call<{ mcp: McpAvailabilityDto }>('/api/tokens');
  const initialSessions = await call<AgentSessionInventoryDto>(
    `/api/repo-agents/${agent.id}/sessions`,
  );
  const initialSession = initialSessions.sessions.find((item) => item.id === loaded.session.id);
  if (!initialSession) throw new Error('Seeded tool session missing');
  check(
    'agent setup: the real delegated fixture belongs to the signed-in person',
    initialSession.connectionKind === 'pat' && initialSession.cosigner?.id === user.id,
  );

  for (const [label, viewport] of [
    ['390', PHONE],
    ['1440', DESKTOP],
  ] as const) {
    await page.setViewport(viewport);
    await goto('/repo');
    check(`agents ${label}: the list shows the agent`, await visibleText('Architect'));
    check(`agents ${label}: the list does not scroll sideways`, !(await sideways()));
    check(
      `agents ${label}: setup has one primary entry`,
      (await visibleText('Connect a tool')) && (await page.$('.onboard-pill')) === null,
    );
    await setupGeometry(`agent setup list ${label}`, '[aria-label="Connect a tool"]', 1);
    await shot(page, outDir, `agents-list-${label}`);
    await clickAction('Connect a tool');
    await page.waitForSelector('[aria-label="Agent to connect"]');
    await page.click('[aria-label="Agent to connect"]');
    await page.waitForSelector(`[role="option"][data-value="${agent.id}"]`);
    await setupGeometry(`agent setup agent choices ${label}`, '[role="option"]', 1);
    await page.click(`[role="option"][data-value="${agent.id}"]`);
    check(
      `agent setup ${label}: chooser uses the primary tool`,
      await page.$eval('[aria-label="Tool to connect"]', (element) =>
        element.textContent.includes('Claude Code'),
      ),
    );
    await setupGeometry(
      `agent setup chooser ${label}`,
      '[role="dialog"] [aria-label="Agent to connect"], [role="dialog"] [aria-label="Tool to connect"], [role="dialog"] a',
      3,
    );
    await shot(page, outDir, `agent-setup-${label}-chooser`);
    await clickAction('Continue setup');
    await page.waitForSelector('.onboard-pill');
    check(
      `agent setup ${label}: list entry opens the agent's selected-tool deep link`,
      new URL(page.url()).searchParams.get('use') === 'claude-code' &&
        new URL(page.url()).pathname === `/repo/${agent.id}`,
    );

    // Prompt: the agent's edit is the live one, and says who made it and where.
    await goto(`/repo/${agent.id}`);
    await page
      .waitForFunction(
        () => document.body.innerText.includes('Take a screenshot of anything user-facing'),
        { timeout: PATIENCE_MS },
      )
      .catch(() => undefined);
    check(
      `agent ${label}: the Prompt tab shows the agent’s live edit`,
      await visibleText('Take a screenshot of anything user-facing'),
    );
    check(
      `agent ${label}: the prompt names the agent that changed it, and in which tool`,
      await visibleText('changed by Architect in Claude Code'),
    );
    const tabs = await page.evaluate(() =>
      [...document.querySelectorAll('nav[aria-label="Agent sections"] a')].map((a) =>
        a.textContent.trim(),
      ),
    );
    check(
      `agent ${label}: the six tabs are there`,
      ['Prompt', 'Briefs', 'Tools', 'Memory', 'Activity', 'Settings'].every((t) =>
        tabs.includes(t),
      ),
      tabs,
    );
    check(`agent ${label}: the prompt page does not scroll sideways`, !(await sideways()));
    check(
      `agent ${label}: the header has one setup entry`,
      (await page.$('[aria-label="Connect a tool"]')) !== null &&
        (await page.$('.onboard-pill')) === null,
    );
    await setupGeometry(`agent setup header ${label}`, '[aria-label="Connect a tool"]', 1);
    await shot(page, outDir, `agent-prompt-${label}`);

    // Memory: who wrote each one.
    await goto(`/repo/${agent.id}/memory`);
    await page
      .waitForFunction(() => document.body.innerText.includes('keyset-timestamp-precision'), {
        timeout: PATIENCE_MS,
      })
      .catch(() => undefined);
    check(
      `agent ${label}: the memory list shows the agent’s memory`,
      await visibleText('keyset-timestamp-precision'),
    );
    check(
      `agent ${label}: memory cards say the agent wrote it, in which tool`,
      await visibleText('agent · Claude Code'),
    );
    check(`agent ${label}: the memory page does not scroll sideways`, !(await sideways()));
    await shot(page, outDir, `agent-memory-${label}`);

    // Activity: the prompt change, with the agent's note.
    await goto(`/repo/${agent.id}/activity`);
    await page
      .waitForFunction(() => document.body.innerText.includes('Three real bugs'), {
        timeout: PATIENCE_MS,
      })
      .catch(() => undefined);
    check(
      `agent ${label}: Activity carries the agent’s note on its edit`,
      await visibleText('Three real bugs were found by screenshot'),
    );
    check(
      `agent ${label}: Activity says the agent made it`,
      await visibleText('by the agent in Claude Code'),
    );
    check(`agent ${label}: the activity page does not scroll sideways`, !(await sideways()));
    await shot(page, outDir, `agent-activity-${label}`);

    // Tool setup: real checkout and session reads, with controlled negative
    // response fixtures only for another cosigner and excluded account access.
    // for the path — the dialog's prose also names .omr/AGENT.md.
    await call(
      `/api/repo-agents/${agent.id}/load`,
      'POST',
      {
        harness: 'claude-code',
        workspace: '/synthetic-preexisting-tool',
      },
      pat,
    );
    const clockOffset = label === '390' ? -60_000 : 60_000;
    const skewedClock = await page.evaluateOnNewDocument((offset) => {
      const nativeNow = Date.now.bind(Date);
      Date.now = () => nativeNow() + offset;
    }, clockOffset);
    try {
      await goto(`/repo/${agent.id}?use=claude-code`);
    } finally {
      await page.removeScriptToEvaluateOnNewDocument(skewedClock.identifier);
    }
    await page
      .waitForFunction(() => document.querySelectorAll('pre').length > 0, { timeout: PATIENCE_MS })
      .catch(async () => {
        await page.screenshot({ path: `${outDir}/agent-use-${label}-timeout.png`, fullPage: true });
      });
    // The dialog leads with the sentence to paste to your agent; the files sit
    // behind "Or add the files yourself" and a per-file "Show what goes in it".
    // Open them as a person would, then read what is rendered.
    check(
      `agent ${label}: Use in… leads with the sentence to paste to your agent`,
      await visibleText('Check out my On My Radar agent architect for Claude Code'),
    );
    check(
      `agent setup ${label}: actual availability is confirmed by the authorized API`,
      inventory.mcp.available === true &&
        (await visibleText('AI connections (MCP) are available for your account.')),
    );
    await onboardPill(`agent setup ${label}`, `${ONBOARD} for Claude Code — agent id: ${agent.id}`);
    check(
      `agent setup ${label}: copying and an older session do not verify connection with browser clock offset ${clockOffset}ms`,
      !(await visibleText('Connection verified:')),
    );
    await setupGeometry(`agent setup automatic ${label}`, dialogControls, 7);
    await page.$eval('.modal-body', (element) => element.scrollTo(0, 0));
    await shot(page, outDir, `agent-setup-${label}-automatic`);
    const sessionsPath = `/api/repo-agents/${agent.id}/sessions`;
    const connectionAttempt = () =>
      page.$eval('[aria-label="Step 3: Verify the connection"] button', (button) =>
        Number(button.getAttribute('data-check-attempt')),
      );
    const completedNewCheck = (priorAttempt: number) => {
      const step = document.querySelector('[aria-label="Step 3: Verify the connection"]');
      return (
        Number(step?.querySelector('button')?.getAttribute('data-check-attempt')) > priorAttempt &&
        step?.querySelector('button')?.getAttribute('aria-busy') === 'false' &&
        step.querySelector('[role="status"]')?.textContent === 'Connection check complete.'
      );
    };
    const refreshConnection = async (reason: string) => {
      const deadline = Date.now() + PATIENCE_MS;
      const beforeAttempt = await connectionAttempt();
      console.log('[agent setup refresh]', { viewport: label, reason, phase: 'click' });
      const read = (path: string, resource: string) =>
        page
          .waitForResponse(
            (response) =>
              new URL(response.url()).pathname === path && response.request().method() === 'GET',
            { timeout: Math.max(1, deadline - Date.now()) },
          )
          .catch((cause: unknown) => {
            throw new Error(`Agent setup ${label} ${reason}: ${resource} response missing`, {
              cause,
            });
          });
      const [sessionResponse, accessResponse] = await Promise.all([
        read(sessionsPath, 'sessions'),
        read('/api/tokens', 'access'),
        clickAction('Check connection'),
      ]);
      check(
        `agent setup ${label} ${reason}: both authorized refresh reads succeeded`,
        sessionResponse.ok() && accessResponse.ok(),
        { sessions: sessionResponse.status(), access: accessResponse.status() },
      );
      console.log('[agent setup refresh]', { viewport: label, reason, phase: 'responses' });
      // Polling or unrelated requests cannot acknowledge a manual check. Wait
      // for the existing step's rendered completion of both clicked reads.
      await page
        .waitForFunction(
          completedNewCheck,
          { timeout: Math.max(1, deadline - Date.now()) },
          beforeAttempt,
        )
        .catch(async (cause: unknown) => {
          const state = await page.evaluate(() => {
            const step = document.querySelector('[aria-label="Step 3: Verify the connection"]');
            return {
              busy: step?.querySelector('button')?.getAttribute('aria-busy') ?? null,
              attempt: step?.querySelector('button')?.getAttribute('data-check-attempt') ?? null,
              status: step?.querySelector('[role="status"]')?.textContent ?? null,
            };
          });
          console.log('[agent setup refresh]', { viewport: label, reason, phase: 'failed', state });
          throw new Error(`Agent setup ${label} ${reason}: clicked check was not applied`, {
            cause,
          });
        });
      console.log('[agent setup refresh]', { viewport: label, reason, phase: 'applied' });
    };
    await call(`/api/repo-agents/${agent.id}/load`, 'POST', {
      harness: 'claude-code',
      workspace: '/synthetic-browser',
    });
    await refreshConnection('browser-load');
    const previousAttempt = await connectionAttempt();
    // Deliberately do not click: real periodic reads must not acknowledge a new
    // manual attempt merely because the prior completion is still rendered.
    const periodicReads = await Promise.all(
      [sessionsPath, '/api/tokens'].map((path) =>
        page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === path && response.request().method() === 'GET',
          { timeout: PATIENCE_MS },
        ),
      ),
    );
    const afterPeriodic = await connectionAttempt();
    check(
      `agent setup ${label}: old completion plus periodic reads cannot acknowledge a new click`,
      periodicReads.every((response) => response.ok()) &&
        previousAttempt > 0 &&
        afterPeriodic === previousAttempt &&
        !(await page.evaluate(completedNewCheck, previousAttempt)),
      {
        previousAttempt,
        afterPeriodic,
        responses: periodicReads.map((response) => response.status()),
      },
    );
    check(
      `agent setup ${label}: a browser load is not a tool connection`,
      !(await visibleText('Connection verified:')),
    );
    await call(
      `/api/repo-agents/${agent.id}/load`,
      'POST',
      { harness: 'codex', workspace: '/synthetic-wrong-tool' },
      pat,
    );
    await refreshConnection('wrong-tool');
    check(
      `agent setup ${label}: another tool does not complete this setup`,
      !(await visibleText('Connection verified:')),
    );
    let sessionOverride: AgentSessionDto[] | null = null;
    const freshObservation = (await call<AgentSessionInventoryDto>(sessionsPath)).observation;
    if (!freshObservation) throw new Error('Fresh server session observation missing');
    let mcpOverride: McpAvailabilityDto | null = null;
    const answer = (request: HTTPRequest) => {
      if (request.isInterceptResolutionHandled()) return;
      const path = new URL(request.url()).pathname;
      if (request.method() === 'GET' && path === sessionsPath && sessionOverride) {
        void request.respond({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ sessions: sessionOverride, observation: freshObservation }),
        });
      } else if (request.method() === 'GET' && path === '/api/tokens' && mcpOverride) {
        void request.respond({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ tokens: [], agents: [], mcp: mcpOverride }),
        });
      } else void request.continue();
    };
    await page.setRequestInterception(true);
    page.on('request', answer);
    try {
      sessionOverride = [
        {
          ...initialSession,
          startedAt: new Date().toISOString(),
          cosigner: { id: '22222222-2222-4222-8222-222222222222', name: 'Other fixture person' },
        },
      ];
      await refreshConnection('wrong-cosigner');
      check(
        `agent setup ${label}: another cosigner cannot complete setup`,
        !(await visibleText('Connection verified:')),
      );
      mcpOverride = { ...inventory.mcp, enabled: false, available: false };
      await refreshConnection('disabled-access');
      check(
        `agent setup ${label}: disabled MCP says so and keeps manual project files`,
        (await visibleText('turned off for this site')) &&
          !(await visibleText('Connection verified:')) &&
          (await page.$('.use-files')) !== null &&
          (await page.$('.onboard-pill')) === null,
      );
      // Tool, "Or add the files yourself", Edit profile, Check connection. (A fifth, the plan
      // recovery link, went with billing.)
      await setupGeometry(`agent setup disabled ${label}`, dialogControls, 4);
    } finally {
      page.off('request', answer);
      await page.setRequestInterception(false);
    }
    await refreshConnection('restored-access');
    await clickAction('Set up the connection manually');
    check(
      `agent setup ${label}: manual connection is a named alternative`,
      (await visibleText('Set up the connection manually')) &&
        (await visibleText('claude mcp add')),
    );
    await setupGeometry(`agent setup manual ${label}`, dialogControls, 8);
    await page.$eval('.modal-body', (element) => element.scrollTo(0, 0));
    await shot(page, outDir, `agent-setup-${label}-manual`);
    await page.evaluate(() => {
      for (const summary of document.querySelectorAll(
        'details.use-files summary, .use-file summary',
      ))
        (summary as HTMLElement).click();
    });
    const pres = await page.evaluate(() =>
      [...document.querySelectorAll('.use-file pre')].map((p) =>
        (p as HTMLElement).innerText.slice(0, 60),
      ),
    );
    check(
      `agent ${label}: Use in… Claude Code shows the pointer line`,
      pres.some((t) => t.trim() === '@.omr/AGENT.md'),
      pres,
    );
    check(`agent ${label}: Use in… does not scroll sideways`, !(await sideways()));
    await shot(page, outDir, `agent-use-${label}`);
    await call(
      `/api/repo-agents/${agent.id}/load`,
      'POST',
      { harness: 'claude-code', workspace: '/synthetic-verified-tool' },
      pat,
    );
    await refreshConnection('fresh-session');
    await page.waitForFunction(() => document.body.innerText.includes('Connection verified:'), {
      timeout: PATIENCE_MS,
    });
    check(
      `agent setup ${label}: only a new matching delegated session completes setup`,
      await visibleText('Connection verified:'),
    );
    await page.click('[aria-label="Tool"]');
    await page.waitForSelector('[role="option"][data-value="codex"]');
    await setupGeometry(`agent setup tool choices ${label}`, '[role="option"]', 1);
    const toolMenu = await page.$eval('[aria-label="Tool"]', (trigger) => {
      const id = trigger.getAttribute('aria-controls');
      const menu = id ? document.getElementById(id) : null;
      const panel = trigger.closest('[role="dialog"]');
      const option = menu?.querySelector('[role="option"][data-value="codex"]');
      const anchor = trigger.getBoundingClientRect();
      const bounds = menu?.getBoundingClientRect();
      const item = option?.getBoundingClientRect();
      return {
        owned: Boolean(menu?.getAttribute('role') === 'listbox' && panel?.contains(menu)),
        anchorRight: anchor.right,
        menuRight: bounds?.right ?? null,
        viewportFit: Boolean(bounds && bounds.left >= 0 && bounds.right <= innerWidth),
        reachable: Boolean(
          option &&
          item &&
          [item.left + 2, (item.left + item.right) / 2, item.right - 2].every((x) => {
            const hit = document.elementFromPoint(x, (item.top + item.bottom) / 2);
            return hit && option.contains(hit);
          }),
        ),
      };
    });
    check(
      `agent setup ${label}: the owned tool menu aligns to its header and is hit-reachable`,
      toolMenu.owned &&
        toolMenu.viewportFit &&
        toolMenu.menuRight !== null &&
        Math.abs(toolMenu.menuRight - toolMenu.anchorRight) <= 1 &&
        toolMenu.reachable,
      toolMenu,
    );
    const pointer = await page.$eval('[aria-label="Tool"]', (trigger) => {
      const id = trigger.getAttribute('aria-controls');
      return id ? document.getElementById(id)?.id : undefined;
    });
    const delivered = await page.evaluateHandle((menuId) => {
      const menu = menuId ? document.getElementById(menuId) : null;
      const option = menu?.querySelector('[role="option"][data-value="codex"]');
      let trustedOwned = false;
      const record = (event: PointerEvent) => {
        if (event.isTrusted && event.target instanceof Node && option?.contains(event.target))
          trustedOwned = true;
      };
      document.addEventListener('pointerdown', record, { capture: true, passive: true });
      return {
        read: () => trustedOwned,
        stop: () => document.removeEventListener('pointerdown', record, true),
      };
    }, pointer);
    try {
      await page.click('[role="option"][data-value="codex"]');
      check(
        `agent setup ${label}: native tool selection reaches its owned Codex option`,
        await delivered.evaluate((record) => record.read()),
      );
    } finally {
      await delivered.evaluate((record) => record.stop());
      await delivered.dispose();
    }
    await page.waitForSelector('[aria-label="Copy setup prompt for Codex"]');
    check(
      `agent setup ${label}: switching tools resets confirmation and preserves deep links`,
      !(await visibleText('Connection verified:')) &&
        new URL(page.url()).searchParams.get('use') === 'codex' &&
        (await page.$eval(
          '[aria-label="Tool"]',
          (trigger) => trigger.getAttribute('data-value') === 'codex',
        )),
    );
    await onboardPill(`agent setup Codex ${label}`, `${ONBOARD} for Codex — agent id: ${agent.id}`);
    await setupGeometry(`agent setup Codex ${label}`, dialogControls, 7);
  }

  /* ---- Settings: the section is Connections, and connected apps are listed ---- */
  await goto('/settings/connections');
  // Connections paints once its token and app lists settle, which can be after
  // the network first goes idle — so wait for them, not for idle.
  await page
    .waitForFunction(() => document.body.innerText.includes('Connected apps'), {
      timeout: PATIENCE_MS,
    })
    .catch(() => undefined);
  // Identities are gone (docs/AGENT_REPO.md §V2.5): the agent is the identity.
  check('settings: the agents section is now called Connections', await visibleText('Connections'));
  check('settings: there is no Identities section any more', !(await visibleText('Identities')));
  check(
    'settings: connected apps are listed, present at zero',
    await visibleText('Connected apps'),
  );
  await page.setViewport(PHONE);
  return { checks, failures, notes: [] };
}
