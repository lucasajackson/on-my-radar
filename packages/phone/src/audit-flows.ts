/** End-to-end regressions for radar organization and accessible management. */
import { chooseSelect } from './select.js';
import type { HTTPRequest, Page } from 'puppeteer-core';
import { IOS_UA, PHONE, shot, must } from './harness.js';
import type { Seeded } from './seed.js';
import type { Check, SweepResult } from './sweep.js';

export async function runAuditFlows(
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
  const button = async (name: string, scope = 'body') => {
    const candidates = await page.$$(`${scope} button`);
    for (const candidate of candidates) {
      const matches = await candidate.evaluate(
        (element, label) =>
          !element.closest('[inert]') &&
          element.getClientRects().length > 0 &&
          (element.getAttribute('aria-label') ?? element.textContent).trim() === label,
        name,
      );
      if (matches) {
        await candidate.click();
        return;
      }
    }
    throw new Error(`Visible button missing: ${name}`);
  };
  const field = async (name: string) => {
    const labels = await page.$$('.modal-panel label');
    for (const label of labels) {
      if (
        await label.evaluate((element, text) => {
          // The label as a screen reader hears it: a visible "(required)" is
          // aria-hidden, because aria-required already says so.
          const span = element.querySelector('span')?.cloneNode(true);
          if (!(span instanceof HTMLElement)) return false;
          for (const hidden of span.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
          return span.textContent.trim() === text;
        }, name)
      ) {
        const input = await label.$('input');
        if (input) return input;
      }
    }
    throw new Error(`Modal field missing: ${name}`);
  };

  await page.setUserAgent({ userAgent: IOS_UA });
  await page.setViewport(PHONE);
  await page.goto(`${seeded.baseUrl}/radars`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.directory-shortcuts');
  await button('New radar', 'main');
  await page.waitForSelector('.modal-panel');
  check(
    'opening a dialog makes the background tab bar inert',
    await page.$eval('.app-tabbar', (element) => Boolean(element.closest('[inert]'))),
  );
  await page.keyboard.press('Escape');
  await page.waitForSelector('.modal-panel', { hidden: true });
  check(
    'Escape restores the radar creation trigger',
    await page.evaluate(() => document.activeElement?.textContent.trim() === 'New radar'),
  );
  check(
    'closing a dialog restores background interaction',
    await page.$eval('.app-tabbar', (element) => !element.closest('[inert]')),
  );

  await button('New radar', 'main');
  await (await field('Name')).type('Workflow journal');
  await (await field('Tagline')).type('Keep this draft while making a topic');
  await button('New array', '.modal-panel');
  await (await field('New array name')).type('Workflow topic');
  await button('Create array', '.modal-panel');
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.modal-panel [role="combobox"]')].some((option) =>
      option.textContent.includes('Workflow topic'),
    ),
  );
  const draft = await page.$$eval('.modal-panel input', (inputs) =>
    inputs.map((input) => input.value),
  );
  check(
    'inline topic creation preserves the radar draft',
    draft.includes('Workflow journal') && draft.includes('Keep this draft while making a topic'),
    draft,
  );
  check('inline topic creation stays on the directory', new URL(page.url()).pathname === '/radars');
  await chooseSelect(page, '.modal-panel', 'microblog');
  await button('Create radar', '.modal-panel');
  await page.waitForFunction(
    () => document.querySelector('h1')?.textContent === 'Workflow journal',
  );
  check(
    'created radar shows its chosen topic',
    await page.$eval('main', (main) => main.textContent.includes('Workflow topic')),
  );
  await page.type('#composer', 'A journal post for the accessible actions regression');
  await page.focus('#composer');
  await page.keyboard.down('Meta');
  await page.keyboard.press('Enter');
  await page.keyboard.up('Meta');
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.blip-card')].some((blip) =>
      blip.textContent.includes('accessible actions regression'),
    ),
  );
  await page.waitForSelector('.blip-card.ping-in');
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.blip-card')].every(
      (card) =>
        Number(getComputedStyle(card).opacity) === 1 &&
        card.getAnimations().every((animation) => animation.playState === 'finished'),
    ),
  );
  const cardContrast = await page.$eval('.blip-card', (card) => {
    const body = card.querySelector('.blip-body');
    const ancestors = [];
    for (let node: Element | null = card; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      ancestors.push({ node: node.className, opacity: style.opacity, filter: style.filter });
    }
    return { color: body ? getComputedStyle(body).color : null, ancestors };
  });
  check(
    'settled microblog content is not faded by its ancestors',
    cardContrast.ancestors.every((node) => Number(node.opacity) === 1 && node.filter === 'none'),
    cardContrast,
  );
  await shot(page, outDir, 'audit-inline-topic-microblog');
  const radarPath = new URL(page.url()).pathname;
  check(
    'microblog keeps triage controls out of the reading surface',
    await page.$$eval('.blip-card [role="combobox"]', (selects) =>
      selects.every((select) => select.getClientRects().length === 0),
    ),
  );
  await button('Post actions', 'main');
  await page.waitForSelector('.post-actions-popover:popover-open [role="combobox"]', {
    visible: true,
  });
  await chooseSelect(page, '.post-actions-popover:popover-open', 'later');
  await page.waitForFunction(
    () =>
      document
        .querySelector('.post-actions-popover [role="combobox"]')
        ?.getAttribute('data-value') === 'later',
  );
  await page.keyboard.press('Escape');
  await page.goto(`${seeded.baseUrl}${radarPath}/settings`, { waitUntil: 'networkidle2' });
  const taglineInput = await page.$('input[placeholder="What is this radar for?"]');
  if (!taglineInput) throw new Error('Radar tagline input missing');
  await taglineInput.click({ clickCount: 3 });
  await taglineInput.type('Draft retained across source and people settings');
  for (const section of ['sources', 'people', 'identity']) {
    await page.click(`nav[aria-label="Settings sections"] a[href$="section=${section}"]`);
    await page.waitForFunction(
      (value) => new URL(location.href).searchParams.get('section') === value,
      {},
      section,
    );
  }
  check(
    'settings drafts survive source and people sections',
    await page.$eval(
      'input[placeholder="What is this radar for?"]',
      (input) => input.value === 'Draft retained across source and people settings',
    ),
  );
  await button('Save changes');
  await page.waitForFunction(() => document.body.textContent.includes('Everything here is saved.'));
  await page.reload({ waitUntil: 'networkidle2' });
  check(
    'retained settings draft saves and survives reload',
    await page.$eval(
      'input[placeholder="What is this radar for?"]',
      (input) => input.value === 'Draft retained across source and people settings',
    ),
  );
  await page.goto(`${seeded.baseUrl}${radarPath}`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.blip-card');
  await button('Post actions', 'main');
  check(
    'secondary post actions persist triage without a swipe',
    await page.$eval(
      '.post-actions-popover [role="combobox"]',
      (select) => select.getAttribute('data-value') === 'later',
    ),
  );
  await page.keyboard.press('Escape');
  /*
   * Leaving the phone's `isMobile`/`hasTouch` makes puppeteer RELOAD the page
   * inside `setViewport` (EmulationManager.emulateViewport). Done here, before
   * anything is held, so the held batch below belongs to one document — this
   * used to happen inside the hold, which left requests from a discarded
   * document in `heldNavigation`.
   */
  await page.setViewport({ width: 1366, height: 900 });
  // Hold shell-only requests until the filter has been typed. Main content can
  // finish first in CI; networkidle2 does not imply sidebar data is ready.
  const heldNavigation: HTTPRequest[] = [];
  let releasingNavigation = false;
  const delayNavigation = (request: HTTPRequest) => {
    const path = new URL(request.url()).pathname;
    if (
      !releasingNavigation &&
      ['/api/radars', '/api/topics', '/api/radars/drop-box'].includes(path)
    )
      heldNavigation.push(request);
    else void request.continue();
  };
  await page.setRequestInterception(true);
  page.on('request', delayNavigation);
  try {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[aria-label="Filter sidebar radars"]', { visible: true });
    /*
     * The shell mounts as soon as the session resolves; the radar underneath
     * arrives on its own request, which is not held. At desktop widths the
     * composer focuses itself when it mounts. Typing before that has happened
     * races it: CI pipeline 5185 typed "Workf" into the filter and "low topic"
     * into the composer, and the value wait below timed out. Reproduced by
     * delaying `/api/radars/:id` 400ms. Wait until the radar has claimed focus,
     * THEN take it — `page.type` focuses the filter first.
     */
    await page.waitForFunction(() => document.activeElement?.id === 'composer');
    await page.type('[aria-label="Filter sidebar radars"]', 'Workflow topic');
    check(
      'sidebar announces loading while navigation responses are pending',
      await page.$eval(
        '.sidebar-nav',
        (nav) =>
          nav.getAttribute('aria-busy') === 'true' &&
          nav.textContent.includes('Loading radars and arrays') === true,
      ),
    );
    check(
      'pending sidebar filtering does not claim the account or results are empty',
      await page.$eval(
        '.sidebar-nav',
        (nav) =>
          !nav.textContent.includes('No matching radars') &&
          !nav.textContent.includes('No radars yet'),
      ),
    );
  } finally {
    // Releasing one response can start another shell request. Stop holding new
    // arrivals before awaiting the original batch, or they escape that snapshot.
    releasingNavigation = true;
    await Promise.all(
      heldNavigation.map(async (request) => {
        if (request.isInterceptResolutionHandled()) return;
        await request.continue().catch((error: unknown) => {
          if (!request.failure()) throw error;
        });
      }),
    );
    page.off('request', delayNavigation);
    await page.setRequestInterception(false);
  }
  await page.waitForFunction(
    () => document.querySelector('.sidebar-nav')?.getAttribute('aria-busy') === 'false',
  );
  // A check with the value in its detail, not a wait: a lost keystroke should
  // say where it went rather than surface as a bare 20s TimeoutError.
  const typedFilter = await page.$eval(
    '[aria-label="Filter sidebar radars"]',
    (input) => (input as HTMLInputElement).value,
  );
  check('sidebar filter keeps every typed character', typedFilter === 'Workflow topic', {
    typedFilter,
    focused: await page.evaluate(
      () => document.activeElement?.id ?? document.activeElement?.tagName,
    ),
  });
  const sidebarResults = await page.$$eval('.app-sidebar a[href^="/radar/"]', (links) =>
    links.filter((link) => link.getClientRects().length > 0).map((link) => link.textContent.trim()),
  );
  check(
    'sidebar filtering finds topic radars without unrelated results',
    sidebarResults.some((label) => label.includes('Workflow journal')) &&
      !sidebarResults.some((label) => label.includes('House')),
    sidebarResults,
  );
  check(
    'sidebar filtering retains global directory navigation',
    await page.$eval('.app-sidebar a[href="/radars"]', (link) => link.getClientRects().length > 0),
  );

  const intercept = (request: HTTPRequest) => {
    if (new URL(request.url()).pathname === `/api/radars/${radarPath.split('/').at(-1) ?? ''}`) {
      void request.respond({
        status: 503,
        contentType: 'text/html',
        body: '<html>Gateway unavailable</html>',
      });
    } else void request.continue();
  };
  await page.setRequestInterception(true);
  page.on('request', intercept);
  try {
    await page.goto(`${seeded.baseUrl}${radarPath}`, { waitUntil: 'networkidle2' });
    await page.waitForFunction(() =>
      document.querySelector('[role="alert"]')?.textContent.includes('Could not load radar'),
    );
    check(
      'a gateway failure is not presented as a missing radar',
      await page.$eval('[role="alert"]', (alert) => !alert.textContent.includes('not found')),
    );
    await shot(page, outDir, 'audit-radar-retry');
  } finally {
    page.off('request', intercept);
    await page.setRequestInterception(false);
  }
  await button('Try again', 'main');
  await page.waitForFunction(
    () => document.querySelector('h1')?.textContent === 'Workflow journal',
  );
  await page.waitForSelector('.blip-card');
  check(
    'retry restores the radar after a transient failure',
    (await page.$('.blip-card')) !== null,
  );
  await page.setViewport(PHONE);
  await page.goto(`${seeded.baseUrl}/radar/${seeded.dropBoxId}/settings?section=identity`, {
    waitUntil: 'networkidle2',
  });
  check(
    'Drop box settings omit radar deletion',
    !(await page.evaluate(() =>
      [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Delete radar'),
    )),
  );
  await page.goto(`${seeded.baseUrl}/radar/${seeded.dropBoxId}/settings?section=sources`, {
    waitUntil: 'networkidle2',
  });
  await button('Add RSS feed', 'main');
  await (await field('Feed URL')).type('https://example.com/feed.xml');
  check(
    'RSS import requires a deliberate history selection',
    await page.$eval('.modal-panel button.btn-accent', (b) => b.disabled),
  );
  await page.click('.modal-panel [role="combobox"]');
  await page.waitForSelector('[role="listbox"]', { visible: true });
  check(
    'RSS import offers every requested history window',
    await page.$$eval('[role="listbox"] [role="option"]', (options) =>
      ['forever', 'year', 'month', 'week', 'day'].every((value) =>
        options.some((option) => option.getAttribute('data-value') === value),
      ),
    ),
  );
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.goto(`${seeded.baseUrl}/`, { waitUntil: 'networkidle2' });
  await button('Add widget', 'main');
  const choices = await page.$$('.modal-panel input[type="radio"]');
  await must(choices[1]).click();
  await (await field('Widget name')).type('All inbox blips');
  await page.waitForFunction(() =>
    [...document.querySelectorAll<HTMLButtonElement>('.modal-panel button')].some(
      (b) => b.textContent.trim() === 'Add widget' && !b.disabled,
    ),
  );
  await button('Add widget', '.modal-panel');
  await page.waitForSelector('.modal-panel', { hidden: true });
  check(
    'mobile dashboard saves a cross-radar live query widget',
    await page.evaluate(
      () => document.querySelector('main')?.textContent.includes('All inbox blips') ?? false,
    ),
  );
  check(
    'mobile dashboard offers keyboard arrangement controls',
    (await page.$('button[aria-label="Arrange widget"]')) !== null,
  );
  const compactRadar = await page.evaluate(() => {
    const link = [...document.querySelectorAll('.dashboard-mobile-widget a')].find((item) =>
      item.textContent.includes('First Radar'),
    );
    const widget = link?.closest('.dashboard-mobile-widget');
    return widget ? widget.getBoundingClientRect().height : null;
  });
  check(
    'phone single-item radar widgets fit their content',
    compactRadar !== null && compactRadar < 250,
    compactRadar,
  );
  await shot(page, outDir, 'audit-live-query-widget');
  return { checks, failures, notes: [] };
}
