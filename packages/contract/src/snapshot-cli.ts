/**
 * Writes the contract snapshot to stdout, or to the path given as the first
 * argument. The iOS repo vendors the output like a lockfile.
 */
import { writeFileSync } from 'node:fs';
import { snapshotJson } from './snapshot.js';

const json = snapshotJson();
const target = process.argv[2];
if (target) {
  writeFileSync(target, json);
  process.stderr.write(`wrote ${target}\n`);
} else {
  process.stdout.write(json);
}
