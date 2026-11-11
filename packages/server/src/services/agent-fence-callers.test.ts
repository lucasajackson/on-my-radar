/**
 * Who may ask for "the radars this person reaches" without the agent's limit.
 *
 * The limit (`fenceCaps`, `services/access.ts`) is applied by the actor-taking entry points.
 * The userId-taking ones (`readableRadarIds`, `readableRadarQuery`, the `unfenced…` pair) know
 * nobody's connection, so a new caller that has an actor and reaches for one of them would
 * quietly hand a limited agent every radar its owner has. This pins the callers that are
 * known to be right; a new one fails here until somebody says why it is safe.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = new URL('..', import.meta.url).pathname;
const CALL =
  /\b(readableRadarIds|readableRadarQuery|unfencedReadableRadarQuery|readableTopicQuery|unfencedReadableTopicQuery)\(/g;

/** file → the userId-taking functions it may call, and why that is safe. */
const REVIEWED: Record<string, { calls: string[]; why: string }> = {
  'services/account-export-collector.ts': {
    calls: ['readableRadarIds'],
    why: 'the owner’s own export, session-only (requireUser); no connection is involved',
  },
  'services/notifications.ts': {
    calls: ['readableRadarQuery', 'readableTopicQuery'],
    why: 'notificationAccess layers the actor’s fence on top (fenceOf); the same function serves the delivery workers, which act for a recipient',
  },
  'services/decision-live.ts': {
    calls: ['readableRadarQuery'],
    why: 'readDecisionRequestsFor takes the limited agent’s fence as an argument (listNotifications passes fenceOf); the delivery workers calling it act for a recipient with no connection',
  },
  'services/reminders.ts': {
    calls: ['readableRadarQuery'],
    why: 'the reminder sweep runs for the person who set it, in the worker, with no connection',
  },
  'services/radars.ts': {
    calls: ['unfencedReadableRadarQuery'],
    why: 'listRadars intersects it with fenceCaps and caps each role by the grant',
  },
  'services/topics.ts': {
    calls: ['unfencedReadableTopicQuery'],
    why: 'listTopics returns nothing to a limited agent before it gets here (topicsWithheld)',
  },
  'services/repo-agents.ts': {
    calls: ['unfencedReadableTopicQuery'],
    why: 'which shared agents a topic membership reaches: agent access, not radar content',
  },
  'services/search.ts': {
    calls: ['readableTopicQuery'],
    why: 'searchTopicNames returns nothing to a limited agent before it gets here (topicsWithheld)',
  },
};

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

describe('callers of the userId-based readable sets', () => {
  it('are exactly the reviewed ones', () => {
    const found: Record<string, string[]> = {};
    for (const file of sources(SRC)) {
      const name = relative(SRC, file);
      if (name === 'services/access.ts') continue;
      const text = readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => !/^\s*(\*|\/\/|import)/.test(line))
        .join('\n');
      const calls = [...new Set([...text.matchAll(CALL)].map((m) => m[1] as string))].sort();
      if (calls.length) found[name] = calls;
    }
    expect(found).toEqual(
      Object.fromEntries(Object.entries(REVIEWED).map(([f, r]) => [f, [...r.calls].sort()])),
    );
  });
});

/**
 * Who may read a topic's own rows (its name, its members, its invites).
 *
 * A connection limited to selected radars reaches no topic, and that is enforced at each
 * reader, not in one place: `requireTopic` and `getTopicAccess` refuse, `listTopics` and the
 * name search return nothing, `listMembers` and the agent share listings leave the topic out.
 * A new file that reads these tables has not been through that, so it fails here until somebody
 * says what keeps a limited agent out.
 */
const TOPIC_READ =
  /schema\.(topics|topicMembers|topicInvites)\b|\b(FROM|JOIN) (topics|topic_members)\b|\btopics t\b|topic_members m\b/;

const TOPIC_READERS: Record<string, string> = {
  'services/invites.ts': 'an invitation is opened by the holder of its token, not by a connection',
  'services/notifications.ts':
    'a topic notification is excluded by notificationAccess under a fence (fenceOf)',
  'services/radars.ts':
    'listRadars withholds the topic (fence), and listMembers nulls viaTopic for a limited connection',
  'services/repo-agents.ts':
    'listShares and agentActivity leave topic shares out under topicsWithheld; the rest is agent access, not topic content',
  'services/search.ts': 'searchTopicNames returns nothing to a limited agent (topicsWithheld)',
  'services/topics.ts':
    'every entry point goes through requireTopic / getTopicAccess, which refuse',
};

describe('readers of the topic tables', () => {
  it('are exactly the reviewed ones', () => {
    const found: string[] = [];
    for (const file of sources(SRC)) {
      const name = relative(SRC, file);
      if (name === 'services/access.ts' || name === 'db/schema.ts') continue;
      if (name === 'services/account-export-tables.ts') continue;
      const text = readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => !/^\s*(\*|\/\/|import)/.test(line))
        .join('\n');
      if (TOPIC_READ.test(text)) found.push(name);
    }
    expect(found.sort()).toEqual(Object.keys(TOPIC_READERS).sort());
  });
});
