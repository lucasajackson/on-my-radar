import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { must } from '../errors.js';
import type { Actor } from '../http.js';
import { hashSecret, newApiToken, tokenPrefix } from '../auth/crypto.js';
import { resolveBearerToken } from '../auth/bearer.js';
import { createRepoAgent, rejectPromptProposal, updatePrompt } from './repo-agents.js';
import { createRadar } from './radars.js';
import { createBlip } from './blips.js';
import { createComment } from './comments.js';
import { listNotifications, notificationCounts } from './notifications.js';

const hasDatabase = Boolean(process.env['DATABASE_URL']);
process.env['SESSION_SECRET'] ??= 'synthetic-notification-proposals-secret';

describe.skipIf(!hasDatabase)('pending prompt proposals in Needs you', () => {
  beforeAll(async () => {
    await runMigrations();
  }, 30_000);
  afterAll(closeDb);

  async function fixture() {
    const db = getDb();
    const [user] = await db
      .insert(schema.users)
      .values({ email: `proposals-${randomUUID()}@example.test`, name: 'Lucas', state: 'active' })
      .returning();
    const human: Actor = { user: must(user), kind: 'user', viaCookie: true };
    await db
      .insert(schema.userNotificationSettings)
      .values({ userId: human.user.id, emailEnabled: false, pushEnabled: false });
    const agent = await createRepoAgent(human, { name: 'Lulu' });
    const secret = newApiToken();
    await db.insert(schema.apiTokens).values({
      userId: human.user.id,
      name: 'synthetic',
      prefix: tokenPrefix(secret),
      tokenHash: hashSecret(secret),
      agentId: agent.id,
      voiceGrants: ['persona', 'principal'],
      defaultVoice: 'persona',
    });
    const actor: Actor = { ...must(await resolveBearerToken(secret)), kind: 'agent' };
    return { human, agent, actor };
  }

  it('shows a self-edit proposal to the owner, counts it, and drops it on reject', async () => {
    const f = await fixture();
    const held = await updatePrompt(f.actor, f.agent.id, { body: 'new prompt', basedOn: 0 });
    expect('proposalId' in held).toBe(true);

    const page = await listNotifications(f.human, { box: 'needs_you' });
    expect(page.pendingProposals).toMatchObject([{ agentId: f.agent.id, agentName: 'Lulu' }]);
    expect(await notificationCounts(f.human)).toMatchObject({ total: 1, proposals: 1 });
    expect((await notificationCounts(f.human, 'agents_reported')).total).toBe(0);
    expect(
      (await listNotifications(f.human, { box: 'agents_reported' })).pendingProposals,
    ).toBeUndefined();

    const id = must(page.pendingProposals?.[0]).id;
    await rejectPromptProposal(f.human, f.agent.id, id);
    expect((await listNotifications(f.human, { box: 'needs_you' })).pendingProposals).toEqual([]);
    expect(await notificationCounts(f.human)).not.toHaveProperty('proposals');
    expect((await notificationCounts(f.human)).total).toBe(0);
  });

  it('never appears in an agent session’s own queue or counts', async () => {
    const f = await fixture();
    await updatePrompt(f.actor, f.agent.id, { body: 'new prompt', basedOn: 0 });
    expect((await listNotifications(f.actor)).pendingProposals).toBeUndefined();
    expect((await notificationCounts(f.actor)).total).toBe(0);
  });

  it('keeps parentheses and colons in a notification excerpt', async () => {
    const f = await fixture();
    const radar = await createRadar(f.human, { name: 'Excerpts' });
    const blip = await createBlip(f.human, radar.id, { body: 'a thought' });
    await createComment(f.actor, blip.id, {
      body: 'EVAL TEST (sandbox): x [a link](https://e.test/p)',
    });
    const item = must((await listNotifications(f.human)).items.find((n) => n.kind === 'comment'));
    expect(item.excerpt).toBe('EVAL TEST (sandbox): x a link');
  });
});
