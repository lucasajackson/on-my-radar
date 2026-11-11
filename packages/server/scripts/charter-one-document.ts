/**
 * Move Architecture radars' charters into their single document (plan e715ea20, slice S2).
 *
 *   DATABASE_URL=… SESSION_SECRET=… \
 *     pnpm --filter @onmyradar/server exec tsx scripts/charter-one-document.ts [--all | --radar <id>] [--apply] [--purge-pages]
 *
 * Dry run by default: prints, for every radar, what would be made (pages in, characters, anchors,
 * versions) or why it is refused, and writes nothing. `--apply` moves the radars that have no
 * document yet; running it again changes nothing. Pages are never deleted by `--apply`. After the
 * owner has looked at the result, `--purge-pages --apply` deletes the page blips of moved radars,
 * and only those whose written text is wholly inside version 1 (the rest are listed and kept), and never a page that anything refers to (comment, attachment, reaction, mention, ...) or
 * whose text holds a marker with no anchor.
 *
 * The same move runs on boot (MIGRATE_ON_BOOT) and lazily on a radar's first architecture read;
 * this script is for the deploy checklist and the report. A non-zero `stale` means a pod from
 * before the cutover wrote a page after the radar was moved: look at it before purging.
 */
import { pathToFileURL } from 'node:url';
import { closeDb } from '../src/db/client.js';
import { migrateAllRadars, purgeMigratedPages } from '../src/services/charter.js';

export async function main(argv: readonly string[]): Promise<number> {
  const apply = argv.includes('--apply');
  const radar = argv.includes('--radar') ? argv[argv.indexOf('--radar') + 1] : undefined;
  if (!argv.includes('--all') && !radar) {
    console.error(
      'usage: charter-one-document.ts (--all | --radar <id>) [--apply] [--purge-pages]',
    );
    return 2;
  }
  const only = radar ? { only: radar } : {};
  const reports = await migrateAllRadars({ dryRun: !apply, ...only });
  for (const r of reports)
    console.log(
      `${apply ? '' : '[dry run] '}${r.radarId} ${r.status}` +
        (r.reason ? ` (${r.reason})` : '') +
        ` pages=${r.pages} characters=${r.characters} anchors=${r.anchors} versions=${r.versions}` +
        (r.stalePages ? ` stale=${r.stalePages}` : ''),
    );
  let code = reports.some((r) => r.status === 'refused') ? 1 : 0;
  if (argv.includes('--purge-pages'))
    for (const r of reports.filter((x) => x.status === 'already' || x.status === 'migrated')) {
      if (!apply && r.status === 'migrated') continue; // nothing to purge before it exists
      const { deleted, kept, commented, keptPages } = await purgeMigratedPages(r.radarId, {
        dryRun: !apply,
      });
      console.log(
        `${r.radarId} pages ${apply ? 'deleted' : 'deletable'}=${deleted} kept=${kept} with-comments=${commented}`,
      );
      for (const k of keptPages) console.log(`  kept ${k.id}: ${k.reason}`);
      if (kept > 0) code = 1;
    }
  return code;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).then(
    async (code) => {
      await closeDb();
      process.exit(code);
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}
