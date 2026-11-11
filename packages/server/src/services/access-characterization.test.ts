/* eslint-disable @typescript-eslint/restrict-template-expressions -- the cells are strings built from nullable roles and booleans on purpose: `null` and `false` are answers here */
/**
 * The access matrix, pinned (plan 161d7453, T2).
 *
 * Every existing way of reaching a radar, a topic or a shared agent, observed through every
 * door that decides it: the single lookup (`getRadarAccess`, `requireRadar` at all three
 * needs), the sidebar list, the readable-id set that search, dashboards and notifications
 * scope by, the people-shaped `radarReaders` that mentions and the notification audience use,
 * the topic and agent equivalents, and the helpdesk integration door.
 *
 * The expected answers are in `access-characterization.golden.json`, written once from the
 * code as it stood BEFORE the organization term landed in `access.ts`. Here every user is
 * alone in a personal home org, which is every account in production. The term must change
 * nothing for that data, so this file passing unmodified is the proof; a change to the golden
 * is a change to who may see what, and has to be argued as one.
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RadarRole } from '@onmyradar/contract';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { ApiError, type Actor } from '../http.js';
import { must } from '../errors.js';
import {
  getRadarAccess,
  getRepoAgentAccess,
  getTopicAccess,
  radarReaders,
  readableRadarIds,
  readableTopicQuery,
  reachableAgentQuery,
  requireHelpdeskRadar,
  requireRadar,
  requireTopic,
  type AccessNeed,
} from './access.js';
import { createIntegration, enrolRadar } from './integrations.js';
import { createRadar, listRadars, setVisibility, shareRadar } from './radars.js';
import { createRepoAgent, shareAgent, listRepoAgents } from './repo-agents.js';
import { createTopic, listTopics, setCascade, setRadarTopic, shareTopic } from './topics.js';

const hasDatabase = Boolean(process.env['DATABASE_URL']);
process.env['SESSION_SECRET'] ??= 'test-only-session-secret-not-used-anywhere-else';

const GOLDEN = new URL('./access-characterization.golden.json', import.meta.url);
const NEEDS: AccessNeed[] = ['read', 'write', 'manage'];
/** undefined is a browser session; the rest are bearer connections capped at that role. */
const CEILINGS: Array<RadarRole | undefined> = [undefined, 'viewer', 'editor', 'owner'];

async function makeUser(label: string): Promise<Actor> {
  const [user] = await getDb()
    .insert(schema.users)
    .values({ email: `${label.toLowerCase()}-${randomUUID()}@example.test`, state: 'active' })
    .returning();
  return { user: must(user), kind: 'user' };
}

const withCeiling = (actor: Actor, ceiling: RadarRole | undefined): Actor =>
  ceiling ? { ...actor, kind: 'agent', ceiling } : actor;

/** A credential minted for one of the person's agents: the bearer shape, ceiling and all. */
function boundCredential(base: Actor, agentId: string, ceiling: RadarRole): Actor {
  const tokenId = randomUUID();
  return {
    ...base,
    kind: 'agent',
    ceiling,
    tokenId,
    connection: { kind: 'pat', id: tokenId, label: null },
    agent: { agentId, ownerId: base.user.id, name: 'Bound', handle: 'bound' },
    radarFence: [agentId],
  };
}

async function status(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'ok';
  } catch (err) {
    if (err instanceof ApiError) return String(err.status);
    throw err;
  }
}

/** Everything the single lookup says about one radar for one caller, flattened to a cell. */
async function answerFor(ident: string, actor: Actor | null): Promise<string> {
  const a = await getRadarAccess(ident, actor);
  // A radar the caller may not read is no access at all, whatever the lookup returns.
  if (!a?.canRead) return 'none';
  const needs = await Promise.all(
    NEEDS.map(async (need) => `${need}:${await status(() => requireRadar(ident, actor, need))}`),
  );
  return [
    `role=${a.role}`,
    `direct=${a.directRole}`,
    `topic=${a.topicRole}`,
    `via=${a.via}`,
    `public=${a.viaPublicLink}`,
    `topicVisible=${a.topicVisible}`,
    `can=${a.canRead}/${a.canWrite}/${a.canManage}`,
    needs.join(','),
  ].join(' ');
}

describe.skipIf(!hasDatabase)('access matrix, characterized (real postgres)', () => {
  const users = new Map<string, Actor>();
  const radars = new Map<string, string>();
  const slugs = new Map<string, string>();
  const topics = new Map<string, string>();
  let agentId = '';
  let integrationActor: Actor;
  const who = (id: string) => [...users].find(([, a]) => a.user.id === id)?.[0] ?? id;

  beforeAll(async () => {
    await runMigrations();
    for (const label of [
      'owner',
      'memberViewer',
      'memberEditor',
      'memberOwner',
      'topicViewer',
      'topicEditor',
      'topicPlain',
      'stranger',
    ])
      users.set(label, await makeUser(label));
    const owner = must(users.get('owner'));
    const u = (label: string) => must(users.get(label));

    // Two topics: one that cascades, one that only groups.
    const cascading = await createTopic(owner, { name: 'Cascading' });
    const plain = await createTopic(owner, { name: 'Plain' });
    topics.set('cascading', cascading.id);
    topics.set('plain', plain.id);
    await setCascade(owner, cascading.id, true);
    await shareTopic(owner, cascading.id, u('topicViewer').user.email, 'viewer');
    await shareTopic(owner, cascading.id, u('topicEditor').user.email, 'editor');
    await shareTopic(owner, plain.id, u('topicViewer').user.email, 'viewer');
    await shareTopic(owner, plain.id, u('topicPlain').user.email, 'viewer');

    const make = async (label: string, template: string | undefined, topic?: string) => {
      const radar = await createRadar(owner, { name: label, ...(template ? { template } : {}) });
      radars.set(label, radar.id);
      if (topic) await setRadarTopic(owner, radar.id, must(topics.get(topic)));
      return radar.id;
    };
    await make('private-plain', undefined);
    await make('private-cascading', undefined, 'cascading');
    await make('private-grouped', undefined, 'plain');
    await make('public-plain', undefined);
    await make('public-cascading', undefined, 'cascading');
    await make('helpdesk', 'helpdesk');
    for (const label of ['public-plain', 'public-cascading']) {
      const published = await setVisibility(owner, must(radars.get(label)), 'public');
      slugs.set(label, must(published.publicSlug));
    }
    // Direct grants on every radar, at every role.
    for (const id of radars.values()) {
      await shareRadar(owner, id, u('memberViewer').user.email, 'viewer');
      await shareRadar(owner, id, u('memberEditor').user.email, 'editor');
      await shareRadar(owner, id, u('memberOwner').user.email, 'owner');
    }

    // An agent shared to a person and to a cascading topic.
    const agent = await createRepoAgent(owner, { name: 'Matrix agent', prompt: 'p' });
    agentId = agent.id;
    await shareAgent(owner, agentId, { email: u('memberViewer').user.email, preset: 'use' });
    await shareAgent(owner, agentId, { topicId: cascading.id, preset: 'edit' });

    // The helpdesk door: the owner's integration, enrolled on the helpdesk radar only.
    const integration = await createIntegration(owner, { name: 'portal' });
    await enrolRadar(owner, integration.id, { radarId: must(radars.get('helpdesk')) });
    integrationActor = {
      user: owner.user,
      kind: 'integration',
      integrationId: integration.id,
      ceiling: 'editor',
    };
  }, 120_000);

  afterAll(async () => {
    await closeDb();
  });

  it('answers every existing access question exactly as it did before organizations', async () => {
    const out: Record<string, string> = {};
    const actors: Array<[string, Actor | null]> = [
      ...[...users].map(([label, actor]) => [label, actor] as [string, Actor]),
      ['anonymous', null],
    ];

    // Single radar: by id and, for the published ones, by public slug, for each connection.
    for (const [label, base] of actors) {
      for (const ceiling of base ? CEILINGS : [undefined]) {
        const actor = base ? withCeiling(base, ceiling) : null;
        for (const [radarLabel, radarId] of radars) {
          const idents: Array<[string, string]> = [['id', radarId]];
          const slug = slugs.get(radarLabel);
          if (slug) idents.push(['slug', slug]);
          for (const [how, ident] of idents) {
            out[`radar/${label}/${ceiling ?? 'session'}/${radarLabel}/${how}`] = await answerFor(
              ident,
              actor,
            );
          }
        }
      }
    }

    // The sets: what search, dashboards and the sidebar are scoped by.
    for (const [label, base] of actors) {
      if (!base) continue;
      const readable = new Set(await readableRadarIds(base.user.id));
      const topicsReadable = new Set((await readableTopicQuery(base.user.id)).map((row) => row.id));
      for (const ceiling of CEILINGS) {
        const listed = await listRadars(withCeiling(base, ceiling), { includeArchived: true });
        for (const [radarLabel, radarId] of radars) {
          const row = listed.find((r) => r.id === radarId);
          const key = `list/${label}/${ceiling ?? 'session'}/${radarLabel}`;
          out[key] = row
            ? `listed role=${row.access.role} via=${row.access.via} direct=${row.access.directRole} ` +
              `topic=${row.access.topicRole} topicShown=${row.topic?.name ?? null} ` +
              `members=${row.memberCount} can=${row.access.canRead}/${row.access.canWrite}/${row.access.canManage}`
            : 'absent';
        }
      }
      for (const [radarLabel, radarId] of radars)
        out[`readable/${label}/${radarLabel}`] = String(readable.has(radarId));
      const listedTopics = await listTopics(base, { includeArchived: true });
      for (const [topicLabel, topicId] of topics) {
        const row = listedTopics.find((t) => t.id === topicId);
        out[`topic-list/${label}/${topicLabel}`] = row
          ? `listed role=${row.access.role} can=${row.access.canWrite}/${row.access.canManage}`
          : 'absent';
        out[`topic-readable/${label}/${topicLabel}`] = String(topicsReadable.has(topicId));
        for (const ceiling of CEILINGS) {
          const actor = withCeiling(base, ceiling);
          const a = await getTopicAccess(topicId, actor);
          const needs = await Promise.all(
            NEEDS.map(
              async (need) => `${need}:${await status(() => requireTopic(topicId, actor, need))}`,
            ),
          );
          out[`topic/${label}/${ceiling ?? 'session'}/${topicLabel}`] = a?.canRead
            ? `role=${a.role} can=${a.canRead}/${a.canWrite}/${a.canManage} ${needs.join(',')}`
            : 'none';
        }
      }
    }

    // The people-shaped answer: who a mention may name and who a notification reaches.
    for (const [radarLabel, radarId] of radars) {
      const [row] = await getDb().select().from(schema.radars).where(eq(schema.radars.id, radarId));
      const readers = await radarReaders(must(row));
      out[`readers/${radarLabel}`] = readers
        .map((r) => who(r.id))
        .sort()
        .join(',');
    }

    // The helpdesk door, as the integration, on every radar.
    for (const [radarLabel, radarId] of radars) {
      out[`helpdesk-door/${radarLabel}`] = await status(() =>
        requireHelpdeskRadar(radarId, integrationActor),
      );
      out[`integration-lookup/${radarLabel}`] = String(
        (await getRadarAccess(radarId, integrationActor)) !== null,
      );
      out[`guest-lookup/${radarLabel}`] = String(
        (await getRadarAccess(radarId, { ...must(users.get('owner')), kind: 'guest' })) !== null,
      );
    }

    // A shared agent: owner, the person it was shared with, and a cascading topic's members.
    for (const [label, base] of actors) {
      if (!base) continue;
      for (const ceiling of CEILINGS) {
        const actor = withCeiling(base, ceiling);
        const a = await getRepoAgentAccess(agentId, actor);
        out[`agent/${label}/${ceiling ?? 'session'}`] = a
          ? `via=${a.via} prompt=${a.prompt} memory=${a.memory} manage=${a.canManage}`
          : 'none';
      }
      const reachable = (await reachableAgentQuery(base.user.id)).map((r) => r.id);
      out[`agent-reachable/${label}`] = String(reachable.includes(agentId));
      for (const view of ['mine', 'shared'] as const)
        out[`agent-list/${label}/${view}`] = String(
          (await listRepoAgents(base, { view })).some((a) => a.id === agentId),
        );
    }

    // The same people on a credential minted for one of their own agents (`radar_scope` is
    // its default, `all`). The agent is a persona, not a boundary, so every cell must equal the
    // plain connection's at that ceiling: the proof that least privilege changes nothing until
    // somebody selects radars.
    for (const [label, base] of actors) {
      if (!base) continue;
      const own = await createRepoAgent(base, { name: `Bound ${label}`, prompt: 'p' });
      for (const ceiling of CEILINGS) {
        if (!ceiling) continue;
        const actor = boundCredential(base, own.id, ceiling);
        for (const [radarLabel, radarId] of radars) {
          const idents: Array<[string, string]> = [['id', radarId]];
          const slug = slugs.get(radarLabel);
          if (slug) idents.push(['slug', slug]);
          for (const [how, ident] of idents) {
            const cell = await answerFor(ident, actor);
            out[`bound/${label}/${ceiling}/${radarLabel}/${how}`] = cell;
            expect(cell, `bound ${label}/${ceiling}/${radarLabel}/${how}`).toBe(
              out[`radar/${label}/${ceiling}/${radarLabel}/${how}`],
            );
          }
        }
        const listed = await listRadars(actor, { includeArchived: true });
        for (const [radarLabel, radarId] of radars) {
          const row = listed.find((r) => r.id === radarId);
          out[`bound-list/${label}/${ceiling}/${radarLabel}`] = row
            ? `listed role=${row.access.role} can=${row.access.canRead}/${row.access.canWrite}/${row.access.canManage}`
            : 'absent';
        }
      }
    }

    const actual = Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
    // Radar and topic ids never enter a key or a value, so the golden is stable between runs.
    expect(Object.keys(actual).length).toBeGreaterThan(600);
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, string>;
    expect(actual).toEqual(golden);
  }, 300_000);
});
