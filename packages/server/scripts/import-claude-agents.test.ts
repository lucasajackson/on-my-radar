import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isEntry, parseAgentFile, parseArgs, readBundles } from './import-claude-agents.js';

describe('parseArgs', () => {
  it('reads the documented spaced form of --only', () => {
    expect([...(parseArgs(['--only', 'a,b']).only ?? [])]).toEqual(['a', 'b']);
  });

  it('reads the = form of --only', () => {
    expect([...(parseArgs(['--only=a']).only ?? [])]).toEqual(['a']);
  });

  it('refuses --only with nothing after it', () => {
    expect(() => parseArgs(['--only', '--dry-run'])).toThrow(/comma-separated/);
  });

  it('is unfiltered without --only', () => {
    expect(parseArgs(['--dry-run'])).toEqual({ dryRun: true, only: null });
  });
});

describe('isEntry', () => {
  it('matches a path that URL-escapes', () => {
    const path = '/tmp/with space/import-claude-agents.ts';
    expect(isEntry(pathToFileURL(path).href, path)).toBe(true);
  });

  it('does not match another module', () => {
    expect(isEntry(pathToFileURL('/a.ts').href, '/b.ts')).toBe(false);
  });
});

describe('readBundles', () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'omr-import-'));
    await mkdir(join(root, 'agents'));
    await writeFile(
      join(root, 'agents', 'alpha.md'),
      '---\nname: alpha\ndescription: "First"\n---\nPrompt body\n',
    );
    await writeFile(join(root, 'agents', 'beta.md'), '---\nname: beta\n---\n');
    await writeFile(
      join(root, 'agents', 'gamma-tools.md'),
      '---\nname: gamma-tools\nmodel: opus\ntools: Read, Grep\ncolor: teal\n---\nP\n',
    );
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('keeps only the named agents and names the ones it could not find', async () => {
    const { bundles, unknown } = await readBundles(root, new Set(['alpha', 'gamma']));
    expect(bundles.map((bundle) => bundle.name)).toEqual(['alpha']);
    expect(unknown).toEqual(['gamma']);
  });

  it('maps Claude Code frontmatter onto its profile, reporting what the tool would refuse', async () => {
    const { bundles, skipped } = await readBundles(root, new Set(['gamma-tools']));
    expect(bundles[0]).toMatchObject({
      primaryHarness: 'claude-code',
      profiles: { 'claude-code': { model: 'opus', tools: 'Read, Grep' } },
    });
    // `teal` is not a Claude Code colour: reported, and the rest still lands.
    expect(bundles[0]?.profiles?.['claude-code']).not.toHaveProperty('color');
    expect(skipped.join('\n')).toMatch(/gamma-tools: claude-code\.color/);
  });

  it('reads frontmatter and prompt', () => {
    expect(parseAgentFile('---\nname: x\ndescription: "quoted"\n---\nBody\n')).toEqual({
      fields: { name: 'x', description: 'quoted' },
      body: 'Body\n',
    });
  });

  it('refuses invalid tool restrictions before an import could silently inherit all tools', async () => {
    await writeFile(
      join(root, 'agents', 'invalid-tools.md'),
      '---\nname: invalid-tools\ntools: All tools\n---\nP\n',
    );
    try {
      await expect(readBundles(root, new Set(['invalid-tools']))).rejects.toThrow(
        /invalid-tools.*tools/i,
      );
      expect((await readBundles(root, new Set(['alpha']))).bundles.map((b) => b.name)).toEqual([
        'alpha',
      ]);
    } finally {
      await rm(join(root, 'agents', 'invalid-tools.md'));
    }
  });

  it('keeps documented blocked tools as their own frontmatter field', async () => {
    await writeFile(
      join(root, 'agents', 'blocked-tools.md'),
      '---\nname: blocked-tools\ntools: Read, Bash\ndisallowedTools: mcp__*\n---\nP\n',
    );
    try {
      expect((await readBundles(root, new Set(['blocked-tools']))).bundles[0]?.profiles).toEqual({
        'claude-code': { tools: 'Read, Bash', disallowedTools: 'mcp__*' },
      });
    } finally {
      await rm(join(root, 'agents', 'blocked-tools.md'));
    }
  });
});
