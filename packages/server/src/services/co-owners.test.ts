/**
 * "Should an agent with manage rights be able to demote a co-owner? No." —
 * the owner, 2026-09-26.
 *
 * An agent may not grant `owner` (`shareRadar` already refused that); these
 * are the other half: it may not demote a co-owner, remove one, or change or
 * revoke a pending invitation to co-own. Each refusal is asserted with its
 * control — the same act from the person still works, and the agent still
 * manages viewers and editors — and once over the wire with a real PAT, because
 * the refusal lives in the service and REST reaches it with a bearer token.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { hashSecret, newApiToken, tokenPrefix } from '../auth/crypto.js';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import type { Actor } from '../http.js';
import { createRadar, removeMember, revokeInvite, shareRadar } from './radars.js';

const hasDatabase = Boolean(process.env['DATABASE_URL']);
process.env['SESSION_SECRET'] ??= 'test-only-session-secret-not-used-anywhere-else';

async function makeUser(label: string): Promise<Actor> {
  const [user] = await getDb()
    .insert(schema.users)
    .values({
      email: `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
      state: 'active',
    })
    .returning();
  if (!user) throw new Error('user insert returned no row');
  return { user, kind: 'user' };
}

async function refusal(fn: () => Promise<unknown>): Promise<Error & { status?: number }> {
  try {
    await fn();
  } catch (err) {
    return err as Error & { status?: number };
  }
  throw new Error('expected a refusal, but the call succeeded');
}

describe.skipIf(!hasDatabase)('an agent cannot change a radar’s co-owners (real postgres)', () => {
  let owner: Actor;
  let agent: Actor;
  let coOwner: Actor;
  let editor: Actor;
  let radarId: string;

  const roleOf = async (userId: string) =>
    (
      await getDb()
        .select({ role: schema.radarMembers.role })
        .from(schema.radarMembers)
        .where(
          and(eq(schema.radarMembers.radarId, radarId), eq(schema.radarMembers.userId, userId)),
        )
    )[0]?.role ?? null;

  beforeAll(async () => {
    await runMigrations();
    owner = await makeUser('co-owner-owner');
    coOwner = await makeUser('co-owner-co');
    editor = await makeUser('co-owner-editor');
    // Full manage rights: the ceiling is not what refuses these.
    agent = { ...owner, kind: 'agent', ceiling: 'owner', tokenId: 'test' };
    radarId = (await createRadar(owner, { name: 'Co-owned' })).id;
    await shareRadar(owner, radarId, coOwner.user.email, 'owner');
    await shareRadar(owner, radarId, editor.user.email, 'editor');
  }, 30_000);

  afterAll(async () => {
    await closeDb();
  });

  it('refuses to demote a co-owner, saying why', async () => {
    const err = await refusal(() => shareRadar(agent, radarId, coOwner.user.email, 'viewer'));
    expect(err.status).toBe(403);
    expect(err.message).toMatch(/co-owns "Co-owned".*user’s decision/);
    expect(await roleOf(coOwner.user.id)).toBe('owner');
  });

  it('refuses to remove a co-owner', async () => {
    const err = await refusal(() => removeMember(agent, radarId, coOwner.user.id));
    expect(err.status).toBe(403);
    expect(await roleOf(coOwner.user.id)).toBe('owner');
  });

  it('refuses to downgrade or revoke a pending invitation to co-own', async () => {
    const invitee = `co-owner-invitee-${Date.now()}@example.test`;
    await shareRadar(owner, radarId, invitee, 'owner');
    const pending = async () =>
      (
        await getDb()
          .select({ role: schema.radarInvites.role })
          .from(schema.radarInvites)
          .where(
            and(
              eq(schema.radarInvites.radarId, radarId),
              eq(schema.radarInvites.email, invitee),
              isNull(schema.radarInvites.acceptedAt),
            ),
          )
      )[0]?.role;
    expect((await refusal(() => shareRadar(agent, radarId, invitee, 'viewer'))).status).toBe(403);
    expect((await refusal(() => revokeInvite(agent, radarId, invitee))).status).toBe(403);
    expect(await pending()).toBe('owner');
    // Control: the person can take it back.
    await revokeInvite(owner, radarId, invitee);
    expect(await pending()).toBeUndefined();
  });

  it('still lets the agent manage viewers and editors, and the person manage everyone', async () => {
    await shareRadar(agent, radarId, editor.user.email, 'viewer');
    expect(await roleOf(editor.user.id)).toBe('viewer');
    await removeMember(agent, radarId, editor.user.id);
    expect(await roleOf(editor.user.id)).toBeNull();
    await shareRadar(owner, radarId, coOwner.user.email, 'editor');
    expect(await roleOf(coOwner.user.id)).toBe('editor');
    await shareRadar(owner, radarId, coOwner.user.email, 'owner');
  });

  it('refuses the same over REST with a personal access token', async () => {
    const token = newApiToken();
    await getDb()
      .insert(schema.apiTokens)
      .values({
        userId: owner.user.id,
        name: 'co-owner test',
        prefix: tokenPrefix(token),
        tokenHash: hashSecret(token),
      });
    const res = await createApp().request(`/api/radars/${radarId}/members/${coOwner.user.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/co-owns/);
    expect(await roleOf(coOwner.user.id)).toBe('owner');
  });
});
