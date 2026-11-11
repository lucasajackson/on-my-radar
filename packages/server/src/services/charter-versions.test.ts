/**
 * The charter's history against a real Postgres (plan e715ea20, S6): the list of versions with who
 * and why, a past version read as it was, the diff between two, restore as a new version, history
 * being for members only, and a deleted agent not stopping the next save. Skipped without
 * DATABASE_URL.
 */
import { describe, expect, it } from 'vitest';
import { projectionOf } from './charter-model.js';
import { CHARTER, charterDatabase } from './charter-test-kit.js';
import { linkCharter } from './charter-links.js';
import { diffCharter, listCharterVersions, restoreCharter } from './charter-versions.js';
import {
  architectureRadar,
  decideAdr,
  dismiss,
  proposeAdr,
  readArchitecture,
  trace,
  upsertBoundaryOnce,
} from './architecture.js';
import { deleteBlip, updateBlip } from './blips.js';
import { createRepoAgent, deleteRepoAgent } from './repo-agents.js';
import { setVisibility, shareRadar } from './radars.js';
import { must } from '../errors.js';
import type { Actor } from '../http.js';

describe.skipIf(!process.env['DATABASE_URL'])(
  'charter versions (real postgres)',
  { timeout: 30_000 },
  () => {
    const kit = charterDatabase('omr_versions');
    const read = (
      radarId: string,
      query: Parameters<typeof readArchitecture>[2] = { view: 'amended' },
      actor: Actor = kit.owner,
    ) => readArchitecture(actor, radarId, query);
    const list = (radarId: string, query: { before?: number; limit?: number } = {}) =>
      listCharterVersions(kit.owner, radarId, { limit: 30, ...query });
    const head = async (radarId: string) =>
      must((await read(radarId, { view: 'written' })).revision);
    const noReads = <T>(promise: Promise<T>, status: number, code?: string) =>
      expect(promise).rejects.toMatchObject({ status, ...(code ? { code } : {}) });

    /* ----------------------------------- list ---------------------------------- */

    it('lists versions newest first with who, when, why and a label; a person and an agent differ', async () => {
      const radar = await kit.radar();
      const billing = await kit.boundary(radar, 'Billing');
      const adr = await proposeAdr(kit.owner, radar, {
        title: 'Hosting is the plan',
        rationale: 'why',
        anchors: [{ quote: 'Commander owns the hosting plan.', with: 'Hosting is a plan.' }],
      });
      await linkCharter(kit.owner, radar, {
        quote: 'Commander never stores card data.',
        element: billing.id,
      });
      const scout = await createRepoAgent(kit.owner, { name: 'Scout', slug: 'scout', prompt: 'p' });
      const agent: Actor = {
        user: kit.owner.user,
        kind: 'agent',
        ceiling: 'owner',
        connection: { kind: 'pat', id: 'tok-1', label: 'Scout token' },
        agent: {
          agentId: scout.id,
          ownerId: kit.owner.user.id,
          name: 'Scout',
          handle: 'scout',
        },
      };
      await kit.write(radar, (t) => `${t}\nAn agent wrote this.\n`, agent, { note: 'tidy' });

      const all = await list(radar);
      expect(all.versions.map((v) => v.version)).toEqual([4, 3, 2, 1]);
      expect(all.versions[0]).toMatchObject({
        cause: 'edit',
        note: 'tidy',
        via: 'Scout token',
        by: { kind: 'agent', id: scout.id, name: 'Scout', handle: 'scout', onBehalfOf: 'owner' },
      });
      expect(all.versions[0]?.label).toBe('v4 · tidy · Scout');
      expect(all.versions[1]).toMatchObject({
        cause: 'anchor',
        subject: { id: billing.id, label: 'Billing', lane: 'boundary' },
        by: { kind: 'person', name: 'owner' },
      });
      expect(all.versions[2]).toMatchObject({
        cause: 'adr',
        subject: { id: adr.adr.id, label: 'ADR-0001', lane: 'proposed' },
      });
      expect(all.versions[2]?.label).toBe('v2 · ADR-0001 proposed · owner');
      // The lane the ADR was in when the version was sealed, whatever lane it is in now.
      expect(all.versions[2]?.lane).toBe('proposed');
      expect(all.versions[0]?.restoredFrom).toBeNull();
      expect(all.versions[3]).toMatchObject({
        cause: 'edit',
        by: { kind: 'person', id: kit.owner.user.id },
      });
      expect(Date.parse(must(all.versions[0]).createdAt)).toBeGreaterThanOrEqual(
        Date.parse(must(all.versions[3]).createdAt),
      );
      expect(all.head).toEqual({ revision: 2, version: 4, unsealed: false });

      // Keyset paging on the version number.
      const first = await list(radar, { limit: 3 });
      expect(first.versions.map((v) => v.version)).toEqual([4, 3, 2]);
      expect(first.nextCursor).toBe(2);
      const rest = await list(radar, { limit: 3, before: must(first.nextCursor) });
      expect(rest.versions.map((v) => v.version)).toEqual([1]);
      expect(rest.nextCursor).toBeNull();

      // Working text that is not yet history says so.
      await kit.write(radar, (t) => `${t}\nTyping.\n`, kit.owner, { checkpoint: false });
      expect((await list(radar)).head).toMatchObject({ version: 4, unsealed: true });
    });

    it('shows one radar’s versions to its readers only: another radar’s numbers are not found', async () => {
      const radar = await kit.radar();
      const other = await kit.radar();
      await kit.write(other, (t) => `${t}\nmore\n`);
      const stranger = await kit.user(`stranger${Math.random().toString(36).slice(2, 7)}`);
      await noReads(listCharterVersions(stranger, radar, { limit: 30 }), 404);
      await noReads(diffCharter(stranger, radar, { from: 1, to: 'head' }), 404);
      await noReads(read(radar, { view: 'written', version: 1 }, stranger), 404);
      // `other` has a version 2; `radar` does not.
      await noReads(read(radar, { view: 'written', version: 2 }), 404);
      await noReads(diffCharter(kit.owner, radar, { from: 2, to: 'head' }), 404);
    });

    /* --------------------------------- read as of ------------------------------- */

    it('reads a past version exactly as it was drawn then: its text, its strikes, its ADR lanes', async () => {
      const radar = await kit.radar();
      const adr = await proposeAdr(kit.owner, radar, {
        title: 'Hosting is a plan',
        rationale: 'why',
        anchors: [{ quote: 'Commander owns the hosting plan.', with: 'Commander runs hosting.' }],
      });
      await decideAdr(kit.owner, adr.adr.id, { decision: 'accept' });
      const then = await read(radar);
      const thenWritten = await read(radar, { view: 'written' });
      const thenSource = await read(radar, { view: 'source' });
      expect(then.charter[0]?.markdown).toContain('Commander runs hosting.');
      const version = must(then.charterVersion);
      // Later: the text moves, the ADR is repealed. The head no longer draws what it drew.
      await kit.write(radar, (t) => `Preface paragraph that moves everything.\n\n${t}`);
      await decideAdr(kit.owner, adr.adr.id, { decision: 'repeal' });
      expect((await read(radar)).charter[0]?.markdown).not.toContain('Commander runs hosting.');

      for (const [view, expected] of [
        ['amended', then],
        ['written', thenWritten],
        ['source', thenSource],
      ] as const) {
        const past = await read(radar, { view, version });
        expect(past.charter[0]?.markdown, view).toBe(expected.charter[0]?.markdown);
        expect(past.readOnly).toBe(true);
        expect(past).not.toHaveProperty('revision');
        expect(past.asOf).toMatchObject({ version, cause: 'adr' });
      }
      // The strike is the version's own, and outline works on it too.
      expect(
        (await read(radar, { view: 'amended', version, outline: true })).charter[0]?.headings,
      ).toContain('# Charter');
    });

    it('opens an orphan at the version it last resolved in, highlighting the words', async () => {
      const radar = await kit.radar();
      const adr = await proposeAdr(kit.owner, radar, {
        title: 'Hosting is a plan',
        rationale: 'why',
        anchors: [{ quote: 'Commander owns the hosting plan.', with: 'Commander runs hosting.' }],
      });
      await kit.write(radar, (t) =>
        t.replace('Commander owns the hosting plan.', 'Hosting is gone.'),
      );
      const arch = await read(radar);
      const orphan = must(arch.orphans?.[0]);
      expect(orphan).toMatchObject({ kind: 'amend', subject: { id: adr.adr.id } });
      const past = await read(radar, {
        view: 'written',
        version: orphan.resolvedVersion,
        anchor: orphan.anchorId,
      });
      const highlight = must(past.highlight);
      const markdown = must(past.charter[0]?.markdown);
      expect(projectionOf(markdown).text.slice(must(highlight.start), must(highlight.end))).toBe(
        orphan.quote,
      );
      expect(markdown.slice(must(highlight.sourceStart), must(highlight.sourceEnd))).toContain(
        'Commander owns the hosting plan.',
      );
      // At the head the same anchor has no place; another radar's anchor is not found.
      expect(
        (await read(radar, { view: 'written', anchor: orphan.anchorId })).highlight,
      ).toMatchObject({
        state: 'orphaned',
        start: null,
      });
      const other = await kit.radar();
      await noReads(read(other, { view: 'written', anchor: orphan.anchorId }), 404);
    });

    /* ----------------------------------- diff ----------------------------------- */

    it('diffs two versions into struck and inserted ranges on the words, and ignores formatting', async () => {
      const radar = await kit.radar();
      await kit.write(radar, (t) =>
        t.replace(
          'Stripe is the billing source of truth. Commander',
          'Adyen is the billing source of truth. Commander',
        ),
      );
      const diff = await diffCharter(kit.owner, radar, { from: 1, to: 2 });
      expect(diff).toMatchObject({ identical: false, exact: true, truncated: false });
      expect(diff.hunks[0]).toMatchObject({
        section: ['Charter', 'Billing'],
        struck: { text: 'Stripe' },
        inserted: { text: 'Adyen' },
      });
      const v1 = projectionOf(CHARTER);
      const struck = must(diff.hunks[0]?.struck);
      expect(v1.text.slice(struck.start, struck.end)).toBe('Stripe');
      expect(diff.stats).toMatchObject({ hunks: 1, struckChars: 6, insertedChars: 5 });
      // to defaults to the head, and the head is a valid side.
      expect(await diffCharter(kit.owner, radar, { from: 1, to: 'head' })).toMatchObject({
        to: { version: 'head' },
        stats: { hunks: 1 },
      });
      // A re-escaped table and a bolded word change the markdown, not the words.
      await kit.write(radar, (t) =>
        t.replace('Commander owns', '**Commander** owns').replace('| Web |', '|  Web  |'),
      );
      const formatting = await diffCharter(kit.owner, radar, { from: 2, to: 3 });
      expect(formatting).toMatchObject({ identical: true, hunks: [], stats: { hunks: 0 } });
      expect(await diffCharter(kit.owner, radar, { from: 2, to: 2 })).toMatchObject({
        identical: true,
      });
    });

    it('caps a large diff: every change is counted, a bounded number are listed', async () => {
      const paragraphs = (word: string) =>
        Array.from({ length: 260 }, (_, i) => `${word} paragraph number ${i} ends here`).join(
          '\n\n',
        );
      const radar = await kit.radar(paragraphs('alpha'));
      await kit.write(radar, () => paragraphs('beta'));
      const diff = await diffCharter(kit.owner, radar, { from: 1, to: 2 });
      expect(diff.stats.hunks).toBeGreaterThan(200);
      expect(diff.hunks).toHaveLength(200);
      expect(diff.truncated).toBe(true);
      expect(JSON.stringify(diff).length).toBeLessThan(120_000);
    });

    /* ---------------------------------- restore --------------------------------- */

    it('restores an earlier version as a new one: history is untouched, amendments heal', async () => {
      const radar = await kit.radar();
      const adr = await proposeAdr(kit.owner, radar, {
        title: 'Hosting is a plan',
        rationale: 'why',
        anchors: [{ quote: 'Commander owns the hosting plan.', with: 'Commander runs hosting.' }],
      });
      const goodVersion = (await list(radar)).head.version;
      await kit.write(radar, (t) =>
        t.replace('Commander owns the hosting plan.', 'Hosting is gone.'),
      );
      expect((await read(radar)).orphans).toHaveLength(1);
      const before = await kit.versionsOf(radar);

      const back = await restoreCharter(kit.owner, radar, goodVersion, {
        baseRevision: await head(radar),
      });
      expect(back.restoredFrom).toBe(goodVersion);
      expect(back.healed).toMatchObject([{ subject: { id: adr.adr.id } }]);
      expect((await read(radar)).orphans).toBeUndefined();
      expect(back.changed).toBe(true);

      const after = await kit.versionsOf(radar);
      expect(after).toHaveLength(before.length + 1);
      // Every earlier row is byte for byte what it was.
      expect(after.slice(0, before.length)).toEqual(before);
      const added = must(after[after.length - 1]);
      expect(added).toMatchObject({ cause: 'restore', note: `Restored version ${goodVersion}` });
      expect(added.sha256).toBe(must(before.find((v) => v.version === goodVersion)).sha256);
      expect((await list(radar)).versions[0]).toMatchObject({
        cause: 'restore',
        label: `v${added.version} · Restored version ${goodVersion} · owner`,
        // Which version it put back, for a list to say "Restored from v3".
        restoredFrom: goodVersion,
      });

      // Based on a revision that has moved on: stale. Restoring the text already there: nothing.
      await noReads(restoreCharter(kit.owner, radar, 1, { baseRevision: 0 }), 409, 'stale');
      const same = await restoreCharter(kit.owner, radar, goodVersion, {
        baseRevision: await head(radar),
      });
      expect(same.changed).toBe(false);
      expect(await kit.versionsOf(radar)).toHaveLength(after.length);
      await noReads(
        restoreCharter(kit.owner, radar, 999, { baseRevision: await head(radar) }),
        404,
      );
      const viewer = await kit.user(`viewer${Math.random().toString(36).slice(2, 7)}`);
      await shareRadar(kit.owner, radar, viewer.user.email, 'viewer');
      await noReads(restoreCharter(viewer, radar, 1, { baseRevision: await head(radar) }), 403);
      expect((await list(radar)).versions).toHaveLength(after.length);
    });

    it('restores once under an idempotencyKey: a retry answers, it does not seal another version', async () => {
      const radar = await kit.radar();
      const goodVersion = (await list(radar)).head.version;
      await kit.write(radar, (t) => `${t}\n\nAn added line.`);
      const request = { baseRevision: await head(radar), idempotencyKey: 'restore-1' };
      const first = await restoreCharter(kit.owner, radar, goodVersion, request);
      expect(first.changed).toBe(true);
      const versions = (await kit.versionsOf(radar)).length;
      // The charter has moved on since (the restore itself), so an unkeyed retry would be stale.
      const again = await restoreCharter(kit.owner, radar, goodVersion, request);
      expect(again).toMatchObject({ restoredFrom: goodVersion, replayed: true });
      expect(await kit.versionsOf(radar)).toHaveLength(versions);
    });

    /* ------------------------------ restore, under the lock --------------------------- */

    it('reads the version only after the head has been checked: a stale restore is stale, whatever it names', async () => {
      const radar = await kit.radar();
      await kit.write(radar, (t) => `${t}\nMore.\n`);
      // Both are wrong, and the head is the first thing asked: stale, not "no such version".
      await noReads(restoreCharter(kit.owner, radar, 999, { baseRevision: 0 }), 409, 'stale');
      await noReads(
        restoreCharter(kit.owner, radar, 999, { baseRevision: await head(radar) }),
        404,
      );
    });

    /* --------------------------- history is for members only -------------------------- */

    it('shows a public link its current charter and none of its history', async () => {
      const radar = await kit.radar();
      await kit.write(radar, (t) => `${t}\nA second version.\n`);
      const slug = must((await setVisibility(kit.owner, radar, 'public')).publicSlug);
      const visitor = await kit.user(`visitor${Math.random().toString(36).slice(2, 7)}`);

      // What a public link does see: the current charter.
      const current = await read(slug, { view: 'written' }, visitor);
      expect(current.charter[0]?.markdown).toContain('A second version.');
      // What it does not: the versions, a diff, or an earlier text. Not found, like a missing radar.
      await noReads(listCharterVersions(visitor, slug, { limit: 30 }), 404);
      await noReads(diffCharter(visitor, slug, { from: 1, to: 'head' }), 404);
      await noReads(read(slug, { view: 'written', version: 1 }, visitor), 404);
      // Writing is refused to a public link as it always was (read-only), restore included.
      await noReads(restoreCharter(visitor, slug, 1, { baseRevision: 2 }), 403);
      // A member of the same radar reads all of it, by the same slug or by its id.
      const member = await kit.user(`member${Math.random().toString(36).slice(2, 7)}`);
      await shareRadar(kit.owner, radar, member.user.email, 'viewer');
      expect((await listCharterVersions(member, radar, { limit: 30 })).versions).toHaveLength(2);
      expect((await read(radar, { view: 'written', version: 1 }, member)).asOf?.version).toBe(1);
      expect((await diffCharter(member, radar, { from: 1, to: 2 })).stats.hunks).toBe(1);
      // The owner reaching it by the public slug is a member, not a visitor.
      expect((await listCharterVersions(kit.owner, slug, { limit: 30 })).versions).toHaveLength(2);
    });

    /* ------------------- a public link reads the charter, not what left it ------------------- */

    it('leaves the words of a removed passage out of every public read, orphaned link and amendment alike', async () => {
      const radar = await kit.radar(
        [
          '# Charter',
          '',
          'The vault canary-link is sealed nightly.',
          '',
          'Backups canary-adr run at dawn.',
          '',
          'Kept text.',
          '',
        ].join('\n'),
      );
      const vault = await kit.boundary(radar, 'Vault');
      const link = await linkCharter(kit.owner, radar, {
        quote: 'The vault canary-link is sealed nightly.',
        element: vault.id,
      });
      const adr = await proposeAdr(kit.owner, radar, {
        title: 'Backups at noon',
        rationale: 'why',
        anchors: [
          { quote: 'Backups canary-adr run at dawn.', with: 'Backups quokka-with run at noon.' },
        ],
      });
      await kit.write(radar, (t) =>
        t
          .replace('The vault canary-link is sealed nightly.\n\n', '')
          .replace('Backups canary-adr run at dawn.\n\n', ''),
      );
      const slug = must((await setVisibility(kit.owner, radar, 'public')).publicSlug);
      const visitor = await kit.user(`visitor${Math.random().toString(36).slice(2, 7)}`);

      const everything = async (actor: Actor, id: string) =>
        JSON.stringify([
          await read(id, { view: 'source', anchor: link.link.id }, actor),
          await read(id, { view: 'written', boundary: vault.id }, actor),
          await read(id, { view: 'written', edit: vault.id }, actor),
        ]);
      // A member still gets the words (they are the to-do list for settling them)...
      const member = JSON.stringify([
        await everything(kit.owner, radar),
        await trace(kit.owner, vault.id),
        await trace(kit.owner, adr.adr.id),
      ]);
      for (const word of ['canary-link', 'canary-adr', 'quokka-with'])
        expect(member).toContain(word);
      // ... a public-link reader gets the state and the cause, and not one word of them.
      const visited = await everything(visitor, slug);
      // `trace` is addressed by blip id, which a public link does not reach at all.
      await noReads(trace(visitor, vault.id), 404);
      for (const word of ['canary-link', 'canary-adr', 'quokka-with'])
        expect(visited).not.toContain(word);
      const arch = await read(slug, { view: 'written', anchor: link.link.id }, visitor);
      expect(arch.links).toMatchObject([{ state: 'orphaned', cause: 'text_changed', excerpt: '' }]);
      expect(arch.orphans).toHaveLength(2);
      expect(arch.orphans?.every((o) => o.quote === '' && o.cause === 'text_changed')).toBe(true);
      expect(arch.highlight).toMatchObject({ state: 'orphaned', quote: '' });
      expect(arch.adrs[0]?.anchors).toMatchObject([{ state: 'orphaned', quote: '', with: '' }]);
      // Text that is still in the charter is still public.
      expect(arch.charter[0]?.markdown).toContain('Kept text.');
    });

    /* ------------------ a ratified ADR is part of history: it cannot be deleted ------------------ */

    it('refuses to delete a ratified ADR, and a past version reads the same after the attempt', async () => {
      const radar = await kit.radar();
      const adr = await proposeAdr(kit.owner, radar, {
        title: 'Hosting is a plan',
        rationale: 'why',
        anchors: [{ quote: 'Commander owns the hosting plan.', with: 'Hosting is a plan.' }],
      });
      await decideAdr(kit.owner, adr.adr.id, { decision: 'accept' });
      const sealed = (await list(radar)).head.version;
      const asSealed = async () =>
        (await read(radar, { view: 'amended', version: sealed })).charter[0]?.markdown;
      const before = await asSealed();
      expect(before).toContain('Hosting is a plan.');
      // Its words leave the charter and the amendment is let go: no live anchor is left to stop a delete.
      await kit.write(radar, (t) => t.replace('Commander owns the hosting plan.', 'Gone.'));
      const anchor = must((await kit.anchorsOf(radar)).find((a) => a.subjectId === adr.adr.id));
      await dismiss(kit.owner, anchor.id, {});

      await noReads(deleteBlip(kit.owner, adr.adr.id), 409, 'ratified');
      expect(await asSealed()).toEqual(before);
      // Repealing is the way out, and the decision stays in the log.
      await decideAdr(kit.owner, adr.adr.id, { decision: 'repeal' });
      await noReads(deleteBlip(kit.owner, adr.adr.id), 409, 'ratified');
      expect(await asSealed()).toBe(before);
    });

    it('still deletes a proposed or rejected ADR, and refuses to move a ratified one that amended the charter', async () => {
      const radar = await kit.radar();
      const rejected = await proposeAdr(kit.owner, radar, {
        title: 'No',
        rationale: 'why',
        anchors: [],
      });
      await decideAdr(kit.owner, rejected.adr.id, { decision: 'reject' });
      await deleteBlip(kit.owner, rejected.adr.id);
      const proposed = await proposeAdr(kit.owner, radar, {
        title: 'Maybe',
        rationale: 'why',
        anchors: [],
      });
      await deleteBlip(kit.owner, proposed.adr.id);

      const amending = await proposeAdr(kit.owner, radar, {
        title: 'Hosting',
        rationale: 'why',
        anchors: [{ quote: 'Commander owns the hosting plan.', with: 'Hosting is a plan.' }],
      });
      await decideAdr(kit.owner, amending.adr.id, { decision: 'accept' });
      const elsewhere = await kit.radar();
      await noReads(
        updateBlip(kit.owner, amending.adr.id, { radarId: elsewhere }),
        409,
        'ratified',
      );
    });

    /* ------------------- a new element's retry is answered before its title is judged ------------------- */

    it('claims the idempotency key before refusing a taken title, so a twin that won is replayed, not refused', async () => {
      const radar = await kit.radar();
      await kit.boundary(radar, 'Taken');
      const row = await architectureRadar(radar, kit.owner, 'write');
      const claimed: string[] = [];
      const hook = { afterCreate: async () => undefined };
      // Nobody holds the key: the refusal is the title's, made under the claim.
      await expect(
        upsertBoundaryOnce(
          kit.owner,
          row,
          { title: 'Taken' },
          async (_tx, id) => void claimed.push(id),
          hook,
        ),
      ).rejects.toMatchObject({ status: 409, code: 'title_taken' });
      expect(claimed).toHaveLength(1);
      // A twin holds it: the race is what comes out (the caller replays the twin), not the title.
      class Twin extends Error {}
      await expect(
        upsertBoundaryOnce(
          kit.owner,
          row,
          { title: 'Taken' },
          async () => Promise.reject(new Twin()),
          hook,
        ),
      ).rejects.toBeInstanceOf(Twin);
    });

    /* -------------------------------- deleted agents --------------------------------- */

    it('keeps sealing after the agent that wrote the working text is deleted', async () => {
      const radar = await kit.radar();
      const scout = await createRepoAgent(kit.owner, { name: 'Gone', slug: 'gone', prompt: 'p' });
      const agent: Actor = {
        user: kit.owner.user,
        kind: 'agent',
        ceiling: 'owner',
        connection: { kind: 'pat', id: 'tok-gone', label: 'Gone token' },
        agent: { agentId: scout.id, ownerId: kit.owner.user.id, name: 'Gone', handle: 'gone' },
      };
      // The agent types without a checkpoint: the working text is its, and names it.
      await kit.write(radar, (t) => `${t}\nThe agent was here.\n`, agent, { checkpoint: false });
      const [doc] = await kit
        .q<{ updated_writer: string }>(
          `SELECT updated_writer FROM charter_documents WHERE radar_id = $1`,
          [radar],
        )
        .then((r) => r.rows);
      expect(doc?.updated_writer).toContain(scout.id);

      await deleteRepoAgent(kit.owner, scout.id);
      // A person's save seals that working text first, under a writer whose agent is gone.
      const saved = await kit.write(radar, (t) => `${t}\nAnd then a person.\n`);
      expect(saved.changed).toBe(true);
      const versions = await kit.versionsOf(radar);
      const sealed = versions.find((v) => v.note === 'text as it stood before the next change');
      expect(sealed).toMatchObject({ agentId: null });
      expect(versions.every((v) => v.agentId === null)).toBe(true);
      // Every later save works too.
      await kit.write(radar, (t) => `${t}\nAnd again.\n`);

      // Versions the agent did seal keep their history when it goes: the link is cleared, nothing else.
      const other = await createRepoAgent(kit.owner, { name: 'Gone2', slug: 'gone2', prompt: 'p' });
      const second: Actor = { ...agent, agent: { ...must(agent.agent), agentId: other.id } };
      await kit.write(radar, (t) => `${t}\nSealed by an agent.\n`, second);
      const before = (await kit.versionsOf(radar)).find((v) => v.agentId === other.id);
      expect(before).toBeTruthy();
      await deleteRepoAgent(kit.owner, other.id);
      const after = must(
        (await kit.versionsOf(radar)).find((v) => v.version === must(before).version),
      );
      expect(after).toEqual({ ...must(before), agentId: null });
      // And a version still cannot be rewritten by anyone else.
      await expect(
        kit.q(`UPDATE charter_versions SET note = 'x' WHERE radar_id = $1 AND version = 1`, [
          radar,
        ]),
      ).rejects.toMatchObject({ code: '55000' });
    });
  },
);
