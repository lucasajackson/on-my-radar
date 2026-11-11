/** Browser contract checks; MIME/storage persistence is covered by server integration tests. */
import type { HTTPRequest, Page } from 'puppeteer-core';
import { RADAR_TEMPLATES } from '@onmyradar/contract';
import type { BlipDto, EmailDetailDto, EmailSummaryDto, RadarTemplate } from '@onmyradar/contract';
import { PHONE, shot, must } from './harness.js';
import type { Seeded } from './seed.js';
import type { Check, SweepResult } from './sweep.js';

export async function runEmailReaderFlows(
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
  const subject = 'Workshop newsletter — September offers';
  const text = 'A readable newsletter introduction.\n\n' + 'Original message content. '.repeat(200);
  const summary: EmailSummaryDto = {
    subject,
    senderName: 'Workshop newsletter',
    senderAddress: 'news@example.test',
    sentAt: '2026-09-19T12:00:00Z',
    receivedAt: new Date().toISOString(),
    preview: 'A readable newsletter introduction.',
    hasHtml: true,
    legacy: false,
    notes: 'Keep the workshop offer for later.',
    attachmentCount: 0,
  };
  const ids = new Map<string, string>();
  const publicSlug = must(seeded.published[0]).slug;
  const publicResponse = await fetch(`${seeded.baseUrl}/api/public/radars/${publicSlug}`);
  const { radar: publicRadar } = (await publicResponse.json()) as { radar: { id: string } };
  for (const radar of [...seeded.radars, publicRadar]) {
    const response = await fetch(`${seeded.baseUrl}/api/radars/${radar.id}/blips`, {
      method: 'POST',
      headers: { cookie: seeded.ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ title: subject, body: text }),
    });
    if (!response.ok) throw new Error(`Email fixture creation failed: ${response.status}`);
    const { blip } = (await response.json()) as { blip: BlipDto };
    ids.set(radar.id, blip.id);
  }
  const [cookieName, ...cookieValue] = seeded.ownerCookie.split('=');
  await page.browser().setCookie({
    name: must(cookieName),
    value: cookieValue.join('='),
    domain: new URL(seeded.baseUrl).hostname,
    path: '/',
  });
  let detailRequests = 0;
  const remoteRequests: string[] = [];
  const interceptErrors: string[] = [];
  const intercept = async (request: HTTPRequest) => {
    if (request.isInterceptResolutionHandled()) return;
    try {
      const url = new URL(request.url());
      if (url.hostname === 'email-remote.example.test') {
        remoteRequests.push(url.pathname);
        await request.abort();
        return;
      }
      if (url.origin === seeded.baseUrl && request.method() === 'GET') {
        const list = /^\/api\/(?:public\/)?radars\/([^/]+)\/blips$/.exec(url.pathname);
        const radarId = list?.[1] === publicSlug ? publicRadar.id : list?.[1];
        if (list && radarId && ids.has(radarId)) {
          const response = await fetch(url, { headers: { cookie: seeded.ownerCookie } });
          const body = (await response.json()) as { items: BlipDto[] };
          body.items = body.items.map((blip) =>
            ids.get(radarId) === blip.id
              ? {
                  ...blip,
                  email: { ...summary, ...(list[1] === publicSlug ? { senderAddress: null } : {}) },
                }
              : blip,
          );
          await request.respond({
            status: response.status,
            contentType: 'application/json',
            body: JSON.stringify(body),
          });
          return;
        }
        const detail = /^\/api\/(?:public\/radars\/[^/]+\/)?blips\/([^/]+)\/email$/.exec(
          url.pathname,
        );
        if (detail && [...ids.values()].includes(must(detail[1]))) {
          detailRequests++;
          const images = url.searchParams.get('images') === '1';
          const email: EmailDetailDto = {
            ...summary,
            ...(url.pathname.includes('/public/') ? { senderAddress: null } : {}),
            text,
            attachments: [],
            originalHref: null,
            remoteImagesBlocked: images ? 0 : 1,
            imageOrigins: [],
            // Include hostile network markup as defense-in-depth checks on the browser sandbox.
            // The real server sanitizer separately removes these constructs.
            html: `<table style="width:600px;background:#f8f3e9"><tr><td><h1>Workshop offers</h1><p>Formatted newsletter content</p></td></tr></table><style>@import url('https://email-remote.example.test/css');</style><script>parent.document.body.dataset['emailEscaped']='yes'</script><form action="https://email-remote.example.test/form"><input></form>${images ? '<img src="https://email-remote.example.test/banner.png" alt="Newsletter banner">' : '<img src="https://email-remote.example.test/blocked.png" alt="Hidden image">'}`,
          };
          await request.respond({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ email }),
          });
          return;
        }
      }
      await request.continue();
    } catch (error) {
      interceptErrors.push(String(error));
      if (!request.isInterceptResolutionHandled()) await request.abort();
    }
  };
  await page.setRequestInterception(true);
  // The handler catches its own failures into interceptErrors; nothing awaits it.
  const onRequest = (request: HTTPRequest) => void intercept(request);
  page.on('request', onRequest);
  try {
    await page.setViewport({ width: 1366, height: 900 });
    for (const radar of seeded.radars) {
      // A reader lists stories by title and shows a captured email in full once opened
      // (reader.test.tsx), so it has no compact card to measure.
      if (RADAR_TEMPLATES[radar.template as RadarTemplate].layout === 'reader') continue;
      await page.goto(`${seeded.baseUrl}/radar/${radar.id}`, { waitUntil: 'networkidle2' });
      await page.waitForSelector('.email-card-subject');
      check(
        `email preview remains compact in ${radar.template}`,
        await page.$eval(
          '.email-card',
          (element) =>
            element.getBoundingClientRect().height < 260 &&
            !element.textContent.includes('Original message content.'),
        ),
      );
    }
    check('email reader content is fetched only on open', detailRequests === 0, detailRequests);
    await page.click('.email-card-subject');
    await page.waitForSelector('.email-reader iframe');
    await page.$eval('.modal-panel', async (el) => {
      await Promise.all(el.getAnimations().map((animation) => animation.finished));
    });
    const iframe = await page.$('.email-reader iframe');
    const frame = await must(iframe).contentFrame();
    await frame.waitForSelector('h1');
    check(
      'email reader renders formatted markup',
      await frame.$eval('h1', (el) => el.textContent === 'Workshop offers'),
    );
    check(
      'email sandbox does not permit scripts or same-origin access',
      await must(iframe).evaluate(
        (el) => !el.sandbox.contains('allow-scripts') && !el.sandbox.contains('allow-same-origin'),
      ),
    );
    check(
      'email content cannot change app document',
      await page.evaluate(() => !document.body.dataset['emailEscaped']),
    );
    check(
      'email view loads no remote content before consent',
      remoteRequests.length === 0,
      remoteRequests,
    );
    await shot(page, outDir, 'email-reader-desktop');
    await page.click('[role="tablist"][aria-label="Email view"] button:last-child');
    await page.waitForSelector('.email-reader-text');
    check(
      'email text view preserves readable original',
      await page.$eval(
        '.email-reader-text',
        (el) => el.textContent.includes('Original message content.') === true,
      ),
    );
    await page.keyboard.press('Escape');
    await page.waitForSelector('.email-reader', { hidden: true });
    check(
      'closing email restores focus to its subject',
      await page.evaluate(
        () => document.activeElement?.classList.contains('email-card-subject') === true,
      ),
    );
    await page.setViewport(PHONE);
    await page.waitForSelector('.email-card-subject', { visible: true });
    await page.click('.email-card-subject');
    await page.waitForSelector('.email-reader iframe');
    await page.$eval('.modal-panel', async (el) => {
      await Promise.all(el.getAnimations().map((animation) => animation.finished));
    });
    check(
      'email reader stays inside the phone viewport',
      await page.$eval('.modal-panel', (el) => {
        const rect = el.getBoundingClientRect();
        return (
          rect.left >= -1 &&
          rect.right <= innerWidth + 1 &&
          rect.top >= -1 &&
          rect.bottom <= innerHeight + 1
        );
      }),
    );
    await shot(page, outDir, 'email-reader-phone');
    // Observe this action's request, rather than waiting for the whole app's
    // background polling to become idle. Register before the click.
    const bannerRequest = page.waitForRequest(
      (request) => request.url() === 'https://email-remote.example.test/banner.png',
    );
    for (const button of await page.$$('.email-reader button')) {
      if ((await button.evaluate((el) => el.textContent.trim())) === 'Load remote images') {
        await button.click();
        break;
      }
    }
    await page.waitForFunction(() =>
      document
        .querySelector('.email-reader')
        ?.textContent.includes('Remote images allowed for this view.'),
    );
    await bannerRequest;
    check(
      'remote-image consent permits images without enabling stylesheets',
      remoteRequests.includes('/banner.png') && !remoteRequests.includes('/css'),
      remoteRequests,
    );
    await page.keyboard.press('Escape');
    await page.goto(`${seeded.baseUrl}/r/${publicSlug}`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('.email-card-subject');
    await page.click('.email-card-subject');
    await page.waitForSelector('.email-reader iframe');
    await page.$eval('.modal-panel', async (el) => {
      await Promise.all(el.getAnimations().map((animation) => animation.finished));
    });
    const publicFrame = await must(await page.$('.email-reader iframe')).contentFrame();
    await publicFrame.waitForSelector('h1');
    check(
      'public radar CSP permits the isolated email reader',
      await publicFrame.$eval('h1', (el) => el.textContent === 'Workshop offers'),
    );
    check(
      'public email reader omits sender address and original download',
      await page.$eval(
        '.email-reader',
        (el) =>
          !el.textContent.includes('news@example.test') &&
          !el.textContent.includes('Original email'),
      ),
    );
    await page.keyboard.press('Escape');
    check(
      'email browser fixture has no request errors',
      interceptErrors.length === 0,
      interceptErrors,
    );
  } finally {
    page.off('request', onRequest);
    await page.setRequestInterception(false);
  }
  return {
    checks,
    failures,
    notes: [
      'Email browser checks use contract fixtures; server tests exercise MIME, R2 ownership, and authorization.',
    ],
  };
}
