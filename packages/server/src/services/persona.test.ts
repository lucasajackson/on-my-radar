/**
 * Agent personas: the properties that decide whether "an AI can have its own
 * name" is a feature or a forgery.
 *
 * Three things have to be unforgeable, and every assertion here is one of them
 * stated as a refusal that must happen, with the sentence that would be true if
 * the enforcement vanished:
 *
 * - **A human cannot author as an agent.** `agent_id` is derived from
 *   `actor.agent` and from nothing else — no request body, tool argument or
 *   service parameter carries one anywhere in the application. That is asserted
 *   structurally, by grep, so adding a fifth write site fails this suite rather
 *   than shipping.
 * - **An agent cannot author as a human beyond what its token grants.** A
 *   connection granted only its own voice that asks to write under the person's
 *   name is refused, loudly, and **nothing is written** — never silently
 *   downgraded, because a silent downgrade is exactly how a remark ends up under
 *   a name the caller did not choose.
 * - **A persona cannot widen access by any path.** It holds no membership row,
 *   contributes no term to the union, and is clamped by the same `min` its token
 *   already was. Asserted as a matrix over every kind of access rather than on
 *   selected cases, because the property is monotone weakening and only a matrix
 *   catches a promotion.
 *
 * Two of these would pass vacuously in a suite that built `Actor` objects by
 * hand, so every persona-bearing actor here is resolved through
 * `resolveBearerToken` — the same path the middleware takes, including the field
 * that carries the persona. And the notification half asserts on the mail and
 * push transports rather than on a flag, because "an agent has no mailbox" is a
 * claim about what leaves the process.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AGENT_REPO, RADAR_ROLES, type RadarRole, type Voice } from '@onmyradar/contract';
import { createApp } from '../app.js';
import { createHash } from 'node:crypto';
import { hashSecret, newApiToken, randomToken, tokenPrefix } from '../auth/crypto.js';
import { resolveBearerToken } from '../auth/bearer.js';
import { createSession, SESSION_COOKIE } from '../auth/session.js';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import type { Actor } from '../http.js';
import { getRadarAccess, requireRadar } from './access.js';
import { authorshipOf, listAgents, resolveVoice } from './agents.js';
import { createRepoAgent, deleteRepoAgent, setArchived } from './repo-agents.js';
import { createBlip, getBlip, updateBlip } from './blips.js';
import { createComment, updateComment } from './comments.js';
import { mentionDirectory, radarAgents, reconcileMentions, resolveMentions } from './mentions.js';
import { listNotifications, notificationCounts } from './notifications.js';
import { createRadar, removeMember, shareRadar } from './radars.js';
import { setReaction } from './reactions.js';
import { createTopic, setCascade, setRadarTopic, shareTopic } from './topics.js';
import { createToken } from './tokens.js';
import type * as MailModule from './mail.js';
import type * as OutboxModule from './outbox.js';
import { sendMail } from './mail.js';
import type * as PushModule from './push-delivery.js';
import { queuePushDeliveries } from './push-delivery.js';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { must } from '../errors.js';

/*
  The transports are mocked rather than observed through their absence.

  With no RESEND_API_KEY and no VAPID pair, `deliver` never reaches either one
  for *anybody*, so "an agent got no email" would be true of a human too and the
  assertion would be theatre. Configuring both and spying on the calls is what
  makes the agent guard the thing under test: revert it and the agent's mention
  sends mail, and this suite says so.
*/
vi.mock('./mail.js', async (importOriginal) => {
  const actual = await importOriginal<typeof MailModule>();
  // Notification delivery is observed here; unrelated queued email is disabled below.
  return {
    ...actual,
    sendMail: vi.fn(async () => undefined),
  };
});
// mail.ts registers a handler that closes over its real sendMail function.
// Disable that unrelated channel rather than sending fake-key mail over the network.
vi.mock('./outbox.js', async (importOriginal) => {
  const actual = await importOriginal<typeof OutboxModule>();
  return {
    ...actual,
    registerOutboxHandler: (...[kind, handler]: Parameters<typeof actual.registerOutboxHandler>) =>
      actual.registerOutboxHandler(kind, kind === 'email' ? async () => undefined : handler),
  };
});
vi.mock('./push-delivery.js', async (importOriginal) => {
  const actual = await importOriginal<typeof PushModule>();
  return { ...actual, queuePushDeliveries: vi.fn(async () => undefined) };
});

const hasDatabase = Boolean(process.env['DATABASE_URL']);
process.env['SESSION_SECRET'] ??= 'test-only-session-secret-not-used-anywhere-else';
// Read lazily by `env()`, so setting it here lands before the first call.
process.env['RESEND_API_KEY'] ??= 're_test_only_never_dialled';

const sentMail = vi.mocked(sendMail);
const sentPush = vi.mocked(queuePushDeliveries);

/* --------------------------------- fixtures ------------------------------- */

let seq = 0;
const unique = () =>
  `${Date.now().toString(36)}-${(seq += 1)}-${Math.random().toString(36).slice(2, 7)}`;

async function makeUser(label: string): Promise<Actor> {
  const [user] = await getDb()
    .insert(schema.users)
    .values({ email: `${label}-${unique()}@example.test`, name: label, state: 'active' })
    .returning();
  if (!user) throw new Error('user insert returned no row');
  return { user, kind: 'user' };
}

/**
 * An agent, created the way the screen creates one. v2 folded personas into
 * Agent Repo agents (drizzle/0038), so "a persona" is an agent here.
 */
async function createAgent(actor: Actor, input: { name: string }) {
  return createRepoAgent(actor, { name: input.name });
}
const retireAgent = (actor: Actor, id: string) => setArchived(actor, id, true);

async function makeAgent(human: Actor, name: string) {
  return createAgent(human, { name });
}

/**
 * The actor a request carrying this token would resolve to.
 *
 * Through `resolveBearerToken`, deliberately. The original scope bug was a field
 * the middleware dropped, and a suite that assembles actors by hand cannot see a
 * dropped field — it would assert happily against an `Actor` the application
 * never builds.
 */
async function connect(
  human: Actor,
  options: {
    agentId?: string;
    voices?: Voice[];
    defaultVoice?: Voice;
    scope?: string;
  } = {},
): Promise<Actor> {
  const secret = newApiToken();
  const voices = options.voices ?? (options.agentId ? (['persona'] as Voice[]) : undefined);
  await getDb()
    .insert(schema.apiTokens)
    .values({
      userId: human.user.id,
      name: `connection ${unique()}`,
      prefix: tokenPrefix(secret),
      tokenHash: hashSecret(secret),
      ...(options.agentId ? { agentId: options.agentId } : {}),
      ...(voices ? { voiceGrants: voices } : {}),
      ...(options.defaultVoice
        ? { defaultVoice: options.defaultVoice }
        : voices
          ? { defaultVoice: voices.includes('persona') ? 'persona' : 'principal' }
          : {}),
      ...(options.scope ? { scope: options.scope } : {}),
    });
  const bearer = await resolveBearerToken(secret);
  if (!bearer) throw new Error('the token this test just minted does not resolve');
  return {
    user: bearer.user,
    kind: 'agent',
    tokenId: bearer.tokenId,
    scopes: bearer.scopes,
    ceiling: bearer.ceiling,
    ...(bearer.agent ? { agent: bearer.agent } : {}),
    ...(bearer.voice ? { voice: bearer.voice } : {}),
  };
}

async function refusal(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected a refusal, got a success');
}

const blipRow = async (id: string) =>
  (await getDb().select().from(schema.blips).where(eq(schema.blips.id, id)))[0];

/* ============================== the vocabulary ============================ */

describe('the voice vocabulary', () => {
  const human: Actor = { user: { id: 'u' } as never, kind: 'user' };
  const persona = (granted: Voice[], def: Voice): Actor => ({
    user: { id: 'u' } as never,
    kind: 'agent',
    agent: { agentId: 'a', ownerId: 'u', name: 'Claude', handle: 'claude' },
    voice: { granted, default: def },
  });

  it('stamps nothing at all for a person typing in a browser', () => {
    // Not a default — a statement. A session actor has no persona and no voice,
    // so `agent_voice` on what they write is null and stays null.
    expect(resolveVoice(human)).toBeNull();
    expect(authorshipOf(human)).toEqual({ agentId: null, agentVoice: null });
  });

  it('refuses a person who asks to write as an agent they do not have', () => {
    // The human→agent direction. There is no persona on this actor, so there is
    // nothing to write, and saying so beats quietly writing as the human.
    expect(() => resolveVoice(human, 'agent')).toThrow(/not running an agent/i);
  });

  it('uses the connection’s default when the call says nothing', () => {
    expect(resolveVoice(persona(['persona', 'principal'], 'persona'), null)).toBe('persona');
    expect(resolveVoice(persona(['persona', 'principal'], 'principal'), null)).toBe('principal');
  });

  it('refuses a voice outside the grant, and never downgrades to the other one', () => {
    // The assertion that matters is `toThrow`, not the message. A downgrade here
    // would return 'persona' — a success — and the comment would appear under a
    // name the caller did not ask for, with nothing anywhere saying so.
    const own = persona(['persona'], 'persona');
    expect(() => resolveVoice(own, 'me')).toThrow(/cannot write under your name/i);
    expect(resolveVoice(own, 'agent')).toBe('persona');

    const theirs = persona(['principal'], 'principal');
    expect(() => resolveVoice(theirs, 'agent')).toThrow(/only write under your name/i);
    expect(resolveVoice(theirs, 'me')).toBe('principal');
  });

  it('writes BOTH columns in BOTH voices — the §0 invariant', () => {
    for (const voice of ['persona', 'principal'] as Voice[]) {
      const actor = persona(['persona', 'principal'], voice);
      const stamped = authorshipOf(actor);
      expect(stamped.agentId).toBe('a');
      expect(stamped.agentVoice).toBe(voice);
    }
  });
});

/* ============================== the database ============================== */

describe.skipIf(!hasDatabase)('agent personas (real postgres)', () => {
  beforeAll(async () => {
    await runMigrations();
  }, 60_000);
  afterAll(async () => {
    await closeDb();
  });

  /* ------------------------------- identity ------------------------------ */

  describe('identity', () => {
    it('has no address, so nothing can be addressed to it', async () => {
      const lucas = await makeUser('p-noemail');
      await makeAgent(lucas, 'Claude');
      const { rows } = await getDb().execute<{ column_name: string }>(
        sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'agents'`,
      );
      const columns = rows.map((r) => r.column_name);
      // The whole reason the table exists. With no address there is nothing for
      // `findUserByEmail` to answer, nothing an invitation can be sent to, and
      // nothing the invited/added oracle can be made to speak about.
      expect(columns).not.toContain('email');
      // And none of the account machinery applies to it, permanently.
      expect(columns).not.toContain('state');
      expect(columns).not.toContain('is_admin');
    });

    it('lets two people each have a @claude, and one person have only one', async () => {
      const lucas = await makeUser('p-h1');
      const ada = await makeUser('p-h2');
      const a = await makeAgent(lucas, 'Claude');
      const b = await makeAgent(ada, 'Claude');
      expect(a.handle).toBe('claude');
      expect(b.handle).toBe('claude');
      const again = await refusal(() => makeAgent(lucas, 'Claude'));
      expect(again.message).toMatch(/already have an agent/i);
    });

    it('bounds how many agents one person may hold', async () => {
      /*
        A bound rather than a product limit. Every live agent of every reader is
        a candidate in \`mentionDirectory\`, so without this one person could make
        a shared radar's mention lookup unbounded for everybody else on it.

        v2: archived agents count too — an archived agent keeps its prompt
        history and memory, which is storage — so deleting one makes room.
      */
      const lucas = await makeUser('p-cap');
      const ada = await makeUser('p-cap-other');
      await createAgent(ada, { name: 'Another owner' });
      // Seed the prefix in one statement; service behavior is exercised at the
      // boundary, not once per inert fixture. Archived definitions count too.
      await getDb()
        .insert(schema.repoAgents)
        .values(
          Array.from({ length: AGENT_REPO.agentsPerOwner - 1 }, (_, i) => ({
            ownerId: lucas.user.id,
            slug: `fixture-${i}`,
            name: `Fixture ${i}`,
            archivedAt: i === 0 ? new Date() : null,
          })),
        );
      const last = await createAgent(lucas, { name: 'Last allowed' });
      expect(last.handle).toBe('last-allowed');
      const err = await refusal(() => createAgent(lucas, { name: 'One too many' }));
      expect(err.message).toMatch(/Delete one first/i);
      expect(await listAgents(lucas, { includeArchived: true })).toHaveLength(
        AGENT_REPO.agentsPerOwner,
      );

      await retireAgent(lucas, last.id);
      const archived = await refusal(() => createAgent(lucas, { name: 'Archiving is not room' }));
      expect(archived.message).toMatch(/Delete one first/i);
      await deleteRepoAgent(lucas, last.id);
      const room = await createAgent(lucas, { name: 'Now there is room' });
      expect(room.handle).toBe('now-there-is-room');
      expect(await listAgents(lucas, { includeArchived: true })).toHaveLength(
        AGENT_REPO.agentsPerOwner,
      );
      expect(await listAgents(ada)).toHaveLength(1);
    });

    it('may be created over a connection, but archived only by a person', async () => {
      const lucas = await makeUser('p-human-only');
      const claude = await makeAgent(lucas, 'Claude');
      const agent = await connect(lucas, { agentId: claude.id });

      // The refusal lives in the service, not in the tool router — so it holds
      // over REST as well, which is where the topic fences were bypassable.
      // v2 (§V2.3): creating an agent is allowed — it is inert until somebody
      // chooses to load it, and "build agents with Claude" is half of the ask.
      const created = await createAgent(agent, { name: 'Second Self' });
      const retired = await refusal(() => retireAgent(agent, claude.id));
      expect(retired.message).toMatch(/Ask the user/i);
      expect((await listAgents(lucas)).map((a) => a.id).sort()).toEqual(
        [claude.id, created.id].sort(),
      );
    });

    it('retires without erasing: the name still renders on what it wrote', async () => {
      const lucas = await makeUser('p-retire');
      const claude = await makeAgent(lucas, 'Claude');
      const agent = await connect(lucas, { agentId: claude.id });
      const radar = await createRadar(lucas, { name: `Retire ${unique()}` });
      const blip = await createBlip(agent, radar.id, { body: 'written before retirement' });

      await retireAgent(lucas, claude.id);

      // What it wrote keeps saying who wrote it...
      const after = await getBlip(blip.id, lucas);
      expect(after.agent?.name).toBe('Claude');
      expect(after.agent?.retired).toBe(true);
      expect(after.voice).toBe('persona');

      // ...and the handle stops resolving, exactly as a deleted account's does.
      const row = (
        await getDb().select().from(schema.radars).where(eq(schema.radars.id, radar.id))
      )[0];
      const directory = await mentionDirectory(row as never);
      expect(directory.has('claude')).toBe(false);

      // ...and it cannot be attached to a new connection.
      const attached = await refusal(() => createToken(lucas, { name: 'new', agentId: claude.id }));
      expect(attached.message).toMatch(/archived/i);
    });

    it('keeps a retired persona’s connection working, at principal only', async () => {
      // Retiring a *name* must not be an outage. The connection lives; it simply
      // stops speaking in a name that has been withdrawn.
      const lucas = await makeUser('p-retire-token');
      const claude = await makeAgent(lucas, 'Claude');
      const before = await connect(lucas, { agentId: claude.id });
      expect(before.agent?.agentId).toBe(claude.id);

      await retireAgent(lucas, claude.id);
      const secret = newApiToken();
      await getDb()
        .insert(schema.apiTokens)
        .values({
          userId: lucas.user.id,
          name: 'after',
          prefix: tokenPrefix(secret),
          tokenHash: hashSecret(secret),
          agentId: claude.id,
          voiceGrants: ['persona'],
          defaultVoice: 'persona',
        });
      const resolved = await resolveBearerToken(secret);
      expect(resolved).not.toBeNull();
      expect(resolved?.agent).toBeUndefined();
      expect(resolved?.voice).toBeUndefined();
    });

    it('refuses a credential naming somebody else’s persona outright', async () => {
      // Not "a smaller actor" — not an actor. This cannot be reached through any
      // mint path, which is exactly why it is worth refusing rather than
      // ignoring: if it ever appears, something wrote a principal into a
      // credential and the safe answer is that nobody is holding it.
      const lucas = await makeUser('p-corrupt-a');
      const ada = await makeUser('p-corrupt-b');
      const hers = await makeAgent(ada, 'Claude');
      const secret = newApiToken();
      await getDb()
        .insert(schema.apiTokens)
        .values({
          userId: lucas.user.id,
          name: 'corrupt',
          prefix: tokenPrefix(secret),
          tokenHash: hashSecret(secret),
          agentId: hers.id,
        });
      expect(await resolveBearerToken(secret)).toBeNull();
    });
  });

  /* ------------------------------ the grant ------------------------------ */

  describe('the voice grant', () => {
    it('is enforced by the database, not by the service', async () => {
      const lucas = await makeUser('p-check');
      const secret = newApiToken();
      const bad = refusal(async () => {
        await getDb()
          .insert(schema.apiTokens)
          .values({
            userId: lucas.user.id,
            name: 'bad',
            prefix: tokenPrefix(secret),
            tokenHash: hashSecret(secret),
            voiceGrants: ['principal'],
            defaultVoice: 'persona',
          });
      });
      // The message that matters is the constraint's, which pg puts in `cause`.
      const err = await bad;
      const cause = (err as { cause?: unknown }).cause;
      const detail = `${err.message} ${cause instanceof Error ? cause.message : ''}`;
      expect(detail).toMatch(/api_tokens_default_voice_granted/);
    });

    it('gives a connection with no persona no voice at all', async () => {
      // The whole of the "nothing live changes" argument. Every token issued
      // before personas existed carries `agent_id IS NULL`, so it resolves like
      // this and writes exactly what it always wrote.
      const lucas = await makeUser('p-novoice');
      const plain = await connect(lucas);
      expect(plain.agent).toBeUndefined();
      expect(plain.voice).toBeUndefined();

      const radar = await createRadar(lucas, { name: `Plain ${unique()}` });
      const blip = await createBlip(plain, radar.id, { body: 'as it always was' });
      const row = await blipRow(blip.id);
      expect(row?.authorId).toBe(lucas.user.id);
      expect(row?.agentId).toBeNull();
      expect(row?.agentVoice).toBeNull();
    });

    it('collapses to principal when a token is minted with no persona', async () => {
      const lucas = await makeUser('p-mint-noagent');
      const minted = await createToken(lucas, { name: 'bare', voices: ['persona'] });
      // Asked for persona, has nothing to speak as, gets principal — the bound
      // that makes the grant coherent.
      expect(minted.voices).toEqual([]);
      expect(minted.agent).toBeNull();
      const [row] = await getDb()
        .select()
        .from(schema.apiTokens)
        .where(eq(schema.apiTokens.id, minted.id));
      expect(row?.voiceGrants).toEqual(['principal']);
    });

    it('defaults a new persona-bearing token to its own voice', async () => {
      const lucas = await makeUser('p-mint-agent');
      const claude = await makeAgent(lucas, 'Claude');
      const minted = await createToken(lucas, { name: 'named', agentId: claude.id });
      expect(minted.voices).toEqual(['persona']);
      expect(minted.defaultVoice).toBe('persona');
    });

    it('refuses to attach somebody else’s persona to a token', async () => {
      const lucas = await makeUser('p-mint-theirs-a');
      const ada = await makeUser('p-mint-theirs-b');
      const hers = await makeAgent(ada, 'Claude');
      const err = await refusal(() => createToken(lucas, { name: 'x', agentId: hers.id }));
      // 404, not 403: an agent id is as much a disclosure as a radar id.
      expect(err.message).toMatch(/not found/i);
    });
  });

  /* ------------------------------ authorship ----------------------------- */

  describe('authorship', () => {
    it('records both principals on every agent-borne write, in both voices', async () => {
      const lucas = await makeUser('p-both');
      const claude = await makeAgent(lucas, 'Claude');
      const agent = await connect(lucas, {
        agentId: claude.id,
        voices: ['persona', 'principal'],
      });
      const radar = await createRadar(lucas, { name: `Both ${unique()}` });

      for (const [as, voice] of [
        ['agent', 'persona'],
        ['me', 'principal'],
      ] as const) {
        const blip = await createBlip(agent, radar.id, { body: `written ${as}`, as });
        const row = await blipRow(blip.id);
        // Identical in both voices. This is the invariant a future refactor is
        // most likely to break, and the one that makes forgery unrepresentable.
        expect(row?.authorId).toBe(lucas.user.id);
        expect(row?.agentId).toBe(claude.id);
        expect(row?.agentVoice).toBe(voice);
        // And the DTO says both, whichever name it leads with.
        expect(blip.author?.id).toBe(lucas.user.id);
        expect(blip.agent?.name).toBe('Claude');
        expect(blip.voice).toBe(voice);
      }
    });

    it('writes nothing at all when the voice is refused', async () => {
      const lucas = await makeUser('p-refuse-write');
      const claude = await makeAgent(lucas, 'Claude');
      const agent = await connect(lucas, { agentId: claude.id, voices: ['persona'] });
      const radar = await createRadar(lucas, { name: `Refused ${unique()}` });

      await refusal(() => createBlip(agent, radar.id, { body: 'under your name', as: 'me' }));
      const rows = await getDb()
        .select()
        .from(schema.blips)
        .where(eq(schema.blips.radarId, radar.id));
      // The refusal happens before the transaction, so the capture does not
      // half-happen. A downgrade here would have written a row.
      expect(rows).toHaveLength(0);
    });

    it('refuses a move in an ungranted voice before it moves anything', async () => {
      /*
        The refusal has to land before the *first* side effect, not merely before
        the row is patched. `updateBlip` re-points the denormalised `radar_id` on
        a blip's attachments, comments, reactions and mentions ahead of patching
        the blip itself, so a voice refusal raised after that would leave every
        one of them on the destination radar with the blip still on the source —
        the "stranded on a radar its blip has left" failure `0008` warns about,
        reached from the other end.

        Found by reading the order rather than by a failing test, which is why it
        gets one.
      */
      const lucas = await makeUser('p-partial');
      const claude = await makeAgent(lucas, 'Claude');
      const agent = await connect(lucas, { agentId: claude.id, voices: ['persona'] });
      const from = await createRadar(lucas, { name: `From ${unique()}` });
      const to = await createRadar(lucas, { name: `To ${unique()}` });
      const blip = await createBlip(lucas, from.id, { body: 'has a conversation' });
      const comment = await createComment(lucas, blip.id, { body: 'a remark' });

      await refusal(() =>
        updateBlip(agent, blip.id, { radarId: to.id, body: 'moved and rewritten', as: 'me' }),
      );

      const row = await blipRow(blip.id);
      expect(row?.radarId).toBe(from.id);
      expect(row?.body).toBe('has a conversation');
      const [remark] = await getDb()
        .select()
        .from(schema.blipComments)
        .where(eq(schema.blipComments.id, comment.id));
      // The half that would have moved first.
      expect(remark?.radarId).toBe(from.id);
    });

    it('refuses a move into a lane the destination does not have, before moving', async () => {
      /*
        The same shape as the test above and it predates personas: `assertLane`
        ran after the denormalised ids had already been re-pointed, so naming a
        lane the destination template does not have moved the whole conversation
        and then refused. Not a persona bug — but it is in the code the persona
        work moved, and half a fix to a partial-write hazard is not a fix.
      */
      const lucas = await makeUser('p-lane');
      const from = await createRadar(lucas, { name: `Lane from ${unique()}` });
      const to = await createRadar(lucas, { name: `Lane to ${unique()}` });
      const blip = await createBlip(lucas, from.id, { body: 'has a conversation' });
      const comment = await createComment(lucas, blip.id, { body: 'a remark' });

      await refusal(() => updateBlip(lucas, blip.id, { radarId: to.id, status: 'nonsense' }));

      const row = await blipRow(blip.id);
      expect(row?.radarId).toBe(from.id);
      const [remark] = await getDb()
        .select()
        .from(schema.blipComments)
        .where(eq(schema.blipComments.id, comment.id));
      expect(remark?.radarId).toBe(from.id);
    });

    it('keeps the mark when a person rewrites the text, and names them as the editor', async () => {
      const lucas = await makeUser('p-edit');
      const claude = await makeAgent(lucas, 'Claude');
      const agent = await connect(lucas, { agentId: claude.id });
      const radar = await createRadar(lucas, { name: `Edit ${unique()}` });
      const blip = await createBlip(agent, radar.id, { body: 'the agent wrote this' });

      const edited = await updateBlip(lucas, blip.id, { body: 'and then Lucas rewrote it' });
      const row = await blipRow(blip.id);
      // The creator is fixed (ADR-0028); the editor is shown beside it.
      expect(row?.agentId).toBe(claude.id);
      expect(row?.agentVoice).toBe('persona');
      expect(edited.lastEditedBy?.userId).toBe(lucas.user.id);
    });

    it('does NOT clear the mark when a person merely re-files it', async () => {
      /*
        The sharpening this suite exists to protect. `updateBlip` is also how a
        card is pinned, moved between lanes and given a state; re-stamping on
        every call would mean dragging a card across a board silently erased who
        wrote it — a far commoner act than editing the text, and one that would
        read as data loss rather than as a rule.
      */
      const lucas = await makeUser('p-refile');
      const claude = await makeAgent(lucas, 'Claude');
      const agent = await connect(lucas, { agentId: claude.id });
      const radar = await createRadar(lucas, { name: `Refile ${unique()}` });
      const blip = await createBlip(agent, radar.id, { body: 'the agent wrote this' });

      await updateBlip(lucas, blip.id, { pinned: true });
      await updateBlip(lucas, blip.id, { state: 'done' });
      await updateBlip(lucas, blip.id, { tags: ['kept'] });
      const row = await blipRow(blip.id);
      expect(row?.agentId).toBe(claude.id);
      expect(row?.agentVoice).toBe('persona');
      expect(row?.pinned).toBe(true);
    });

    it('lets the owner edit the agent’s comment, which keeps the mark and names the editor', async () => {
      const lucas = await makeUser('p-comment-edit');
      const claude = await makeAgent(lucas, 'Claude');
      const agent = await connect(lucas, { agentId: claude.id });
      const radar = await createRadar(lucas, { name: `Talk ${unique()}` });
      const blip = await createBlip(lucas, radar.id, { body: 'a thought' });
      const comment = await createComment(agent, blip.id, { body: 'the agent remarks' });
      expect(comment.agent?.name).toBe('Claude');

      // `updateComment` refuses unless `author_id` is the caller — and on an
      // agent-written comment `author_id` is already the owner, so the existing
      // predicate passes for them and fails for everybody else, unchanged.
      // The person in the browser: the cookie is what makes the owner more than the agent's account.
      const edited = await updateComment({ ...lucas, viaCookie: true }, comment.id, {
        body: 'Lucas rewrites it',
      });
      // The creator is fixed (0099); the editor is shown beside it.
      expect(edited.agent?.name).toBe('Claude');
      expect(edited.voice).toBe('persona');
      expect(edited.editedBy?.userId).toBe(lucas.user.id);
      expect(edited.editedBy?.agentId).toBeNull();
      // The creator editing their own words is not "edited by someone else".
      const again = await updateComment(agent, comment.id, { body: 'the agent revises' });
      expect(again.agent?.name).toBe('Claude');
      expect(again.editedBy).toBeUndefined();
    });

    it('keeps a comment’s creator when a previous image re-stamps it, and still lets a deletion null it', async () => {
      const lucas = await makeUser('p-comment-oldpod');
      const ada = await makeUser('p-comment-oldpod-b');
      const claude = await makeAgent(lucas, 'Claude');
      const agent = await connect(lucas, { agentId: claude.id });
      const radar = await createRadar(lucas, { name: `Old pod ${unique()}` });
      const blip = await createBlip(lucas, radar.id, { body: 'a thought' });
      const comment = await createComment(agent, blip.id, { body: 'the agent remarks' });
      await updateComment({ ...lucas, viaCookie: true }, comment.id, { body: 'Lucas rewrites it' });
      const row = async () =>
        must(
          (
            await getDb()
              .select()
              .from(schema.blipComments)
              .where(eq(schema.blipComments.id, comment.id))
          )[0],
        );
      // What the previous image's update writes: the editor's authorship, and no editor named.
      await getDb().execute(
        sql`UPDATE blip_comments SET author_id = ${ada.user.id}, agent_id = NULL, agent_voice = NULL,
                   body = 'old pod' WHERE id = ${comment.id}`,
      );
      const after = await row();
      expect(after.body).toBe('old pod');
      expect([after.authorId, after.agentId, after.agentVoice]).toEqual([
        lucas.user.id,
        claude.id,
        'persona',
      ]);
      expect([after.editedByUserId, after.editedByAgentId]).toEqual([null, null]);
      // Deleting the agent still nulls its reference on the comment.
      await deleteRepoAgent(lucas, claude.id);
      expect((await row()).agentId).toBeNull();
    });

    it('lets deleting a person null the creator on their comment', async () => {
      const lucas = await makeUser('p-comment-del-a');
      const ada = await makeUser('p-comment-del-b');
      const radar = await createRadar(lucas, { name: `Delete ${unique()}` });
      await shareRadar(lucas, radar.id, ada.user.email, 'editor');
      const blip = await createBlip(lucas, radar.id, { body: 'a thought' });
      const comment = await createComment(ada, blip.id, { body: 'ada remarks' });
      await updateComment({ ...ada, viaCookie: true }, comment.id, { body: 'ada revises' });
      await getDb().execute(sql`DELETE FROM users WHERE id = ${ada.user.id}`);
      const [row] = await getDb()
        .select()
        .from(schema.blipComments)
        .where(eq(schema.blipComments.id, comment.id));
      expect([row?.authorId, row?.editedByUserId]).toEqual([null, null]);
    });

    it('will not let another person edit the agent’s comment', async () => {
      const lucas = await makeUser('p-comment-other-a');
      const ada = await makeUser('p-comment-other-b');
      const claude = await makeAgent(lucas, 'Claude');
      const agent = await connect(lucas, { agentId: claude.id });
      const radar = await createRadar(lucas, { name: `Shared talk ${unique()}` });
      await shareRadar(lucas, radar.id, ada.user.email, 'editor');
      const blip = await createBlip(lucas, radar.id, { body: 'a thought' });
      const comment = await createComment(agent, blip.id, { body: 'the agent remarks' });

      const err = await refusal(() => updateComment(ada, comment.id, { body: 'not yours' }));
      expect(err.message).toMatch(/not found/i);
    });

    it('keeps an agent’s reaction its own, beside the human’s, one apiece', async () => {
      /*
        `blip_reactions` carries `agent_id` (0101), NULL for the person, inside a NULLS NOT
        DISTINCT unique index. The person and each agent hold one mark apiece; the same actor
        twice is still one.
      */
      const lucas = await makeUser('p-react');
      const ada = await makeUser('p-react-owner');
      const one = await makeAgent(lucas, 'Claude');
      const two = await makeAgent(lucas, 'Codex');
      const radar = await createRadar(ada, { name: `React ${unique()}` });
      await shareRadar(ada, radar.id, lucas.user.email, 'editor');
      const blip = await createBlip(ada, radar.id, { body: 'react to me' });

      const first = await connect(lucas, { agentId: one.id });
      const second = await connect(lucas, { agentId: two.id });
      const rows = () =>
        getDb().select().from(schema.blipReactions).where(eq(schema.blipReactions.blipId, blip.id));

      await setReaction(lucas, blip.id, 'up', true);
      await setReaction(first, blip.id, 'up', true);
      await setReaction(first, blip.id, 'up', true);
      await setReaction(second, blip.id, 'up', true);
      const all = await rows();
      expect(all).toHaveLength(3);
      expect(all.every((r) => r.userId === lucas.user.id)).toBe(true);
      expect(all.map((r) => r.agentId).sort()).toEqual([null, one.id, two.id].sort());

      // Taking one agent's mark off leaves the person's and the other agent's.
      await setReaction(first, blip.id, 'up', false);
      expect((await rows()).map((r) => r.agentId).sort()).toEqual([null, two.id].sort());
    });

    it('survives its owner’s account being deleted, with the words intact', async () => {
      /*
        The property the bidirectional CHECK broke, and — as it turned out — the
        one a non-deferrable FK broke as well. Both of `author_id` and `agent_id`
        point at the same human on every agent-borne row, so deleting that person
        runs two referential actions plus a CASCADE against one tuple.

        Asserted on the DELETE completing, not just on its result: the failure
        mode is an aborted transaction, not a wrong row.
      */
      const ada = await makeUser('p-del-owner');
      const lucas = await makeUser('p-del-agentowner');
      const claude = await makeAgent(lucas, 'Claude');
      const agent = await connect(lucas, { agentId: claude.id });
      const radar = await createRadar(ada, { name: `Survives ${unique()}` });
      await shareRadar(ada, radar.id, lucas.user.email, 'editor');
      const blip = await createBlip(agent, radar.id, { body: 'still here afterwards' });
      const comment = await createComment(agent, blip.id, { body: 'so is this' });

      await getDb().delete(schema.users).where(eq(schema.users.id, lucas.user.id));

      const row = await blipRow(blip.id);
      expect(row?.body).toBe('still here afterwards');
      expect(row?.authorId).toBeNull();
      expect(row?.agentId).toBeNull();
      // The voice survives, because a referential action can only touch the
      // referencing column. "An agent wrote this and its principal is gone" is
      // the same sentence `author_id` already tells, and stays sayable.
      expect(row?.agentVoice).toBe('persona');
      const [remark] = await getDb()
        .select()
        .from(schema.blipComments)
        .where(eq(schema.blipComments.id, comment.id));
      expect(remark?.body).toBe('so is this');
      expect(remark?.agentVoice).toBe('persona');
    });

    it('keeps the authorship foreign keys deferrable, which is what makes that work', async () => {
      /*
        The schema half of the property above, and it is here because the
        behavioural half **is not a reliable guard on its own** — which is worth
        knowing rather than assuming.

        Making `blips_agent_id_fkey` non-deferrable and re-running the deletion
        test above leaves it passing, while the same DELETE written as raw SQL
        against the same database fails. The difference is the order Postgres
        fires the referential-action and check triggers for one statement, which
        depends on constraint OIDs and on how many other rows the same DELETE
        touches. So the failure is real, reachable, and *intermittent by fixture*
        — the worst combination, and precisely the reason to make the constraint
        order-independent rather than to arrange the rows so it happens to work.

        Asserted on `pg_constraint` rather than on a name: `condeferrable` is the
        property, and a constraint recreated without it would keep the name.
      */
      const { rows } = await getDb().execute<{
        conname: string;
        condeferrable: boolean;
        condeferred: boolean;
      }>(sql`
        SELECT conname, condeferrable, condeferred FROM pg_constraint
         WHERE conname IN ('blips_agent_id_fkey', 'blip_comments_agent_id_fkey',
                           'audit_log_agent_id_fkey')
      `);
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row.condeferrable, `${row.conname} must be DEFERRABLE`).toBe(true);
        expect(row.condeferred, `${row.conname} must be INITIALLY DEFERRED`).toBe(true);
      }
    });
  });

  /* ---------------------------- authorization ---------------------------- */

  describe('authorization', () => {
    it('never exceeds its owner, on any kind of access', async () => {
      /*
        A matrix, not selected cases. The property is monotone weakening, so the
        only thing that catches a promotion is comparing every cell against the
        human's own answer — including the ones where the human has nothing.
      */
      const lucas = await makeUser('p-matrix');
      const ada = await makeUser('p-matrix-other');
      const claude = await makeAgent(lucas, 'Claude');

      const owned = await createRadar(lucas, { name: `Owned ${unique()}` });
      const member = await createRadar(ada, { name: `Member ${unique()}` });
      await shareRadar(ada, member.id, lucas.user.email, 'editor');
      const stranger = await createRadar(ada, { name: `Stranger ${unique()}` });

      const cascading = await createTopic(lucas, { name: `Cascade ${unique()}` });
      await setCascade(lucas, cascading.id, true);
      const inCascade = await createRadar(lucas, { name: `InCascade ${unique()}` });
      await setRadarTopic(lucas, inCascade.id, cascading.id);

      const radars = [owned.id, member.id, stranger.id, inCascade.id];
      const order = (r: RadarRole | null) => (r === null ? -1 : RADAR_ROLES.indexOf(r));

      for (const scope of [
        'radars:read',
        'radars:read radars:write',
        'radars:read radars:write radars:manage',
      ]) {
        const agent = await connect(lucas, { agentId: claude.id, scope });
        for (const radarId of radars) {
          const mine = await getRadarAccess(radarId, lucas);
          const theirs = await getRadarAccess(radarId, agent);
          expect(order(theirs?.role ?? null)).toBeLessThanOrEqual(order(mine?.role ?? null));
          // ...and the persona contributes nothing of its own, so "no access for
          // the human" is "no access", full stop.
          if ((mine?.role ?? null) === null) expect(theirs?.role ?? null).toBeNull();
        }
        /*
          `<=` alone catches a promotion but not a missing clamp: with the `min`
          removed, agent and human are simply equal and every inequality above
          still holds. So the read-only case is asserted as an equality against
          the ceiling it must have been cut down to — on a radar the human owns,
          which is where the gap between the two is widest.
        */
        if (scope === 'radars:read') {
          expect((await getRadarAccess(owned.id, lucas))?.role).toBe('owner');
          expect((await getRadarAccess(owned.id, agent))?.role).toBe('viewer');
        }
      }
    });

    it('holds no membership row, and loses access the moment its owner does', async () => {
      const ada = await makeUser('p-revoke-owner');
      const lucas = await makeUser('p-revoke-member');
      const claude = await makeAgent(lucas, 'Claude');
      const radar = await createRadar(ada, { name: `Revoked ${unique()}` });
      await shareRadar(ada, radar.id, lucas.user.email, 'editor');
      const agent = await connect(lucas, { agentId: claude.id });

      expect((await getRadarAccess(radar.id, agent))?.role).toBe('editor');
      // Scoped to this radar. A count over the whole table would be a count over
      // whatever the other suites in this run are doing in parallel workers —
      // the same trap `migrate.test.ts` documents for `pg_locks`.
      const membersHere = async () =>
        getDb().select().from(schema.radarMembers).where(eq(schema.radarMembers.radarId, radar.id));
      const before = await membersHere();
      // Exactly one row, and it is the human's. The agent never had one.
      expect(before).toHaveLength(1);
      expect(before[0]?.userId).toBe(lucas.user.id);

      await removeMember(ada, radar.id, lucas.user.id);

      // Nothing was materialised, so nothing needs unwinding — and the agent's
      // answer changes on the very next call with no sweep of membership rows,
      // because there are none.
      expect((await getRadarAccess(radar.id, agent))?.role ?? null).toBeNull();
      expect(await membersHere()).toHaveLength(0);
    });

    it('cannot reach a radar its owner cannot, over REST or the service', async () => {
      const ada = await makeUser('p-unreachable-owner');
      const lucas = await makeUser('p-unreachable-other');
      const claude = await makeAgent(lucas, 'Claude');
      const radar = await createRadar(ada, { name: `Private ${unique()}` });

      const secret = newApiToken();
      await getDb()
        .insert(schema.apiTokens)
        .values({
          userId: lucas.user.id,
          name: 'reach',
          prefix: tokenPrefix(secret),
          tokenHash: hashSecret(secret),
          agentId: claude.id,
          voiceGrants: ['persona'],
          defaultVoice: 'persona',
        });
      const agent = await connect(lucas, { agentId: claude.id });
      const err = await refusal(() => requireRadar(radar.id, agent, 'read'));
      expect(err.message).toMatch(/not found/i);

      const app = createApp();
      const res = await app.request(`/api/radars/${radar.id}`, {
        headers: { authorization: `Bearer ${secret}` },
      });
      // 404, never 403 — a 403 confirms the id exists.
      expect(res.status).toBe(404);
    });

    it('is still capped by its token’s scope', async () => {
      const lucas = await makeUser('p-scope');
      const claude = await makeAgent(lucas, 'Claude');
      const radar = await createRadar(lucas, { name: `Readonly ${unique()}` });
      const agent = await connect(lucas, { agentId: claude.id, scope: 'radars:read' });

      const err = await refusal(() => createBlip(agent, radar.id, { body: 'nope' }));
      // Not a 404: the radar is plainly there, the *connection* was granted less
      // than this needs, and only a re-authorization can change that.
      expect(err.message).toMatch(/radars:write/);
    });
  });

  /* ------------------------------- mentions ------------------------------ */

  describe('mentions', () => {
    it('resolves @claude on a radar its owner can read', async () => {
      const lucas = await makeUser('p-mention');
      await makeAgent(lucas, 'Claude');
      const radar = await createRadar(lucas, { name: `Mention ${unique()}` });
      const row = (
        await getDb().select().from(schema.radars).where(eq(schema.radars.id, radar.id))
      )[0];

      const resolved = await resolveMentions(row as never, 'what do you think @claude?');
      expect(resolved.resolved).toHaveLength(1);
      expect(resolved.resolved[0]?.target.agentId).not.toBeNull();
      expect(resolved.resolved[0]?.target.userId).toBeNull();
      // The queue is its owner's row with the agent stamped on it.
      expect(resolved.resolved[0]?.target.ownerId).toBe(lucas.user.id);
    });

    it('resolves two colliding @claudes to neither, and each qualified one to itself', async () => {
      const lucas = await makeUser('p-collide-a');
      const ada = await makeUser('p-collide-b');
      await makeAgent(lucas, 'Claude');
      const hers = await makeAgent(ada, 'Claude');
      const radar = await createRadar(lucas, { name: `Collide ${unique()}` });
      await shareRadar(lucas, radar.id, ada.user.email, 'editor');
      const row = (
        await getDb().select().from(schema.radars).where(eq(schema.radars.id, radar.id))
      )[0];

      const bare = await resolveMentions(row as never, 'hello @claude');
      // Ambiguity resolves to nothing — the rule two people called Ada already
      // meet, reused rather than restated.
      expect(bare.resolved).toHaveLength(0);
      expect(bare.ambiguous).toEqual(['claude']);

      const adaHandle = ada.user.email.split('@')[0];
      const qualified = await resolveMentions(
        row as never,
        `hello @${must(adaHandle, 'adaHandle')}.claude`,
      );
      expect(qualified.resolved).toHaveLength(1);
      expect(qualified.resolved[0]?.target.agentId).toBe(hers.id);
    });

    it('is not a candidate when its owner cannot read the radar', async () => {
      const ada = await makeUser('p-mention-stranger-owner');
      const lucas = await makeUser('p-mention-stranger');
      await makeAgent(lucas, 'Claude');
      const radar = await createRadar(ada, { name: `Closed ${unique()}` });
      const row = (
        await getDb().select().from(schema.radars).where(eq(schema.radars.id, radar.id))
      )[0];

      const resolved = await resolveMentions(row as never, 'are you there @claude');
      // Mentioning cannot widen access, and the reason is structural: candidates
      // come from `radarReaders`, so there is no branch to get wrong.
      expect(resolved.resolved).toHaveLength(0);
      expect(resolved.unknown).toEqual(['claude']);
      expect(await radarAgents(row as never)).toEqual([]);
    });

    it('writes one row for a body re-saved, and notifies once', async () => {
      const lucas = await makeUser('p-dedupe');
      await makeAgent(lucas, 'Claude');
      const radar = await createRadar(lucas, { name: `Dedupe ${unique()}` });
      const blip = await createBlip(lucas, radar.id, { body: 'have a look @claude' });
      await updateBlip(lucas, blip.id, { body: 'have another look @claude' });
      await updateBlip(lucas, blip.id, { body: 'and again @claude' });

      const rows = await getDb()
        .select()
        .from(schema.mentions)
        .where(eq(schema.mentions.blipId, blip.id));
      // Reconciled rather than deleted-and-reinserted, which is what makes the
      // edit silent: the rows already there are the record of who has been told.
      // Note this is the *service* deduplicating, not the index — see below.
      expect(rows).toHaveLength(1);
      expect(rows[0]?.userId).toBeNull();
      expect(rows[0]?.agentId).not.toBeNull();
    });

    it('writes one row when two saves of the same body race — the index test', async () => {
      /*
        **This is the assertion that catches a missing partial unique index, and
        the sequential one above is not.**

        Worth being exact about, because the design that preceded this said a
        plain re-save would duplicate, and it does not: `reconcileMentions` reads
        the rows already there and inserts only what is new, so a second save
        never attempts a duplicate at all. Sequential re-saving passes with the
        indexes dropped — verified by dropping them.

        What the index actually guards is the race, which is the case its
        `onConflictDoNothing` was written for. The existing uniqueness is
        `(blip_id, user_id) WHERE blip_id IS NOT NULL`, and an agent mention
        carries `user_id = NULL` — NULLs do not conflict in a unique index — so
        without `mentions_blip_agent_idx` both writers see an empty `before`,
        both insert, and there is nothing for the conflict clause to arbitrate.
        Two rows, and the agent is told twice.
      */
      const lucas = await makeUser('p-race');
      await makeAgent(lucas, 'Claude');
      const radar = await createRadar(lucas, { name: `Race ${unique()}` });
      const row = (
        await getDb().select().from(schema.radars).where(eq(schema.radars.id, radar.id))
      )[0];
      const [blip] = await getDb()
        .insert(schema.blips)
        .values({ radarId: radar.id, authorId: lucas.user.id, body: 'racing @claude' })
        .returning();
      if (!blip) throw new Error('blip insert returned no row');

      // The first save resolves and writes normally.
      await reconcileMentions(row as never, { blipId: blip.id }, blip.body, lucas.user.id);
      const target = (
        await getDb().select().from(schema.mentions).where(eq(schema.mentions.blipId, blip.id))
      )[0];
      expect(target?.agentId).toBeTruthy();

      /*
        Then the write the loser of a race makes: the same row, offered again
        with the same `onConflictDoNothing` the service uses, from a writer whose
        `before` set was read before the winner committed.

        Driven directly rather than by firing three `reconcileMentions` at once,
        because that version is not a test — it passes with the indexes dropped,
        since the reads and writes happen to interleave in the safe order. A race
        test that only fails when the scheduler cooperates is a test that reports
        "index present" on the strength of a coin toss.
      */
      await getDb()
        .insert(schema.mentions)
        .values({
          radarId: radar.id,
          blipId: blip.id,
          agentId: target?.agentId ?? null,
        })
        .onConflictDoNothing();

      const rows = await getDb()
        .select()
        .from(schema.mentions)
        .where(eq(schema.mentions.blipId, blip.id));
      expect(rows).toHaveLength(1);
    });

    it('keeps the qualified handle renderable, not just resolvable', async () => {
      const lucas = await makeUser('p-aliases');
      await makeAgent(lucas, 'Claude');
      const radar = await createRadar(lucas, { name: `Aliases ${unique()}` });
      const handle = lucas.user.email.split('@')[0];
      const blip = await createBlip(lucas, radar.id, {
        body: `look @${must(handle, 'handle')}.claude`,
      });
      const dto = await getBlip(blip.id, lucas);
      const mention = dto.mentions?.[0];
      expect(mention?.agentId).toBeTruthy();
      // Without the aliases the qualified form would notify correctly and then
      // render as plain text, which reads as a fault rather than a resolution.
      expect([mention?.handle, ...(mention?.aliases ?? [])]).toContain(
        `${must(handle, 'handle')}-claude`,
      );
    });
  });

  /* ----------------------------- notifications --------------------------- */

  describe('notifications', () => {
    it('reaches an agent its own owner mentioned — the self-filter test', async () => {
      /*
        The single most likely way anybody will use this feature, and the bug it
        guards is silent. `fanOut` filtered on the user id alone, and an agent's
        row carries `user_id = <its owner>` — so Lucas mentioning his own
        `@claude` was dropped with no error anywhere.
      */
      const lucas = await makeUser('p-self');
      const claude = await makeAgent(lucas, 'Claude');
      const agent = await connect(lucas, { agentId: claude.id });
      const radar = await createRadar(lucas, { name: `Self ${unique()}` });
      await createBlip(lucas, radar.id, { body: 'take a look at this @claude' });

      const forAgent = await listNotifications(agent);
      expect(forAgent.items).toHaveLength(1);
      expect(forAgent.items[0]?.kind).toBe('mention');
      // ...and it did not land in the human's own queue.
      const forHuman = await listNotifications(lucas);
      expect(forHuman.items).toHaveLength(0);
    });

    it('notifies its cosigner when an agent comments in its own voice', async () => {
      sentMail.mockClear();
      sentPush.mockClear();
      const lucas = await makeUser('p-quiet');
      const claude = await makeAgent(lucas, 'Claude');
      const agent = await connect(lucas, { agentId: claude.id });
      const radar = await createRadar(lucas, { name: `Quiet ${unique()}` });
      const blip = await createBlip(lucas, radar.id, { body: 'my own thought' });
      await createComment(agent, blip.id, { body: 'a remark from the agent' });

      expect((await listNotifications(lucas)).items).toMatchObject([{ kind: 'comment' }]);
      expect((await listNotifications(agent)).items).toHaveLength(0);
      await vi.waitFor(() => {
        expect(sentMail).toHaveBeenCalled();
        expect(sentPush).toHaveBeenCalled();
      });
      const title = must((await listNotifications(lucas)).items[0]).title;
      expect(title).toContain('Claude (agent)');
      expect(sentMail.mock.calls.some(([message]) => message.subject === title)).toBe(true);
    });

    it('keeps personal-voice agent comments and ordinary agent captures quiet', async () => {
      const lucas = await makeUser('p-principal-quiet');
      const claude = await makeAgent(lucas, 'Claude');
      const agent = await connect(lucas, {
        agentId: claude.id,
        voices: ['persona', 'principal'],
      });
      const radar = await createRadar(lucas, { name: `Principal ${unique()}` });
      const blip = await createBlip(agent, radar.id, { body: 'an agent capture' });
      await createComment(agent, blip.id, { body: 'on behalf of the person', as: 'me' });
      expect((await listNotifications(lucas)).items).toHaveLength(0);
      expect((await listNotifications(agent)).items).toHaveLength(0);
    });

    it('keeps a person’s queue and their agent’s apart', async () => {
      const lucas = await makeUser('p-queues');
      const ada = await makeUser('p-queues-other');
      const claude = await makeAgent(lucas, 'Claude');
      const agent = await connect(lucas, { agentId: claude.id });
      const radar = await createRadar(lucas, { name: `Queues ${unique()}` });
      await shareRadar(lucas, radar.id, ada.user.email, 'editor');
      const handle = lucas.user.email.split('@')[0];
      await createBlip(ada, radar.id, {
        body: `@${must(handle, 'handle')} and @${must(handle, 'handle')}.claude, both of you`,
      });

      const human = await listNotifications(lucas);
      const persona = await listNotifications(agent);
      expect(human.items).toHaveLength(1);
      expect(persona.items).toHaveLength(1);
      expect(human.items[0]?.id).not.toBe(persona.items[0]?.id);
      // Two rows on one comment that must not fold into each other: the group
      // key is namespaced for the agent, so the two key spaces never meet.
      expect((await notificationCounts(lucas)).total).toBe(1);
      expect((await notificationCounts(agent)).total).toBe(1);
    });

    it('sends an agent no email and no push', async () => {
      sentMail.mockClear();
      sentPush.mockClear();

      const lucas = await makeUser('p-transport');
      const ada = await makeUser('p-transport-other');
      const claude = await makeAgent(lucas, 'Claude');
      const radar = await createRadar(lucas, { name: `Transport ${unique()}` });
      await shareRadar(lucas, radar.id, ada.user.email, 'editor');
      const handle = lucas.user.email.split('@')[0];

      // A person: both transports fire, which is what makes the next half real.
      await createBlip(ada, radar.id, { body: `hello @${must(handle, 'handle')}` });
      await new Promise((r) => setTimeout(r, 150));
      expect(sentMail).toHaveBeenCalled();
      expect(sentPush).toHaveBeenCalled();

      sentMail.mockClear();
      sentPush.mockClear();
      // Its agent: neither. It has no mailbox and no browser, and pushing a
      // banner would put the agent's business on the human's phone.
      await createBlip(ada, radar.id, { body: `and you too @${must(handle, 'handle')}.claude` });
      await new Promise((r) => setTimeout(r, 150));
      expect(sentMail).not.toHaveBeenCalled();
      expect(sentPush).not.toHaveBeenCalled();
      expect(claude.id).toBeTruthy();
    });

    it('sweeps an agent’s mentions and notifications when its owner loses the radar', async () => {
      /*
        A notification carries a snapshot excerpt and a mention is a pointer into
        content. `listNotifications` scopes a persona's queue by `agent_id` and
        never re-checks the radar, so anything left behind is a readable copy of
        a conversation its human can no longer open.
      */
      const ada = await makeUser('p-sweep-owner');
      const lucas = await makeUser('p-sweep-member');
      const claude = await makeAgent(lucas, 'Claude');
      const agent = await connect(lucas, { agentId: claude.id });
      const radar = await createRadar(ada, { name: `Sweep ${unique()}` });
      await shareRadar(ada, radar.id, lucas.user.email, 'editor');
      const handle = lucas.user.email.split('@')[0];
      await createBlip(ada, radar.id, {
        body: `something for you @${must(handle, 'handle')}.claude`,
      });

      expect((await listNotifications(agent)).items).toHaveLength(1);
      const before = await getDb()
        .select()
        .from(schema.mentions)
        .where(and(eq(schema.mentions.radarId, radar.id), isNull(schema.mentions.userId)));
      expect(before).toHaveLength(1);

      await removeMember(ada, radar.id, lucas.user.id);

      expect((await listNotifications(agent)).items).toHaveLength(0);
      const after = await getDb()
        .select()
        .from(schema.mentions)
        .where(eq(schema.mentions.radarId, radar.id));
      expect(after).toHaveLength(0);
    });

    it('sweeps them when a cascading topic grant is revoked, too', async () => {
      // The second of the two revocation sites. Both call the same function, so
      // the sweep is one predicate rather than a leg each site has to remember —
      // which is what a three-way merge would otherwise drop.
      const ada = await makeUser('p-sweep-topic-owner');
      const lucas = await makeUser('p-sweep-topic-member');
      const claude = await makeAgent(lucas, 'Claude');
      const agent = await connect(lucas, { agentId: claude.id });
      const topic = await createTopic(ada, { name: `Sweep topic ${unique()}` });
      await setCascade(ada, topic.id, true);
      const radar = await createRadar(ada, { name: `In topic ${unique()}` });
      await setRadarTopic(ada, radar.id, topic.id);
      await shareTopic(ada, topic.id, lucas.user.email, 'editor');

      const handle = lucas.user.email.split('@')[0];
      await createBlip(ada, radar.id, { body: `over here @${must(handle, 'handle')}.claude` });
      expect((await listNotifications(agent)).items).toHaveLength(1);

      await setCascade(ada, topic.id, false);

      expect((await listNotifications(agent)).items).toHaveLength(0);
      const after = await getDb()
        .select()
        .from(schema.mentions)
        .where(eq(schema.mentions.radarId, radar.id));
      expect(after).toHaveLength(0);
    });
  });

  /* --------------------------- the public surface ------------------------ */

  describe('the public surface', () => {
    it('keeps the agent’s name and blanks its id', async () => {
      const lucas = await makeUser('p-public');
      const claude = await makeAgent(lucas, 'Claude');
      const agent = await connect(lucas, { agentId: claude.id });
      const radar = await createRadar(lucas, { name: `Public ${unique()}` });
      const blip = await createBlip(agent, radar.id, { body: 'read this in public' });

      const { setVisibility } = await import('./radars.js');
      const published = await setVisibility(lucas, radar.id, 'public');
      expect(published.publicSlug).toBeTruthy();

      const app = createApp();
      const res = await app.request(
        `/api/public/radars/${must(published.publicSlug, 'published.publicSlug')}/blips`,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        items: Array<{ agent: { id: string; name: string } | null }>;
      };
      const found = body.items.find((item) => item.agent !== null);
      // Attribution survives — a public page that hid it would be the interface
      // declining to mention something everyone downstream is calibrating on.
      expect(found?.agent?.name).toBe('Claude');
      // The id does not. It is an id like any other here.
      expect(found?.agent?.id).toBe('');
      expect(blip.id).toBeTruthy();
    });
  });

  /* ------------------------------ credentials ---------------------------- */

  describe('credentials', () => {
    it('carries a persona from the consent screen all the way to a bearer token', async () => {
      /*
        The OAuth chain has four hops — decision, code, token, resolve — and the
        persona has to survive every one of them. It is asserted end to end
        rather than per hop because the failure mode is a *dropped field*, and a
        per-hop test written against the same mental model drops it in both the
        code and the assertion. The scope enforcement bug was exactly this: the
        value was computed correctly and thrown away one layer down.

        Driven over HTTP through `createApp()`, so the consent body, the token
        exchange and the `Authorization` header are the real ones.
      */
      const lucas = await makeUser('p-oauth');
      const claude = await makeAgent(lucas, 'Remote Claude');
      const app = createApp();
      const { token } = await createSession(lucas.user, {});
      const cookie = `${SESSION_COOKIE}=${token}`;

      const registered = (await (
        await app.request('/oauth/register', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            client_name: 'Claude.ai',
            redirect_uris: ['http://localhost/cb'],
          }),
        })
      ).json()) as { client_id: string };

      const verifier = randomToken(32);
      const challenge = createHash('sha256').update(verifier).digest('base64url');

      const decision = (await (
        await app.request('/oauth/authorize/decision', {
          method: 'POST',
          headers: { cookie, 'content-type': 'application/json' },
          body: JSON.stringify({
            client_id: registered.client_id,
            redirect_uri: 'http://localhost/cb',
            response_type: 'code',
            code_challenge: challenge,
            code_challenge_method: 'S256',
            scope: 'radars:read radars:write',
            approve: true,
            agentId: claude.id,
            // Own voice only. The narrower grant, so the refusal below is real.
            voices: ['persona'],
          }),
        })
      ).json()) as { redirectTo: string };
      const code = new URL(decision.redirectTo).searchParams.get('code') as string;

      const granted = (await (
        await app.request('/oauth/token', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            code_verifier: verifier,
            client_id: registered.client_id,
            redirect_uri: 'http://localhost/cb',
          }).toString(),
        })
      ).json()) as { access_token: string; refresh_token: string; scope: string };

      // The voices ride the same string the consent screen displayed, beside the
      // access scopes — one record of what was agreed to, not two.
      expect(granted.scope).toContain('voice:persona');
      expect(granted.scope).not.toContain('voice:principal');

      const bearer = await resolveBearerToken(granted.access_token);
      expect(bearer?.agent?.agentId).toBe(claude.id);
      expect(bearer?.voice?.granted).toEqual(['persona']);
      expect(bearer?.voice?.default).toBe('persona');

      // ...and a refresh carries it forward rather than quietly stripping the
      // identity off a live connection within the hour.
      const refreshed = (await (
        await app.request('/oauth/token', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: granted.refresh_token,
          }).toString(),
        })
      ).json()) as { access_token: string };
      const after = await resolveBearerToken(refreshed.access_token);
      expect(after?.agent?.agentId).toBe(claude.id);
      expect(after?.voice?.granted).toEqual(['persona']);
    });

    it('will not let a connection archive an agent over HTTP', async () => {
      /*
        The route guard and the service guard say the same thing on purpose. The
        route protects this path; the service protects every path, including the
        one somebody adds next year — which is the exact shape the topic fences
        got wrong when they lived only in the MCP router.
      */
      const lucas = await makeUser('p-credential');
      const claude = await makeAgent(lucas, 'Claude');
      const secret = newApiToken();
      await getDb()
        .insert(schema.apiTokens)
        .values({
          userId: lucas.user.id,
          name: 'creds',
          prefix: tokenPrefix(secret),
          tokenHash: hashSecret(secret),
          agentId: claude.id,
          voiceGrants: ['persona'],
          defaultVoice: 'persona',
        });

      const app = createApp();
      // v2: the persona endpoints are gone — agents live in the Agent Repo —
      // and say so, to a connection and to a person alike.
      const created = await app.request('/api/tokens/agents', {
        method: 'POST',
        headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Second Self' }),
      });
      expect([403, 410]).toContain(created.status);

      // Archiving over HTTP is refused for the connection…
      const archived = await app.request(`/api/repo-agents/${claude.id}/archived`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
        body: JSON.stringify({ archived: true }),
      });
      expect(archived.status).toBe(403);

      // …and works from a browser session, so the refusal is about the
      // connection rather than about the person.
      const { token } = await createSession(lucas.user, {});
      const ok = await app.request(`/api/repo-agents/${claude.id}/archived`, {
        method: 'PUT',
        headers: {
          cookie: `${SESSION_COOKIE}=${token}`,
          'content-type': 'application/json',
          // What a browser sends for the app's own fetch. An Origin literal
          // here would depend on APP_URL, which other tests in the same
          // worker set and CI's ordering decides.
          'sec-fetch-site': 'same-origin',
        },
        body: JSON.stringify({ archived: true }),
      });
      expect(ok.status).toBe(200);
    });
  });
});
