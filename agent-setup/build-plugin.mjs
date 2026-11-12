#!/usr/bin/env node
/**
 * Build the Claude Code plugin `omr` as a zip, and the marketplace.json that
 * names it by URL and sha256 (docs/AGENT_REPO.md §V2.18 (d)).
 *
 *   OMR_PUBLIC_URL=https://omr.example node agent-setup/build-plugin.mjs [--site] [--out DIR] [--base-url URL]
 *
 * The server this build points agents at is OMR_PUBLIC_URL (default
 * http://localhost:3500), or the origin of --base-url. It is stamped into the
 * bundled `omr-agent.mjs` (its `DEFAULT_ORIGIN`) and, for --site, into prompt.md.
 *
 * The zip is the plugin root: `agent-setup/plugin/**`, plus `bin/omr-agent.mjs`
 * (this directory's single file, so the plugin and the CLI never disagree) and
 * `bin/omr-boot` (the shim `omr-agent.mjs` exports). It is byte-for-byte
 * reproducible — sorted entries, a fixed timestamp, stored rather than
 * deflated — so the same source always yields the same sha256, and the digest
 * in marketplace.json can be checked by anyone who rebuilds it.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';
import { BOOT_SHIM, VERSION } from './omr-agent.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const PLUGIN_DIR = join(here, 'plugin');
export const MARKETPLACE_NAME = 'onmyradar';
const DEFAULT_BASE_URL = `${(process.env.OMR_PUBLIC_URL || 'http://localhost:3500').replace(/\/+$/, '')}/agent-setup`;
const ORIGIN_LINE = /^export const DEFAULT_ORIGIN = '[^']*';$/m;

/** omr-agent.mjs with `DEFAULT_ORIGIN` set to the origin of `baseUrl`. */
function agentSource(baseUrl) {
  const source = readFileSync(join(here, 'omr-agent.mjs'), 'utf8');
  if (!ORIGIN_LINE.test(source))
    throw new Error('omr-agent.mjs has no DEFAULT_ORIGIN line to stamp');
  return Buffer.from(
    source.replace(ORIGIN_LINE, `export const DEFAULT_ORIGIN = '${new URL(baseUrl).origin}';`),
  );
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
}

/** Every file in the plugin, as [zip path, bytes, unix mode], sorted by path. */
export function pluginFiles(baseUrl = DEFAULT_BASE_URL) {
  const manifest = JSON.parse(readFileSync(join(PLUGIN_DIR, '.claude-plugin/plugin.json'), 'utf8'));
  if (manifest.version !== VERSION) {
    throw new Error(
      `plugin.json says ${manifest.version} but omr-agent.mjs is ${VERSION}; bump them together`,
    );
  }
  const files = walk(PLUGIN_DIR).map((path) => [
    relative(PLUGIN_DIR, path).split('\\').join('/'),
    readFileSync(path),
    statSync(path).mode & 0o111 ? 0o755 : 0o644,
  ]);
  files.push(['bin/omr-agent.mjs', agentSource(baseUrl), 0o755]);
  files.push(['bin/omr-boot', Buffer.from(BOOT_SHIM), 0o755]);
  return files.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** A stored (uncompressed) zip with fixed timestamps and unix modes. */
export function zip(files) {
  const DOS_TIME = 0; // 00:00:00
  const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data, mode] of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by: unix
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(((0o100000 | mode) << 16) >>> 0, 38); // regular file + mode
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

export function marketplace(baseUrl, archiveName, sha256) {
  const manifest = JSON.parse(readFileSync(join(PLUGIN_DIR, '.claude-plugin/plugin.json'), 'utf8'));
  return {
    name: MARKETPLACE_NAME,
    owner: { name: 'On My Radar', url: new URL(baseUrl).origin },
    description: 'On My Radar agents for Claude Code.',
    plugins: [
      {
        name: manifest.name,
        description: manifest.description,
        version: manifest.version,
        source: { source: 'archive', url: `${baseUrl}/${archiveName}`, sha256 },
      },
    ],
  };
}

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** The plugin zip, its digest-bearing name, and marketplace.json bytes. Writes nothing. */
function pluginArtifacts(baseUrl) {
  const archive = zip(pluginFiles(baseUrl));
  const sha256 = sha(archive);
  const archiveName = `omr-plugin-${VERSION}-${sha256.slice(0, 12)}.zip`;
  const market = Buffer.from(
    `${JSON.stringify(marketplace(baseUrl.replace(/\/+$/, ''), archiveName, sha256), null, 2)}\n`,
  );
  return { archive, archiveName, sha256, market };
}

/**
 * The plugin zip and its marketplace.json. The zip's name carries its digest
 * as well as the version, so a URL always means the same bytes: it can be
 * cached for a year, and a rebuild with a changed CLI but the same version
 * cannot leave a cached zip disagreeing with the sha256 in marketplace.json.
 */
export function build({ out, baseUrl = DEFAULT_BASE_URL }) {
  const { archive, archiveName, sha256, market } = pluginArtifacts(baseUrl);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, archiveName), archive);
  writeFileSync(join(out, 'marketplace.json'), market);
  return {
    archive: join(out, archiveName),
    archiveName,
    sha256,
    marketplace: join(out, 'marketplace.json'),
  };
}

function siteParts(baseUrl) {
  const plugin = pluginArtifacts(baseUrl);
  const agent = agentSource(baseUrl);
  const prompt = Buffer.from(
    readFileSync(join(here, 'prompt.md'), 'utf8')
      .replaceAll('{{VERSION}}', VERSION)
      .replaceAll('{{OMR_ORIGIN}}', new URL(baseUrl).origin),
  );
  if (prompt.includes('{{')) throw new Error('prompt.md has an unfilled placeholder');
  const sums = [
    `${sha(agent)}  omr-agent.mjs`,
    `${plugin.sha256}  ${plugin.archiveName}`,
    `${sha(prompt)}  prompt.md`,
  ];
  const files = new Map([
    ['SHA256SUMS', Buffer.from(`${sums.join('\n')}\n`)],
    ['marketplace.json', plugin.market],
    ['omr-agent.mjs', agent],
    [plugin.archiveName, plugin.archive],
    ['prompt.md', prompt],
  ]);
  return { files, archiveName: plugin.archiveName, sha256: plugin.sha256 };
}

/**
 * Everything served at <origin>/agent-setup/ as name -> bytes, stamped for
 * `baseUrl`: the plugin zip and marketplace.json, omr-agent.mjs, prompt.md
 * stamped with the version, and SHA256SUMS, which prompt.md tells the agent to
 * check its download against. Pure: it writes nothing, so the server can build
 * it once in memory for its configured PUBLIC_URL (`AGENT_SETUP_SRC`).
 */
export function siteFiles(baseUrl = DEFAULT_BASE_URL) {
  return siteParts(baseUrl).files;
}

/**
 * `siteFiles` written to disk. Built in CI into the UI bundle (`packages/ui`
 * build) for the nginx image and never committed.
 */
export function buildSite({ out, baseUrl = DEFAULT_BASE_URL }) {
  const { files, archiveName, sha256 } = siteParts(baseUrl);
  mkdirSync(out, { recursive: true });
  for (const [name, bytes] of files) writeFileSync(join(out, name), bytes);
  return {
    archive: join(out, archiveName),
    archiveName,
    sha256,
    marketplace: join(out, 'marketplace.json'),
    files: [...files.keys()],
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args[i + 1];
  };
  const result = (args.includes('--site') ? buildSite : build)({
    out: resolve(flag('--out') ?? join(here, 'dist')),
    ...(flag('--base-url') ? { baseUrl: flag('--base-url') } : {}),
  });
  process.stdout.write(`${result.archive}\nsha256 ${result.sha256}\n${result.marketplace}\n`);
}
