import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

async function assetPaths(root, prefix = '') {
  // No predecessor at all (an empty directory) is a first release. A directory with
  // content but no assets is still an error, below.
  if (!prefix && (await readdir(root)).length === 0) return [];
  const entries = await readdir(join(root, 'assets', prefix), { withFileTypes: true });
  const paths = await Promise.all(
    entries.map(async (entry) => {
      const path = join(prefix, entry.name);
      if (entry.isDirectory()) return assetPaths(root, path);
      if (!entry.isFile()) throw new Error(`Unexpected non-file asset: ${path}`);
      return [`/assets/${path}`];
    }),
  );
  return paths.flat().sort();
}

/** Keep recent assets and the entire preceding release, even after a long idle. */
export async function prepareUiRelease(current, previous, output, buildSha, now = Date.now()) {
  if (buildSha && !/^[a-f0-9]{40}$/.test(buildSha)) throw new Error('Invalid build SHA');
  const currentAssets = await assetPaths(current);
  // Missing predecessor assets is a hard failure: quietly continuing makes a
  // successful rollout lose the assets still named by old API documents.
  const oldPaths = await assetPaths(previous);
  let oldBuild;
  try {
    oldBuild = JSON.parse(await readFile(join(previous, 'build.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // One-time adoption of images built before this manifest existed.
    oldBuild = {
      buildSha: null,
      currentAssets: oldPaths,
      assets: oldPaths.map((path) => ({ path, lastSeen: now })),
    };
  }
  const preceding = new Set(oldBuild.currentAssets);
  const known = new Map(oldBuild.assets.map((entry) => [entry.path, entry.lastSeen]));
  const assets = new Map();
  await mkdir(output, { recursive: true });
  for (const path of oldPaths) {
    const lastSeen = known.get(path);
    if (!Number.isFinite(lastSeen)) throw new Error(`Missing asset retention record: ${path}`);
    if (!preceding.has(path) && lastSeen < now - RETENTION_MS) continue;
    const local = path.slice(1);
    await mkdir(dirname(join(output, local)), { recursive: true });
    await cp(join(previous, local), join(output, local));
    assets.set(path, lastSeen);
  }
  await cp(current, output, { recursive: true });
  for (const path of currentAssets) assets.set(path, now);
  await writeFile(
    join(output, 'build.json'),
    JSON.stringify({
      buildSha: buildSha || null,
      currentAssets,
      assets: [...assets].map(([path, lastSeen]) => ({ path, lastSeen })),
    }),
  );
}

/** Serve the old document while every pod learns both generations of assets. */
export async function prepareTransition(previous, release, output) {
  const releaseBuild = JSON.parse(await readFile(join(release, 'build.json'), 'utf8'));
  let oldBuild;
  try {
    oldBuild = JSON.parse(await readFile(join(previous, 'build.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    oldBuild = { buildSha: null, currentAssets: await assetPaths(previous) };
  }
  await cp(previous, output, { recursive: true });
  await rm(join(output, 'assets'), { recursive: true, force: true });
  await cp(join(release, 'assets'), join(output, 'assets'), { recursive: true });
  await writeFile(
    join(output, 'build.json'),
    JSON.stringify({
      buildSha: oldBuild.buildSha ?? null,
      currentAssets: oldBuild.currentAssets,
      assets: releaseBuild.assets,
      stagedBuildSha: releaseBuild.buildSha,
    }),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [current, previous, output, sha = '', transition] = process.argv.slice(2);
  if (!current || !previous || !output)
    throw new Error('Expected current, previous, output directories');
  await prepareUiRelease(current, previous, output, sha);
  if (transition) await prepareTransition(previous, output, transition);
}
