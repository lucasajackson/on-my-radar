/**
 * `link_charter` against a real Postgres (plan e715ea20, S5): a passage tied to a boundary or
 * contract, across paragraphs, with an element made in the same call; links that orphan with the
 * text and flag the element; what the reads return; the delete guard. Skipped without DATABASE_URL.
 */
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { projectionOf } from './charter-model.js';
import { charterDatabase, CHARTER } from './charter-test-kit.js';
import { linkCharter } from './charter-links.js';
import { readArchitecture, trace, upsertContract } from './architecture.js';
import { deleteBlip } from './blips.js';
import { shareRadar } from './radars.js';
import { restoreCharter } from './charter-versions.js';
import { schema } from '../db/client.js';
import { must } from '../errors.js';

const refused = (promise: Promise<unknown>, code: string) =>
  expect(promise).rejects.toMatchObject({ code });

describe.skipIf(!process.env['DATABASE_URL'])(
  'charter links (real postgres)',
  { timeout: 30_000 },
  () => {
    const kit = charterDatabase('omr_links');
    const read = (
      radarId: string,
      query: Parameters<typeof readArchitecture>[2] = { view: 'amended' },
    ) => readArchitecture(kit.owner, radarId, query);

    it('ties a passage to an existing boundary and shows it on the element and in the list', async () => {
      const radar = await kit.radar();
      const billing = await kit.boundary(radar, 'Billing');
      const before = await kit.versionsOf(radar);
      const result = await linkCharter(kit.owner, radar, {
        quote: 'Commander never stores card data.',
        element: billing.id,
      });
      expect(result.element).toMatchObject({ id: billing.id, kind: 'boundary', created: false });
      expect(result.link).toMatchObject({
        state: 'anchored',
        excerpt: 'Commander never stores card data.',
        section: ['Charter', 'Billing'],
        element: { id: billing.id, title: 'Billing', kind: 'boundary' },
      });
      // The link sealed a version of its own, caused by the element, that holds its range.
      const after = await kit.versionsOf(radar);
      expect(after).toHaveLength(before.length + 1);
      const sealed = must(after[after.length - 1]);
      expect(sealed).toMatchObject({ cause: 'anchor', causeBlipId: billing.id });
      expect(result.link.resolvedVersion).toBe(sealed.version);
      expect(sealed.anchors[result.link.id]).toBeTruthy();

      const arch = await read(radar);
      expect(arch.links).toEqual([result.link]);
      expect(arch.boundaries.find((b) => b.id === billing.id)?.charter).toEqual({
        state: 'linked',
        links: [result.link.id],
      });
      // The anchor row is an ordinary link anchor.
      const [row] = (await kit.anchorsOf(radar)).filter((a) => a.kind === 'link');
      expect(row).toMatchObject({ subjectId: billing.id, state: 'anchored', withText: null });
      // trace says the same.
      const traced = await trace(kit.owner, billing.id);
      expect(traced).toMatchObject({ kind: 'boundary', links: [{ id: result.link.id }] });
    });

    it('says where an anchored link is in the head text, and not in a past version', async () => {
      const radar = await kit.radar();
      const billing = await kit.boundary(radar, 'Billing');
      const quote = 'Commander never stores card data.';
      const { link } = await linkCharter(kit.owner, radar, { quote, element: billing.id });
      const head = await read(radar, { view: 'written' });
      const placed = must(head.links?.[0]);
      expect(placed.id).toBe(link.id);
      const text = projectionOf(must(head.charter[0]?.markdown)).text;
      expect(text.slice(must(placed.start), must(placed.end))).toBe(quote);
      // An orphan has no place; a past version reads head's links without head's offsets.
      const past = await read(radar, { view: 'written', version: link.resolvedVersion });
      expect(past.links?.[0]).not.toHaveProperty('start');
      await kit.write(radar, (t) => t.replace(quote, 'Card data lives only at Stripe.'));
      expect((await read(radar, { view: 'written' })).links?.[0]).not.toHaveProperty('start');
    });

    it('answers a retry with the same idempotencyKey with the link it made, once', async () => {
      const radar = await kit.radar();
      const billing = await kit.boundary(radar, 'Billing');
      const request = {
        quote: 'Commander never stores card data.',
        element: billing.id,
        idempotencyKey: 'link-1',
      };
      const first = await linkCharter(kit.owner, radar, request);
      const again = await linkCharter(kit.owner, radar, request);
      expect(again.link).toEqual(first.link);
      expect(again.element).toMatchObject({ id: billing.id, created: false });
      expect((await kit.anchorsOf(radar)).filter((a) => a.kind === 'link')).toHaveLength(1);
      // The same key for another request is a conflict, not a second link.
      await refused(
        linkCharter(kit.owner, radar, { ...request, quote: 'Commander owns the hosting plan.' }),
        'conflict',
      );
    });

    it('makes the new element once under a key, and a retry reads the link back', async () => {
      const radar = await kit.radar();
      const request = {
        quote: 'Commander owns the hosting plan.',
        element: { kind: 'boundary' as const, title: 'Retry service' },
        idempotencyKey: 'link-2',
      };
      const first = await linkCharter(kit.owner, radar, request);
      expect(first.element.created).toBe(true);
      const again = await linkCharter(kit.owner, radar, request);
      expect(again.link).toEqual(first.link);
      expect(again.element).toMatchObject({ id: first.element.id, created: false });
      const arch = await read(radar);
      expect(arch.boundaries.filter((b) => b.title === 'Retry service')).toHaveLength(1);
      expect(arch.links).toHaveLength(1);
    });

    it('leaves a read with no links exactly as it was: no charter state, no links list', async () => {
      const radar = await kit.radar();
      await kit.boundary(radar, 'Plain');
      const arch = await read(radar);
      expect(arch).not.toHaveProperty('links');
      expect(arch.boundaries.every((b) => !('charter' in b))).toBe(true);
      expect(await trace(kit.owner, must(arch.boundaries[0]).id)).not.toHaveProperty('links');
    });

    it('spans paragraphs and a heading, up to 4,000 characters, where an amendment could not', async () => {
      const radar = await kit.radar();
      const hosting = await kit.boundary(radar, 'Hosting');
      const quote =
        'never stores card data.\n\nHosting\n\nCommander owns the hosting plan.\n\nComponent\n\nRule';
      const { link } = await linkCharter(kit.owner, radar, { quote, element: hosting.id });
      const [row] = (await kit.anchorsOf(radar)).filter((a) => a.id === link.id);
      const projection = projectionOf(
        must((await read(radar, { view: 'written' })).charter[0]?.markdown),
      );
      expect(projection.text.slice(must(row).posStart ?? 0, must(row).posEnd ?? 0)).toBe(
        must(row).quote,
      );
      expect(must(row).quote.split('\n\n')).toHaveLength(5);
      expect(link.excerpt.length).toBeLessThanOrEqual(120);
    });

    it('picks a repeated sentence by its context, and refuses to guess without it', async () => {
      const radar = await kit.radar();
      const billing = await kit.boundary(radar, 'Billing');
      await refused(
        linkCharter(kit.owner, radar, {
          quote: 'Stripe is the billing source of truth.',
          element: billing.id,
        }),
        'quote_ambiguous',
      );
      const { link } = await linkCharter(kit.owner, radar, {
        quote: 'Stripe is the billing source of truth.',
        prefix: 'Appendix',
        element: billing.id,
      });
      expect(link.section).toEqual(['Charter', 'Appendix']);
      await refused(
        linkCharter(kit.owner, radar, { quote: 'not in the charter at all', element: billing.id }),
        'quote_not_found',
      );
      // The same passage twice to the same element is one link.
      await refused(
        linkCharter(kit.owner, radar, {
          quote: 'Stripe is the billing source of truth.',
          prefix: 'Appendix',
          element: billing.id,
        }),
        'already_linked',
      );
    });

    it('makes a new boundary or contract in the same call, and nothing at all when the quote fails', async () => {
      const radar = await kit.radar();
      const elementsOf = async () =>
        (await kit.db().select().from(schema.blips).where(eq(schema.blips.radarId, radar))).filter(
          (b) => b.status === 'boundary' || b.status === 'contract',
        );
      const made = await linkCharter(kit.owner, radar, {
        quote: 'Commander owns the hosting plan.',
        element: { kind: 'boundary', title: 'Hosting service', owns: ['plans'] },
      });
      expect(made.element).toMatchObject({
        kind: 'boundary',
        title: 'Hosting service',
        created: true,
      });
      const arch = await read(radar);
      expect(arch.boundaries).toMatchObject([
        { id: made.element.id, owns: ['plans'], charter: { state: 'linked' } },
      ]);

      const before = (await elementsOf()).length;
      await refused(
        linkCharter(kit.owner, radar, {
          quote: 'a sentence the charter never had',
          element: { kind: 'boundary', title: 'Ghost' },
        }),
        'quote_not_found',
      );
      expect(await elementsOf()).toHaveLength(before);
      // A title already taken is a refusal, never a quiet reuse of the old element.
      await refused(
        linkCharter(kit.owner, radar, {
          quote: 'Commander owns the hosting plan.',
          element: { kind: 'boundary', title: 'hosting SERVICE' },
        }),
        'title_taken',
      );
      expect(await elementsOf()).toHaveLength(before);

      const web = await kit.boundary(radar, 'Web');
      const contract = await linkCharter(kit.owner, radar, {
        quote: 'Runs on blue-kube',
        element: {
          kind: 'contract',
          title: 'Web to hosting',
          a: web.id,
          b: made.element.id,
          version: '1',
        },
      });
      expect(contract.element.kind).toBe('contract');
      expect((await read(radar)).contracts[0]).toMatchObject({
        a: web.id,
        b: made.element.id,
        charter: { state: 'linked', links: [contract.link.id] },
      });
      // An invalid contract (the same boundary twice) leaves neither the contract nor the link.
      const links = (await kit.anchorsOf(radar)).filter((a) => a.kind === 'link').length;
      await refused(
        linkCharter(kit.owner, radar, {
          quote: 'Runs on blue-kube',
          element: { kind: 'contract', title: 'Loop', a: web.id, b: web.id },
        }),
        'same_boundary',
      );
      expect((await kit.anchorsOf(radar)).filter((a) => a.kind === 'link')).toHaveLength(links);
    });

    it('refuses what is not a boundary or contract of this radar: another radar’s is not found', async () => {
      const radar = await kit.radar();
      const other = await kit.radar();
      const foreign = await kit.boundary(other, 'Foreign');
      await expect(
        linkCharter(kit.owner, radar, {
          quote: 'Commander owns the hosting plan.',
          element: foreign.id,
        }),
      ).rejects.toMatchObject({ status: 404 });
      const [page] = await kit
        .db()
        .select()
        .from(schema.blips)
        .where(eq(schema.blips.id, foreign.id));
      expect(page?.radarId).toBe(other);
      // The charter's own radar id, or a plain blip, is not an element.
      const [adrLike] = await kit
        .db()
        .insert(schema.blips)
        .values({
          radarId: radar,
          authorId: kit.owner.user.id,
          state: 'inbox',
          status: 'proposed',
          title: 'ADR-1: x',
          body: 'x',
        })
        .returning();
      await expect(
        linkCharter(kit.owner, radar, {
          quote: 'Commander owns the hosting plan.',
          element: must(adrLike).id,
        }),
      ).rejects.toMatchObject({ status: 422, code: 'not_an_element' });
      expect((await kit.anchorsOf(radar)).filter((a) => a.kind === 'link')).toHaveLength(0);
    });

    it('needs write access: a viewer is refused, and the document is untouched', async () => {
      const radar = await kit.radar();
      const billing = await kit.boundary(radar, 'Billing');
      const viewer = await kit.user(`viewer${Math.random().toString(36).slice(2, 7)}`);
      await shareRadar(kit.owner, radar, viewer.user.email, 'viewer');
      await expect(
        linkCharter(viewer, radar, {
          quote: 'Commander owns the hosting plan.',
          element: billing.id,
        }),
      ).rejects.toMatchObject({ status: 403 });
      expect((await kit.anchorsOf(radar)).filter((a) => a.kind === 'link')).toHaveLength(0);
    });

    it('orphans with the text: flags the element, tells the saver, and points at the last good version', async () => {
      const radar = await kit.radar();
      const billing = await kit.boundary(radar, 'Billing');
      const { link } = await linkCharter(kit.owner, radar, {
        quote: 'Commander never stores card data.',
        element: billing.id,
      });
      const saved = await kit.write(radar, (t) =>
        t.replace('Commander never stores card data.', 'Card data lives only at Stripe.'),
      );
      // A link's orphaning is always reported (an ADR's only when the ADR is live), named by its element.
      expect(saved.inertOrphaned).toBe(0);
      expect(saved.orphaned).toMatchObject([
        { anchorId: link.id, kind: 'link', subject: { id: billing.id, label: 'Billing' } },
      ]);
      const arch = await read(radar);
      expect(arch.boundaries[0]?.charter).toEqual({ state: 'orphaned', links: [link.id] });
      expect(arch.links?.[0]).toMatchObject({
        state: 'orphaned',
        section: null,
        cause: 'text_changed',
      });
      expect(arch.orphans).toMatchObject([{ anchorId: link.id, kind: 'link' }]);
      const orphan = must(arch.links?.[0]);
      expect(orphan.resolvedVersion).toBeLessThan(must(arch.charterVersion) + 1);

      // The last good version really has the words, at the range the version recorded for it.
      const past = await read(radar, {
        view: 'written',
        version: orphan.resolvedVersion,
        anchor: link.id,
      });
      expect(past.readOnly).toBe(true);
      expect(past).not.toHaveProperty('revision');
      expect(past.asOf?.version).toBe(orphan.resolvedVersion);
      const highlight = must(past.highlight);
      expect(highlight.state).toBe('anchored');
      const projection = projectionOf(must(past.charter[0]?.markdown));
      expect(projection.text.slice(must(highlight.start), must(highlight.end))).toBe(
        'Commander never stores card data.',
      );

      // The element's other links keep it `linked`.
      const second = await linkCharter(kit.owner, radar, {
        quote: 'Commander owns the hosting plan.',
        element: billing.id,
      });
      const element = must((await read(radar)).boundaries[0]?.charter);
      expect(element.state).toBe('linked');
      expect([...element.links].sort()).toEqual([link.id, second.link.id].sort());
    });

    it('heals when the words come back (a restore of the version it points at)', async () => {
      const radar = await kit.radar();
      const billing = await kit.boundary(radar, 'Billing');
      const { link } = await linkCharter(kit.owner, radar, {
        quote: 'Commander never stores card data.',
        element: billing.id,
      });
      await kit.write(radar, (t) => t.replace('Commander never stores card data.', 'Gone.'));
      const orphan = must((await read(radar)).links?.[0]);
      expect(orphan.state).toBe('orphaned');
      const head = await read(radar, { view: 'written' });
      const back = await restoreCharter(kit.owner, radar, orphan.resolvedVersion, {
        baseRevision: must(head.revision),
      });
      expect(back.healed).toMatchObject([{ anchorId: link.id }]);
      expect((await read(radar)).links?.[0]).toMatchObject({ id: link.id, state: 'anchored' });
      expect((await read(radar)).boundaries[0]?.charter?.state).toBe('linked');
    });

    it('allows deleting an element only once nothing is anchored to it; the links go with it', async () => {
      const radar = await kit.radar();
      const billing = await kit.boundary(radar, 'Billing');
      const { link } = await linkCharter(kit.owner, radar, {
        quote: 'Commander never stores card data.',
        element: billing.id,
      });
      await expect(deleteBlip(kit.owner, billing.id)).rejects.toMatchObject({
        status: 409,
        code: 'anchored',
      });
      await kit.write(radar, (t) => t.replace('Commander never stores card data.', 'Gone.'));
      await deleteBlip(kit.owner, billing.id);
      expect(
        await kit
          .db()
          .select()
          .from(schema.charterAnchors)
          .where(and(eq(schema.charterAnchors.id, link.id))),
      ).toEqual([]);
      expect((await read(radar)).links).toBeUndefined();
    });

    it('counts links against the per-radar anchor limit and never past 4,000 characters', async () => {
      const radar = await kit.radar(['# Big', '', 'word '.repeat(1200)].join('\n'));
      const el = await kit.boundary(radar, 'Big');
      // 5,999 characters of text cannot be one link.
      await expect(
        linkCharter(kit.owner, radar, { quote: 'word '.repeat(1200).trim(), element: el.id }),
      ).rejects.toMatchObject({ code: 'quote_too_long' });
    });

    it('lets a contract between two boundaries be linked after the fact', async () => {
      const radar = await kit.radar();
      const a = await kit.boundary(radar, 'A');
      const b = await kit.boundary(radar, 'B');
      const { contract } = await upsertContract(kit.owner, radar, {
        title: 'A to B',
        a: a.id,
        b: b.id,
      });
      const { link } = await linkCharter(kit.owner, radar, {
        quote: 'Runs on blue-kube',
        element: contract.id,
      });
      expect((await read(radar)).contracts[0]?.charter).toEqual({
        state: 'linked',
        links: [link.id],
      });
      expect(CHARTER).toContain('blue-kube');
    });
  },
);
