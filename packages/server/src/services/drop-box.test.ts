/**
 * What the drop box refuses, against a real Postgres.
 *
 * The drop box is the one radar in the application nobody chose the contents
 * of. Everything else is a place you decided to keep a kind of thing; this is
 * the pile you have not looked at. Two rules follow from that and both are
 * tested here as *refusals on every path*, because a rule enforced in one place
 * and not another is the shape every disclosure in this codebase has had:
 *
 * - **It has no public address.** Not the flag and not the slug — they come
 *   apart, because a slug deliberately survives going private so that
 *   re-publishing restores the same URL. Service refusal *and* CHECK constraint,
 *   the same arrangement the topic exclusions have, and the constraint is
 *   asserted by name so the assertion means "this specific rule refused it".
 * - **It is a stream or a board.** Registry-driven and therefore not constrained
 *   in SQL, which is a deliberate divergence from the rule above and is asserted
 *   as such: the template vocabulary lives in TypeScript so a new template needs
 *   no migration, and a CHECK naming template ids would revoke that.
 *
 * The template cases are generated from `RADAR_TEMPLATES` rather than listed, so
 * a template added later is covered by whichever side of the line it declares
 * itself on and nobody has to remember to come back here.
 *
 * Also here: a webhook may not be pointed at the drop box. That is a *holding*
 * refusal rather than a settled one — an ingest URL into a private inbox is the
 * un-designed version of the external-drop feature, and it is reachable over MCP
 * by an agent that holds manage on the drop box the moment it connects.
 *
 * Skipped when DATABASE_URL is absent, so `pnpm test` still runs with no
 * database. CI sets it, so this runs there.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  DEFAULT_DROP_BOX_TEMPLATE,
  DROP_BOX_TEMPLATE_IDS,
  isDropBoxTemplate,
  RADAR_TEMPLATES,
  RADAR_TEMPLATE_IDS,
} from '@onmyradar/contract';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import type { Actor } from '../http.js';
import { requireRadar } from './access.js';
import {
  createRadar,
  ensureDropBox,
  listMembers,
  removeMember,
  rotatePublicSlug,
  setVisibility,
  shareRadar,
  updateRadar,
} from './radars.js';
import { createWebhook } from './webhooks.js';

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

/**
 * The name of the CHECK constraint a raw write trips, or null if it succeeded.
 *
 * Same shape as the helper in `topics.test.ts`, and for the same reason: `pg`
 * puts the constraint name on the error, Drizzle wraps it, so the name is only
 * reachable through `cause`. Naming it is what makes the assertion mean "this
 * rule refused it" rather than "something went wrong".
 */
async function constraintViolated(
  radarId: string,
  patch: Partial<typeof schema.radars.$inferInsert>,
): Promise<string | null> {
  try {
    await getDb().update(schema.radars).set(patch).where(eq(schema.radars.id, radarId));
    return null;
  } catch (err) {
    let cursor: unknown = err;
    for (let depth = 0; depth < 5 && cursor; depth += 1) {
      const named = (cursor as { constraint?: string }).constraint;
      if (typeof named === 'string') return named;
      cursor = (cursor as { cause?: unknown }).cause;
    }
    throw err;
  }
}

async function rowFor(radarId: string) {
  const rows = await getDb().select().from(schema.radars).where(eq(schema.radars.id, radarId));
  const row = rows[0];
  if (!row) throw new Error('radar vanished');
  return row;
}

describe.skipIf(!hasDatabase)('the drop box is never public (real postgres)', () => {
  let owner: Actor;

  beforeAll(async () => {
    await runMigrations();
    owner = await makeUser('db-public');
  }, 30_000);

  afterAll(async () => {
    await closeDb();
  });

  it('refuses to publish, and says why', async () => {
    const dropBox = await ensureDropBox(owner);
    await expect(setVisibility(owner, dropBox.id, 'public')).rejects.toThrow(/drop box/i);
    // The refusal has to be about the drop box being an inbox, not a generic
    // "no". A sentence that does not name the reason is a sentence somebody
    // reads as a bug and works around.
    await expect(setVisibility(owner, dropBox.id, 'public')).rejects.toThrow(/private inbox/i);
  });

  it('leaves the row exactly as it was after a refused publish', async () => {
    const dropBox = await ensureDropBox(owner);
    await expect(setVisibility(owner, dropBox.id, 'public')).rejects.toThrow();
    const row = await rowFor(dropBox.id);
    expect(row.visibility).toBe('private');
    // The half that would otherwise survive being switched off.
    expect(row.publicSlug).toBeNull();
    expect(row.allowIndex).toBe(false);
  });

  it('refuses to mint a public link, which is the half that outlives the flag', async () => {
    const dropBox = await ensureDropBox(owner);
    await expect(rotatePublicSlug(owner, dropBox.id)).rejects.toThrow(/drop box/i);
    expect((await rowFor(dropBox.id)).publicSlug).toBeNull();
  });

  it('is refused by a CHECK constraint, not only by the service', async () => {
    const dropBox = await ensureDropBox(owner);
    expect(await constraintViolated(dropBox.id, { visibility: 'public' })).toBe(
      'radars_drop_box_is_never_public',
    );
  });

  it('cannot even carry a dormant public slug', async () => {
    const dropBox = await ensureDropBox(owner);
    expect(await constraintViolated(dropBox.id, { publicSlug: 'abcdefghijkl' })).toBe(
      'radars_drop_box_has_no_public_slug',
    );
  });

  it('constrains the drop box and nothing else — an ordinary radar still publishes', async () => {
    const radar = await createRadar(owner, { name: `Publishable ${Math.random()}` });
    const published = await setVisibility(owner, radar.id, 'public');
    expect(published.visibility).toBe('public');
    expect(published.publicSlug).toBeTruthy();

    const rotated = await rotatePublicSlug(owner, radar.id);
    expect(rotated.publicSlug).toBeTruthy();
    expect(rotated.publicSlug).not.toBe(published.publicSlug);
  });
});

describe.skipIf(!hasDatabase)('the drop box is a stream or a board (real postgres)', () => {
  let owner: Actor;

  beforeAll(async () => {
    await runMigrations();
    owner = await makeUser('db-template');
  }, 30_000);

  afterAll(async () => {
    await closeDb();
  });

  it('provisions on the stream, stated rather than defaulted', async () => {
    const fresh = await makeUser('db-fresh');
    const dropBox = await ensureDropBox(fresh);
    expect(dropBox.template).toBe(DEFAULT_DROP_BOX_TEMPLATE);
    expect(dropBox.template).toBe('stream');
    // Whatever the default is, it must be one of the templates a drop box may
    // hold — otherwise every account provisions an invalid row.
    expect(DROP_BOX_TEMPLATE_IDS).toContain(DEFAULT_DROP_BOX_TEMPLATE);
  });

  // Generated from the registry so a template added later lands in the right
  // half of this suite without anybody editing it.
  const allowed = RADAR_TEMPLATE_IDS.filter((id) => RADAR_TEMPLATES[id].inbox);
  const refused = RADAR_TEMPLATE_IDS.filter((id) => !RADAR_TEMPLATES[id].inbox);

  it('the registry splits the templates into two non-empty halves', () => {
    // A guard on the generated cases below: if either half emptied, the loops
    // would silently assert nothing at all.
    expect(allowed.length).toBeGreaterThan(0);
    expect(refused.length).toBeGreaterThan(0);
    expect([...allowed].sort()).toEqual([...DROP_BOX_TEMPLATE_IDS].sort());
  });

  for (const id of allowed) {
    it(`accepts ${id}, which declares itself an inbox`, async () => {
      const dropBox = await ensureDropBox(owner);
      const updated = await updateRadar(owner, dropBox.id, { template: id });
      expect(updated.template).toBe(id);
    });
  }

  for (const id of refused) {
    it(`refuses ${id}, which decides what its blips are`, async () => {
      const dropBox = await ensureDropBox(owner);
      const before = (await rowFor(dropBox.id)).template;
      await expect(updateRadar(owner, dropBox.id, { template: id })).rejects.toThrow(/drop box/i);
      expect((await rowFor(dropBox.id)).template).toBe(before);
    });
  }

  it('refuses before applying anything else in the same call', async () => {
    const dropBox = await ensureDropBox(owner);
    await updateRadar(owner, dropBox.id, { template: 'stream' });
    const before = await rowFor(dropBox.id);

    await expect(
      updateRadar(owner, dropBox.id, { name: 'Renamed by a rejected call', template: 'reading' }),
    ).rejects.toThrow(/drop box/i);

    const after = await rowFor(dropBox.id);
    expect(after.name).toBe(before.name);
    expect(after.template).toBe(before.template);
  });

  it('constrains the drop box and nothing else — an ordinary radar takes any template', async () => {
    const radar = await createRadar(owner, { name: `Anything goes ${Math.random()}` });
    for (const id of RADAR_TEMPLATE_IDS) {
      const updated = await updateRadar(owner, radar.id, { template: id });
      expect(updated.template).toBe(id);
    }
  });

  it('has NO CHECK constraint behind it, deliberately', async () => {
    const dropBox = await ensureDropBox(owner);
    // The divergence from the publishing rule above, asserted rather than left
    // as an absence somebody later reads as an oversight. The template
    // vocabulary lives in the registry precisely so that adding one needs no
    // migration; a CHECK naming template ids would take that away and would be
    // a second place for the answer to live.
    expect(await constraintViolated(dropBox.id, { template: 'reading' })).toBeNull();
    // Put it back, so the raw write above does not leak into another test.
    await getDb()
      .update(schema.radars)
      .set({ template: DEFAULT_DROP_BOX_TEMPLATE })
      .where(eq(schema.radars.id, dropBox.id));
  });
});

describe('the registry decides, not a pair of ids', () => {
  it('every allowed template declares itself an inbox', () => {
    for (const id of DROP_BOX_TEMPLATE_IDS) expect(RADAR_TEMPLATES[id].inbox).toBe(true);
  });

  it('an unknown template id is refused, where rendering would degrade it', () => {
    // `templateFor` deliberately degrades an unknown id to the stream so a radar
    // from a future build still opens. A *refusal* must not degrade the same
    // way, or an unrecognised id becomes the way past the rule.
    expect(isDropBoxTemplate('not-a-template')).toBe(false);
    expect(isDropBoxTemplate(null)).toBe(false);
    expect(isDropBoxTemplate(undefined)).toBe(false);
    expect(isDropBoxTemplate('stream')).toBe(true);
  });
});

describe.skipIf(!hasDatabase)('the drop box takes no webhook yet (real postgres)', () => {
  let owner: Actor;

  beforeAll(async () => {
    await runMigrations();
    owner = await makeUser('db-hook');
  }, 30_000);

  afterAll(async () => {
    await closeDb();
  });

  it('refuses an ingest URL into a private inbox', async () => {
    const dropBox = await ensureDropBox(owner);
    await expect(createWebhook(owner, dropBox.id, { name: 'Drop here' })).rejects.toThrow(
      /drop box/i,
    );
  });

  it('leaves webhooks on ordinary radars alone', async () => {
    const radar = await createRadar(owner, { name: `Hookable ${Math.random()}` });
    const hook = await createWebhook(owner, radar.id, { name: 'Form' });
    expect(hook.secretUrl).toBeTruthy();
  });
});

/**
 * An agent may not hand the drop box to anybody. A person still may.
 *
 * A security review reported the drop box being shareable as an inconsistency
 * with the three refusals above, and it is **not** one: §6.1 settles it
 * deliberately, and §6.2's whole recommendation for external drops — "you never
 * publish an address, you mint one per recipient" — depends on a named,
 * individually revocable grant being a different act from having an address. So
 * the first assertion here is that sharing a drop box from the app still works.
 * The demonstration the review offered showed sharing working, not a hole.
 *
 * What it did surface, by a route §6.2 had not applied to this path, is the MCP
 * boundary. That section already argues it about webhooks — "it matters most
 * over MCP, where an agent holds manage on the drop box the moment it connects"
 * — and the same sentence is true of `share_radar`. The drop box is the one
 * radar an agent is routinely pointed at, and `read_drop_box` exists to hand it
 * the whole unsorted pile. Same shape as `assertMayInvite`: an agent may share,
 * because its human could, but an act whose consequence reaches beyond this
 * account needs a person.
 *
 * The `kind` on the actor is the only difference between the two halves below,
 * which is what makes this a boundary rather than a rule about drop boxes.
 */
describe.skipIf(!hasDatabase)('who may share the drop box (real postgres)', () => {
  let owner: Actor;
  let other: Actor;
  /** The same human, reaching in over MCP instead of from the app. */
  let ownersAgent: Actor;

  beforeAll(async () => {
    await runMigrations();
    owner = await makeUser('db-share');
    other = await makeUser('db-recipient');
    ownersAgent = { ...owner, kind: 'agent' };
  }, 30_000);

  afterAll(async () => {
    await closeDb();
  });

  it('lets the owner share it from the app, which §6.1 decided on purpose', async () => {
    const dropBox = await ensureDropBox(owner);
    const result = await shareRadar(owner, dropBox.id, other.user.email, 'viewer');
    expect(result.status).toBe('added');
    // A deliberate, named, individually revocable grant — and it really works,
    // rather than being a button that 403s.
    await expect(requireRadar(dropBox.id, other, 'read')).resolves.toBeTruthy();

    // Revocable individually, which is the property the whole distinction rests
    // on: this is not an address, and taking it back breaks nothing else.
    await removeMember(owner, dropBox.id, other.user.id);
    await expect(requireRadar(dropBox.id, other, 'read')).rejects.toThrow(/not found/i);
  });

  it('refuses the identical call made by an agent on the same account', async () => {
    const dropBox = await ensureDropBox(owner);
    await expect(shareRadar(ownersAgent, dropBox.id, other.user.email, 'viewer')).rejects.toThrow(
      /agent may do/i,
    );
    // Refused, not silently ignored: nobody was added.
    const members = await listMembers(await requireRadar(dropBox.id, owner, 'read'));
    expect(members.map((m) => m.email)).toEqual([owner.user.email]);
    await expect(requireRadar(dropBox.id, other, 'read')).rejects.toThrow(/not found/i);
  });

  it('refuses an agent inviting an address with no account, by both rules at once', async () => {
    const dropBox = await ensureDropBox(owner);
    await expect(
      shareRadar(ownersAgent, dropBox.id, `stranger-${Date.now()}@example.test`, 'editor'),
    ).rejects.toThrow();
  });

  it('leaves an agent free to share every other radar', async () => {
    const radar = await createRadar(owner, { name: `Agent shareable ${Math.random()}` });
    const result = await shareRadar(ownersAgent, radar.id, other.user.email, 'viewer');
    // The boundary is about the drop box, not about agents sharing — narrowing
    // it further would take away something §19 decided an agent may do.
    expect(result.status).toBe('added');
    await expect(requireRadar(radar.id, other, 'read')).resolves.toBeTruthy();
  });
});
