/**
 * One-off import of an architecture folder into an empty Architecture radar.
 *
 *   DATABASE_URL=… SESSION_SECRET=… \
 *     pnpm --filter @onmyradar/server exec tsx scripts/import-architecture.ts <dir> <radarId>
 *
 * Read-only on `<dir>` (see `src/services/architecture-import.ts`), refuses a
 * radar that already holds boundaries or contracts (a radar with only its
 * charter and ADRs gets just the elements added), and runs as the radar's owner.
 */
import { pathToFileURL } from 'node:url';
import { importArchitecture } from '../src/services/architecture-import.js';

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [dir, radarId] = process.argv.slice(2);
  if (!dir || !radarId) {
    console.error('usage: import-architecture.ts <dir> <radarId>');
    process.exit(2);
  }
  importArchitecture(dir, radarId).then(
    (message) => {
      console.log(message);
      process.exit(0);
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}
