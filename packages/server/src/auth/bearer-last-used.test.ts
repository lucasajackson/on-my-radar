import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { must } from '../errors.js';
import { resolveBearerToken } from './bearer.js';
import { hashSecret, newApiToken } from './crypto.js';

const hasDatabase = Boolean(process.env['DATABASE_URL']);
process.env['SESSION_SECRET'] ??= 'test-only-session-secret-not-used-anywhere-else';

describe.skipIf(!hasDatabase)('last_used_at on bearer requests', () => {
  let tokenId: string;
  let token: string;
  beforeAll(async () => {
    await runMigrations();
    const user = must(
      (
        await getDb()
          .insert(schema.users)
          .values({ email: `lastused-${randomUUID()}@example.test`, state: 'active' })
          .returning()
      )[0],
    );
    token = newApiToken();
    tokenId = must(
      (
        await getDb()
          .insert(schema.apiTokens)
          .values({
            userId: user.id,
            name: 'pat',
            prefix: token.slice(0, 14),
            tokenHash: hashSecret(token),
          })
          .returning()
      )[0],
    ).id;
  }, 30_000);
  afterAll(closeDb);

  const lastUsed = async () =>
    must(
      (
        await getDb()
          .select({ at: schema.apiTokens.lastUsedAt })
          .from(schema.apiTokens)
          .where(eq(schema.apiTokens.id, tokenId))
      )[0],
    ).at;
  const settle = () => new Promise((r) => setTimeout(r, 150));

  it('writes on first use, not again inside a minute, and again once it is a minute old', async () => {
    expect(await lastUsed()).toBeNull();
    await resolveBearerToken(token);
    await settle();
    const first = must(await lastUsed());
    await new Promise((r) => setTimeout(r, 30));
    for (let i = 0; i < 5; i++) await resolveBearerToken(token);
    await settle();
    expect(must(await lastUsed()).getTime()).toBe(first.getTime());

    const old = new Date(Date.now() - 120_000);
    await getDb()
      .update(schema.apiTokens)
      .set({ lastUsedAt: old })
      .where(eq(schema.apiTokens.id, tokenId));
    await resolveBearerToken(token);
    await settle();
    expect(must(await lastUsed()).getTime()).toBeGreaterThan(old.getTime() + 100_000);
  });
});
