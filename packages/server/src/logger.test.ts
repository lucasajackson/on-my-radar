/**
 * The log must never write a live credential, from any call site.
 *
 * Two URL shapes in this application carry a secret in the path: the webhook
 * ingest URL `/hooks/<id>/<token>`, which is pasted into other people's
 * products, and the invitation link `/api/invites/<token>` with the SPA screen
 * behind it, `/invite/<token>`.
 *
 * This was fixed once, as `safePath` in `app.ts`, applied at the single call
 * site that logged a path. Two more call sites appeared afterwards — the 5xx
 * branch of `app.onError` and `hookRoutes.onError` — and both wrote the webhook
 * token verbatim, on the same request whose access-log line said `[redacted]`.
 * The invitation token was never covered at all, and it is not an error path:
 * every successful click logged its own token at INFO.
 *
 * So these assertions are about the **logger**, not about a helper that call
 * sites have to remember. Redaction happens in pino's `redact`, and the tests
 * render through a logger built from the exported `REDACTION` itself — a suite
 * that re-declared the config would prove nothing about what production writes.
 * The last one pushes real requests through `createApp()` and renders whatever
 * the call sites handed over, so a *new* log call is covered without this file
 * being edited.
 */
import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { REDACTION, scrubPath } from './logger.js';

process.env['SESSION_SECRET'] ??= 'test-only-session-secret-not-used-anywhere-else';
process.env['DATABASE_URL'] ??= 'postgres://unused';

describe('scrubPath', () => {
  it('redacts a webhook token but keeps the id traceable', () => {
    expect(scrubPath('/hooks/abc-123/omr_hook_SUPERSECRETVALUE')).toBe('/hooks/abc-123/[redacted]');
  });

  it('redacts an invitation token on both the API route and the SPA screen', () => {
    expect(scrubPath('/api/invites/eyJhbGciOi.SIGNED')).toBe('/api/invites/[redacted]');
    expect(scrubPath('/api/v1/invites/eyJhbGciOi.SIGNED')).toBe('/api/v1/invites/[redacted]');
    expect(scrubPath('/invite/eyJhbGciOi.SIGNED')).toBe('/invite/[redacted]');
  });

  it('redacts the same credentials inside a whole URL, not only a bare path', () => {
    expect(scrubPath('https://onmyradar.io/hooks/abc-123/TOKEN')).toBe(
      'https://onmyradar.io/hooks/abc-123/[redacted]',
    );
    expect(scrubPath('https://onmyradar.io/invite/TOKEN?next=/radar/1')).toBe(
      'https://onmyradar.io/invite/[redacted]',
    );
  });

  it('leaves every other path alone', () => {
    expect(scrubPath('/api/radars/abc-123/blips')).toBe('/api/radars/abc-123/blips');
    expect(scrubPath('/mcp')).toBe('/mcp');
    expect(scrubPath('/hooks/abc-123')).toBe('/hooks/abc-123');
    // A public radar's slug is an identifier, not a credential: it is meant to
    // be pasted into a chat, and a log line about one has to name which radar.
    expect(scrubPath('/r/kR3xmPq')).toBe('/r/kR3xmPq');
    expect(scrubPath('/api/invites')).toBe('/api/invites');
  });
});

/* ------------------------- what the log really got ------------------------ */

/** Renders through the application's real redaction config. */
function render(entries: Array<[unknown, string]>): string {
  const lines: string[] = [];
  const log = pino(
    { base: null, redact: { ...REDACTION, paths: [...REDACTION.paths] } },
    { write: (line: string) => lines.push(line) },
  );
  for (const [obj, msg] of entries) log.error(obj as object, msg);
  return lines.join('\n');
}

describe('the logger itself redacts, whoever calls it', () => {
  const TOKEN = 'S3CR3T-INGEST-TOKEN-DO-NOT-LOG';

  it('scrubs a path handed to it as `path`', () => {
    const out = render([
      [{ path: `/hooks/abc/${TOKEN}` }, 'request'],
      [{ err: new Error('boom'), path: `/api/invites/${TOKEN}` }, 'request failed'],
    ]);
    expect(out).not.toContain(TOKEN);
    expect(out).toContain('/hooks/abc/[redacted]');
    expect(out).toContain('/api/invites/[redacted]');
  });

  it('scrubs one nested a level down, where a helper might put it', () => {
    expect(render([[{ req: { path: `/hooks/abc/${TOKEN}` } }, 'nested']])).not.toContain(TOKEN);
  });

  it('still blanks the keys that name a secret outright', () => {
    const out = render([[{ token: 'aaa', code: '123456', nested: { token: 'bbb' } }, 'secrets']]);
    expect(out).not.toContain('aaa');
    expect(out).not.toContain('123456');
    expect(out).not.toContain('bbb');
    expect(out).toContain('[redacted]');
  });
});

/* --------------------------- through the app ------------------------------ */

describe('every path the app logs', () => {
  it('never writes a webhook or invitation token, whatever the status', async () => {
    const captured: Array<[unknown, string]> = [];
    const { logger } = await import('./logger.js');
    for (const level of ['info', 'error', 'warn', 'debug'] as const) {
      vi.spyOn(logger, level).mockImplementation((obj: unknown, msg?: string) => {
        captured.push([obj, msg ?? '']);
      });
    }

    const { createApp } = await import('./app.js');
    const app = createApp();
    const token = 'S3CR3T-URL-TOKEN-DO-NOT-LOG';

    // A GET on /hooks answers without touching the database; the other two are
    // 404s. All three go through the access log, which is where the invitation
    // token was being written at INFO on every real click.
    await app.request(`/hooks/11111111-1111-1111-1111-111111111111/${token}`);
    await app.request(`/api/invites/${token}`);
    await app.request(`/api/v1/invites/${token}`);
    await app.request(`/invite/${token}`);

    vi.restoreAllMocks();

    // Not vacuous: the requests really were logged, and the id survives so a
    // delivery stays traceable to a row.
    const rendered = render(captured);
    expect(rendered).toContain('/hooks/11111111-1111-1111-1111-111111111111/[redacted]');
    expect(rendered).toContain('/api/invites/[redacted]');
    expect(rendered).toContain('/api/v1/invites/[redacted]');
    expect(rendered).toContain('/invite/[redacted]');
    expect(rendered).not.toContain(token);
  });
});
