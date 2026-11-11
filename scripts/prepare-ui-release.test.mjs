import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { prepareUiRelease } from './prepare-ui-release.mjs';

const sha = 'a'.repeat(40);
test('retains old shell assets, prunes expired history, and publishes current identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omr-release-'));
  try {
    const current = join(root, 'current');
    const previous = join(root, 'previous');
    const output = join(root, 'output');
    for (const dir of [current, previous]) await mkdir(join(dir, 'assets'), { recursive: true });
    await writeFile(join(current, 'assets/new.js'), 'new');
    await writeFile(join(current, 'index.html'), '<script src="/assets/new.js"></script>');
    const now = 60 * 24 * 60 * 60 * 1000;
    for (const asset of ['preceding.js', 'recent.js', 'expired.js'])
      await writeFile(join(previous, 'assets', asset), asset);
    await writeFile(
      join(previous, 'build.json'),
      JSON.stringify({
        currentAssets: ['/assets/preceding.js'],
        assets: [
          { path: '/assets/preceding.js', lastSeen: 0 },
          { path: '/assets/recent.js', lastSeen: now - 1000 },
          { path: '/assets/expired.js', lastSeen: 0 },
        ],
      }),
    );
    await prepareUiRelease(current, previous, output, sha, now);
    const manifest = JSON.parse(await readFile(join(output, 'build.json'), 'utf8'));
    assert.equal(manifest.buildSha, sha);
    assert.deepEqual(manifest.currentAssets, ['/assets/new.js']);
    assert.deepEqual(manifest.assets.map((a) => a.path).sort(), [
      '/assets/new.js',
      '/assets/preceding.js',
      '/assets/recent.js',
    ]);
    assert.equal(await readFile(join(output, 'assets/preceding.js'), 'utf8'), 'preceding.js');
    assert.equal(await readFile(join(output, 'assets/new.js'), 'utf8'), 'new');
    await assert.rejects(readFile(join(output, 'assets/expired.js')), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('adopts a legacy UI but refuses a missing predecessor instead of discarding overlap', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omr-release-'));
  try {
    const current = join(root, 'current');
    const previous = join(root, 'previous');
    for (const dir of [current, previous]) await mkdir(join(dir, 'assets'), { recursive: true });
    await writeFile(join(current, 'assets/current.js'), 'current');
    await writeFile(join(previous, 'assets/legacy.js'), 'legacy');
    await prepareUiRelease(current, previous, join(root, 'out'), sha);
    assert.equal(await readFile(join(root, 'out/assets/legacy.js'), 'utf8'), 'legacy');
    await assert.rejects(prepareUiRelease(current, join(root, 'missing'), join(root, 'bad'), sha), {
      code: 'ENOENT',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an empty predecessor is a first release; a predecessor with content but no assets is refused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omr-release-'));
  try {
    const current = join(root, 'current');
    const empty = join(root, 'empty');
    const hollow = join(root, 'hollow');
    await mkdir(join(current, 'assets'), { recursive: true });
    await mkdir(empty);
    await mkdir(hollow);
    await writeFile(join(current, 'assets/current.js'), 'current');
    await writeFile(join(hollow, 'index.html'), 'a shell with no assets');
    await prepareUiRelease(current, empty, join(root, 'out'), sha);
    assert.equal(await readFile(join(root, 'out/assets/current.js'), 'utf8'), 'current');
    const manifest = JSON.parse(await readFile(join(root, 'out/build.json'), 'utf8'));
    assert.deepEqual(
      manifest.assets.map((a) => a.path),
      ['/assets/current.js'],
    );
    await assert.rejects(prepareUiRelease(current, hollow, join(root, 'bad'), sha), {
      code: 'ENOENT',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('every document/asset pairing works in both rollout phases and after interruption', async () => {
  const { prepareTransition } = await import('./prepare-ui-release.mjs');
  const root = await mkdtemp(join(tmpdir(), 'omr-transition-'));
  try {
    const old = join(root, 'old');
    const current = join(root, 'current');
    const final = join(root, 'final');
    const transition = join(root, 'transition');
    for (const [dir, asset] of [
      [old, 'old'],
      [current, 'new'],
    ]) {
      await mkdir(join(dir, 'assets'), { recursive: true });
      await writeFile(join(dir, 'assets', `${asset}.js`), `/* ${asset} */`);
      await writeFile(join(dir, 'index.html'), `<script src="/assets/${asset}.js"></script>`);
      await writeFile(join(dir, 'sw.js'), `/* ${asset} worker */`);
    }
    await prepareUiRelease(current, old, final, sha, 1000);
    await prepareTransition(old, final, transition);
    for (const pods of [
      [old, transition],
      [transition, final],
    ]) {
      for (const documentPod of pods) {
        const html = await readFile(join(documentPod, 'index.html'), 'utf8');
        const asset = html.match(/src="\/(.*?)"/)[1];
        for (const assetPod of pods) assert.ok(await readFile(join(assetPod, asset)));
      }
    }
    assert.equal(await readFile(join(transition, 'sw.js'), 'utf8'), '/* old worker */');
    const manifest = JSON.parse(await readFile(join(transition, 'build.json'), 'utf8'));
    assert.deepEqual(manifest.currentAssets, ['/assets/old.js']);
    assert.equal(manifest.stagedBuildSha, sha);
    // Interrupted transition remains a valid predecessor. Its old document and
    // already-staged chunks both survive a fresh release/retry.
    const resumed = join(root, 'resumed');
    await prepareUiRelease(current, transition, resumed, sha, 2000);
    assert.ok(await readFile(join(resumed, 'assets/old.js')));
    assert.ok(await readFile(join(resumed, 'assets/new.js')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
