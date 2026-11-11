/**
 * A tool profile may carry values that let the tool act without asking (Codex
 * `sandbox_mode=danger-full-access`, `approval_policy=never`, Claude Code
 * `permissionMode=bypassPermissions`). Those are the owner's to give their own
 * machines, from a browser — not a collaborator's with a prompt share, and not
 * an agent's, the owner's own included (a prompt-injected agent must not be able
 * to switch off its own sandbox). And checkout writes one only when the owner's
 * browser decision was recorded.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { TOKEN_SCOPES, checkoutSchema, type TokenScope } from '@onmyradar/contract';
import { hashSecret, newApiToken, tokenPrefix } from '../auth/crypto.js';
import { resolveBearerToken } from '../auth/bearer.js';
import { createSession, SESSION_COOKIE } from '../auth/session.js';
import { createApp } from '../app.js';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import type { Actor } from '../http.js';
import {
  acceptShare,
  checkoutAgent,
  createRepoAgent,
  duplicateAgent,
  importAgent,
  setProfile,
  shareAgent,
} from './repo-agents.js';

const hasDatabase = Boolean(process.env['DATABASE_URL']);
process.env['SESSION_SECRET'] ??= 'test-only-session-secret-not-used-anywhere-else';
const rnd = () => Math.random().toString(36).slice(2, 8);

async function makeUser(label: string): Promise<Actor> {
  const [user] = await getDb()
    .insert(schema.users)
    .values({ email: `${label}-${Date.now()}-${rnd()}@example.test`, state: 'active', name: label })
    .returning();
  if (!user) throw new Error('user insert returned no row');
  return { user, kind: 'user', sessionId: `web-${rnd()}`, viaCookie: true };
}

async function patFor(human: Actor, scopes: readonly TokenScope[] = TOKEN_SCOPES) {
  const secret = newApiToken();
  await getDb()
    .insert(schema.apiTokens)
    .values({
      userId: human.user.id,
      name: `pat ${rnd()}`,
      prefix: tokenPrefix(secret),
      tokenHash: hashSecret(secret),
      scope: scopes.join(' '),
    });
  const bearer = await resolveBearerToken(secret);
  if (!bearer) throw new Error('minted PAT does not resolve');
  const actor: Actor = {
    user: bearer.user,
    kind: 'agent',
    tokenId: bearer.tokenId,
    scopes: bearer.scopes,
    ceiling: bearer.ceiling,
    connection: bearer.connection,
  };
  return { secret, actor };
}

const checkout = (actor: Actor, agent: string, harness: string) =>
  checkoutAgent(actor, agent, checkoutSchema.parse({ harness, mode: 'helper' }));

const CODEX_WIDE = { sandbox_mode: 'danger-full-access', approval_policy: 'never' } as const;

describe.skipIf(!hasDatabase)('permission-widening profile values (real postgres)', () => {
  let owner: Actor;
  let collaborator: Actor;

  beforeAll(async () => {
    await runMigrations();
    owner = await makeUser('wd-owner');
    collaborator = await makeUser('wd-collab');
  }, 30_000);
  afterAll(async () => {
    await closeDb();
  });

  async function sharedAgent() {
    const agent = await createRepoAgent(owner, { name: `Widen ${rnd()}` });
    await shareAgent(owner, agent.id, { email: collaborator.user.email, preset: 'edit' });
    await acceptShare(collaborator, agent.id);
    return agent;
  }

  it('refuses a collaborator with a prompt share, over the service and REST', async () => {
    const agent = await sharedAgent();
    await expect(
      setProfile(collaborator, agent.id, 'codex', { settings: { ...CODEX_WIDE } }),
    ).rejects.toMatchObject({ status: 403 });
    const { secret } = await patFor(collaborator);
    const res = await createApp().request(`/api/repo-agents/${agent.id}/profiles/codex`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ settings: { ...CODEX_WIDE } }),
    });
    expect(res.status).toBe(403);
    // Not even through the collaborator's browser session: the owner decides.
    const session = await createSession(collaborator.user);
    const viaBrowser = await createApp().request(`/api/repo-agents/${agent.id}/profiles/codex`, {
      method: 'PUT',
      headers: { cookie: `${SESSION_COOKIE}=${session.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ settings: { sandbox_mode: 'danger-full-access' } }),
    });
    expect(viaBrowser.status).toBe(403);
    // A narrower profile is still theirs to write.
    await setProfile(collaborator, agent.id, 'codex', {
      settings: { sandbox_mode: 'workspace-write' },
    });
  });

  it('refuses the owner’s own agent connection', async () => {
    const agent = await createRepoAgent(owner, { name: `Own agent ${rnd()}` });
    const { actor } = await patFor(owner);
    await expect(
      setProfile(actor, agent.id, 'codex', { settings: { ...CODEX_WIDE } }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      setProfile(actor, agent.id, 'claude-code', {
        settings: { permissionMode: 'bypassPermissions' },
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('lets the owner’s browser session set them, and checkout then writes them', async () => {
    const agent = await createRepoAgent(owner, { name: `Browser ${rnd()}` });
    await setProfile(owner, agent.id, 'codex', { settings: { ...CODEX_WIDE } });
    await setProfile(owner, agent.id, 'claude-code', {
      settings: { permissionMode: 'bypassPermissions' },
    });
    const codex = await checkout(owner, agent.id, 'codex');
    expect(codex.profile?.settings).toMatchObject(CODEX_WIDE);
    expect(codex.withheld).toEqual([]);
    const claude = await checkout(owner, agent.id, 'claude-code');
    expect(claude.profile?.settings).toMatchObject({ permissionMode: 'bypassPermissions' });
  });

  it('drops the approval with the value when the owner saves something narrower', async () => {
    const agent = await createRepoAgent(owner, { name: `Narrow ${rnd()}` });
    await setProfile(owner, agent.id, 'codex', { settings: { ...CODEX_WIDE } });
    await setProfile(owner, agent.id, 'codex', { settings: { sandbox_mode: 'read-only' } });
    const [row] = await getDb()
      .select()
      .from(schema.agentProfiles)
      .where(eq(schema.agentProfiles.agentId, agent.id));
    expect(row?.approvedWidening).toEqual({});
    // A value written back by SQL (the way nothing in the app can) is unattributed.
    await getDb()
      .update(schema.agentProfiles)
      .set({ settings: { ...CODEX_WIDE } })
      .where(eq(schema.agentProfiles.agentId, agent.id));
    const stripped = await checkout(owner, agent.id, 'codex');
    expect(stripped.profile?.settings).toEqual({});
  });

  it('strips a legacy profile’s widening values at the owner’s checkout, and says why', async () => {
    const agent = await createRepoAgent(owner, { name: `Legacy ${rnd()}` });
    await getDb()
      .insert(schema.agentProfiles)
      .values({
        agentId: agent.id,
        harness: 'codex',
        settings: { ...CODEX_WIDE, model: 'gpt-5.5' },
        updatedBy: owner.user.id,
      });
    const out = await checkout(owner, agent.id, 'codex');
    expect(out.profile?.settings).not.toHaveProperty('sandbox_mode');
    expect(out.profile?.settings).not.toHaveProperty('approval_policy');
    expect(out.profile?.settings).toMatchObject({ model: 'gpt-5.5' });
    expect(out.withheld.join('\n')).toMatch(/Full disk access/);
    expect(out.withheld.join('\n')).toMatch(/has not approved/);
    for (const op of out.operations)
      if ('content' in op) expect(op.content).not.toMatch(/danger-full-access/);
    // Saving it from the browser is the approval.
    await setProfile(owner, agent.id, 'codex', {
      settings: { ...CODEX_WIDE, model: 'gpt-5.5' },
    });
    const approved = await checkout(owner, agent.id, 'codex');
    expect(approved.profile?.settings).toMatchObject(CODEX_WIDE);
  });

  it('never gives a recipient an approved value either', async () => {
    const agent = await sharedAgent();
    await setProfile(owner, agent.id, 'codex', { settings: { ...CODEX_WIDE } });
    const theirs = await checkout(collaborator, agent.id, 'codex');
    expect(theirs.profile?.settings).toEqual({});
    expect(theirs.withheld.join('\n')).toMatch(/only applied on the owner/);
  });

  it('drops widening values from an import, and from a copy the owner’s agent connection makes', async () => {
    const { actor } = await patFor(owner);
    const imported = await importAgent(owner, {
      name: `Imported ${rnd()}`,
      profiles: { codex: { ...CODEX_WIDE, model: 'gpt-5.5' } },
      memories: [],
      briefs: [],
    });
    const [row] = await getDb()
      .select()
      .from(schema.agentProfiles)
      .where(
        and(
          eq(schema.agentProfiles.agentId, imported.id),
          eq(schema.agentProfiles.harness, 'codex'),
        ),
      );
    expect(row?.settings).toEqual({ model: 'gpt-5.5' });
    expect(row?.approvedWidening).toEqual({});

    const source = await createRepoAgent(owner, { name: `Source ${rnd()}` });
    await setProfile(owner, source.id, 'codex', { settings: { ...CODEX_WIDE } });
    const copy = await duplicateAgent(actor, source.id);
    const [copied] = await getDb()
      .select()
      .from(schema.agentProfiles)
      .where(eq(schema.agentProfiles.agentId, copy.id));
    expect(copied?.settings).toEqual({});
    await expect(
      createRepoAgent(actor, { name: `Create ${rnd()}`, profiles: { codex: { ...CODEX_WIDE } } }),
    ).rejects.toMatchObject({ status: 403 });
  });
});
