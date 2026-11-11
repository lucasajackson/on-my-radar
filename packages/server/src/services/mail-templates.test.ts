/**
 * Every email template, pinned byte for byte (golden files), plus the rules
 * that make the shared layout survive real mail clients — asserted across all
 * of them, so a template added later that skips the layout is caught here.
 *
 * To accept an intended change: `vitest run -u src/services/mail-templates.test.ts`
 * and read the diff in `__golden__/` before committing it.
 */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { loadEnv, setEnvForTesting } from '../env.js';
import {
  approvedMessage,
  loginCodeMessage,
  notificationMessage,
  radarSharedMessage,
  topicSharedMessage,
  waitlistConfirmationMessage,
  waitlistMessage,
  type Message,
} from './mail.js';

describe('email templates', () => {
  beforeAll(() => {
    setEnvForTesting(
      loadEnv({
        DATABASE_URL: 'postgres://unused',
        SESSION_SECRET: 'x'.repeat(48),
        NODE_ENV: 'test',
        APP_URL: 'https://onmyradar.io',
        PUBLIC_URL: 'https://onmyradar.io',
      }),
    );
  });
  afterAll(() => setEnvForTesting(null));

  // A sharer and a radar name carrying markup and an ampersand: escaped once,
  // never twice, never live.
  const sharer = 'R&D <Ops>';
  const templates = (): Record<string, Message> => ({
    'login-code': loginCodeMessage('ada@example.com', '042917'),
    waitlist: waitlistMessage('ada@example.com'),
    'waitlist-confirmation': waitlistConfirmationMessage('ada@example.com', 'Ada'),
    approved: approvedMessage('ada@example.com'),
    'radar-shared-invite': radarSharedMessage('ada@example.com', 'Launch <plan>', sharer, {
      hasAccount: false,
      link: 'https://onmyradar.io/invite/token',
      skipsWaitlist: false,
    }),
    'topic-shared': topicSharedMessage(
      'ada@example.com',
      'Q4',
      sharer,
      { hasAccount: true, link: 'https://onmyradar.io/array/1', skipsWaitlist: false },
      3,
    ),
    notification: notificationMessage(
      'ada@example.com',
      'Grace commented on your blip',
      'This is <b>the</b> excerpt & more',
      'https://onmyradar.io/radar/1?blip=2',
    ),
  });

  // Listed, not read off `templates()`: that builds messages, which reads the
  // environment, and the loop runs at collection time — before `beforeAll`.
  const NAMES = [
    'login-code',
    'waitlist',
    'waitlist-confirmation',
    'approved',
    'radar-shared-invite',
    'topic-shared',
    'notification',
  ] as const;

  it('names every template it builds', () => {
    expect(Object.keys(templates()).sort()).toEqual([...NAMES].sort());
  });

  for (const name of NAMES) {
    it(`matches the golden ${name} email, HTML and text`, async () => {
      const message = templates()[name];
      if (!message) throw new Error(name);
      await expect(message.html).toMatchFileSnapshot(`../__golden__/mail-${name}.html`);
      await expect(message.text).toMatchFileSnapshot(`../__golden__/mail-${name}.txt`);
    });
  }

  it('holds the email-client rules in every template', () => {
    for (const [name, message] of Object.entries(templates())) {
      const html = message.html;
      // Declared dark, so Apple Mail and iOS leave it alone.
      expect(html, name).toContain('<meta name="color-scheme" content="dark">');
      expect(html, name).toContain('<meta name="supported-color-schemes" content="dark">');
      // The mark as a hosted PNG; no SVG, which clients block.
      expect(html, name).toContain('src="https://onmyradar.io/email-mark.png"');
      expect(html, name).not.toMatch(/<svg|\.svg"/);
      // No text on an image.
      expect(html, name).not.toMatch(/background-image|background:\s*url/);
      // True-black surfaces, set both ways.
      expect(html, name).toContain('bgcolor="#000000"');
      expect(html, name).toContain('background-color:#000000');
      // The footer: one line of why, and the way out.
      expect(html, name).toContain('you can ignore it safely');
      // Every button is bulletproof: the link sits in a coloured cell.
      const buttons = html.match(/<a [^>]*padding:13px 26px[^>]*>/g) ?? [];
      const cells = html.match(/<td bgcolor="#ffb457"/g) ?? [];
      expect(cells.length, name).toBe(buttons.length);
      // A plain-text part, always.
      expect(message.text.trim().length, name).toBeGreaterThan(0);
      // Nothing escaped twice.
      expect(html, name).not.toContain('&amp;amp;');
      expect(html, name).not.toContain('&amp;lt;');
    }
  });

  it('never lets user text become markup', () => {
    const { html } = radarSharedMessage('a@example.com', 'Launch <plan>', sharer, {
      hasAccount: true,
      link: 'https://onmyradar.io/radar/1',
      skipsWaitlist: false,
    });
    expect(html).toContain('R&amp;D &lt;Ops&gt; shared a radar with you');
    expect(html).toContain('Launch &lt;plan&gt;');
    expect(html).not.toContain('<Ops>');
    expect(
      notificationMessage('a@example.com', 'x', '<script>1</script>', 'https://x').html,
    ).not.toContain('<script>');
  });

  it('shows the sign-in code as one run of digits, easy to copy', () => {
    const { html, text } = loginCodeMessage('a@example.com', '042917');
    expect(html).toMatch(/>042917<\/span>/);
    expect(text).toContain('042917');
  });

  it('puts the sign-in link and the address in the approval email', () => {
    const { html } = approvedMessage('ada@example.com');
    expect(html).toContain('href="https://onmyradar.io/login"');
    expect(html).toContain('ada@example.com');
  });

  it('serves the mark the emails point at, as a PNG at a stable path', async () => {
    setEnvForTesting(
      loadEnv({
        DATABASE_URL: 'postgres://unused',
        SESSION_SECRET: 'x'.repeat(48),
        NODE_ENV: 'test',
        // Vite copies `public/` into the bundle as it is; serve it from there.
        UI_DIST_DIR: fileURLToPath(new URL('../../../ui/public/', import.meta.url)),
      }),
    );
    const res = await createApp().request('/email-mark.png');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toBe('public, max-age=86400');
    const bytes = new Uint8Array(await res.arrayBuffer());
    // The PNG signature, so a fallback to the SPA shell cannot pass for it.
    expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });
});
