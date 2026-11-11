import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, getDb } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { purgeExpiredRelayNonces, rememberRelayNonce } from './relay-nonces.js';

const hasDatabase = Boolean(process.env['DATABASE_URL']);
process.env['SESSION_SECRET'] ??= 'test-only-session-secret-not-used-anywhere-else';

describe.skipIf(!hasDatabase)('the email relay nonce store', () => {
  beforeAll(async () => {
    await runMigrations();
  }, 30_000);
  afterAll(closeDb);
  const nonce = () => `n-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  it('accepts a nonce once and refuses every repeat, however many replicas ask at once', async () => {
    const n = nonce();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => rememberRelayNonce(n, Date.now(), 300_000)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await rememberRelayNonce(n, Date.now(), 300_000)).toBe(false);
  });

  it('takes over a nonce whose window has passed, and the sweep removes it', async () => {
    const n = nonce();
    expect(await rememberRelayNonce(n, Date.now() - 600_000, 300_000)).toBe(true);
    expect(await purgeExpiredRelayNonces()).toBeGreaterThanOrEqual(1);
    const { rows } = await getDb().execute(
      sql`SELECT 1 FROM email_relay_nonces WHERE nonce = ${n}`,
    );
    expect(rows).toHaveLength(0);
    // A second life for the same value once the first has lapsed.
    expect(await rememberRelayNonce(n, Date.now() - 600_000, 300_000)).toBe(true);
    expect(await rememberRelayNonce(n, Date.now(), 300_000)).toBe(true);
    expect(await rememberRelayNonce(n, Date.now(), 300_000)).toBe(false);
  });
});
