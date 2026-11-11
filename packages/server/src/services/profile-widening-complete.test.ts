/**
 * Permission widening is an allow-list: every field of every tool says which
 * values are safe, and anything else needs the owner's browser approval and is
 * stripped from checkout without it. Generated from `HARNESSES`, so a field added
 * later is covered the moment it exists. Includes the booleans the first version
 * missed (Gemini `sandbox: false`, Cursor `readonly: false`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, and } from 'drizzle-orm';
import {
  HARNESSES,
  HARNESS_IDS,
  checkoutSchema,
  fieldWidens,
  type Harness,
  type ProfileField,
  type ProfileSettings,
} from '@onmyradar/contract';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import type { Actor } from '../http.js';
import {
  acceptShare,
  checkoutAgent,
  createRepoAgent,
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

/** One safe and every unsafe value a field can be set to, derived from its definition. */
function candidates(field: ProfileField): {
  safe: Array<string | boolean>;
  unsafe: Array<string | boolean>;
} {
  const values: Array<string | boolean> =
    field.control === 'toggle'
      ? [true, false]
      : field.control === 'text'
        ? ['Read', 'Bash(git *)']
        : field.control === 'model'
          ? ['some-model']
          : (field.options ?? []).map((o) => o.value);
  return {
    safe: values.filter((v) => !fieldWidens(field, v)),
    unsafe: values.filter((v) => fieldWidens(field, v)),
  };
}

const fields = HARNESS_IDS.flatMap((harness) =>
  HARNESSES[harness].fields.map((field) => ({ harness, field })),
);
const unsafeCases = fields.flatMap(({ harness, field }) =>
  candidates(field).unsafe.map((value) => ({ harness, field, value })),
);
const safeCases = fields.flatMap(({ harness, field }) =>
  candidates(field).safe.map((value) => ({ harness, field, value })),
);

const checkout = (actor: Actor, agent: string, harness: Harness) =>
  checkoutAgent(actor, agent, checkoutSchema.parse({ harness, mode: HARNESSES[harness].modes[0] }));

describe.skipIf(!hasDatabase)('the widening allow-list, every field of every tool', () => {
  let owner: Actor;
  let collaborator: Actor;
  let agentId: string;

  beforeAll(async () => {
    await runMigrations();
    owner = await makeUser('wdc-owner');
    collaborator = await makeUser('wdc-collab');
    const agent = await createRepoAgent(owner, { name: `Allow-list ${rnd()}` });
    agentId = agent.id;
    await shareAgent(owner, agent.id, { email: collaborator.user.email, preset: 'edit' });
    await acceptShare(collaborator, agent.id);
  }, 30_000);
  afterAll(async () => {
    await closeDb();
  });

  it('classifies something unsafe for the fields that matter, including the booleans', () => {
    const named = unsafeCases.map((c) => `${c.harness}.${c.field.key}=${String(c.value)}`);
    expect(named).toEqual(
      expect.arrayContaining([
        'gemini-cli.sandbox=false',
        'cursor.readonly=false',
        'gemini-cli.approvalMode=auto_edit',
        'codex.sandbox_mode=danger-full-access',
        'codex.approval_policy=never',
        'claude-code.permissionMode=bypassPermissions',
        'claude-code.tools=Bash(git *)',
        'zed.toolPermissions=allow',
      ]),
    );
  });

  it.each(unsafeCases)(
    '$harness.$field.key=$value: a collaborator is refused, the owner’s browser approves it, checkout strips it until then',
    async ({ harness, field, value }) => {
      const settings: ProfileSettings = { [field.key]: value };
      await expect(setProfile(collaborator, agentId, harness, { settings })).rejects.toMatchObject({
        status: 403,
      });

      // Stored without a recorded decision (an old row, or a write that bypassed the guard):
      // checkout leaves it out and says why.
      await getDb()
        .insert(schema.agentProfiles)
        .values({ agentId, harness, settings, approvedWidening: {} })
        .onConflictDoUpdate({
          target: [schema.agentProfiles.agentId, schema.agentProfiles.harness],
          set: { settings, approvedWidening: {} },
        });
      const stripped = await checkout(owner, agentId, harness);
      expect(stripped.profile?.settings ?? {}).not.toHaveProperty(field.key);
      expect(stripped.withheld.join('\n')).toContain(field.label);

      // The owner approves it from a browser session.
      await setProfile(owner, agentId, harness, { settings });
      const [row] = await getDb()
        .select()
        .from(schema.agentProfiles)
        .where(
          and(eq(schema.agentProfiles.agentId, agentId), eq(schema.agentProfiles.harness, harness)),
        );
      expect(row?.approvedWidening).toEqual({ [field.key]: String(value) });
      const approved = await checkout(owner, agentId, harness);
      expect(approved.profile?.settings).toMatchObject(settings);

      // …but never onto the collaborator's machine.
      const theirs = await checkout(collaborator, agentId, harness);
      expect(theirs.profile?.settings ?? {}).not.toHaveProperty(field.key);
    },
  );

  it.each(safeCases)(
    '$harness.$field.key=$value: safe, so a collaborator may set it and checkout keeps it',
    async ({ harness, field, value }) => {
      const settings: ProfileSettings = { [field.key]: value };
      await setProfile(collaborator, agentId, harness, { settings });
      const result = await checkout(owner, agentId, harness);
      expect(result.profile?.settings).toMatchObject(settings);
      expect(result.withheld).toEqual([]);
    },
  );
});
