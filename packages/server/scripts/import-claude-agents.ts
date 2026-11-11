/**
 * Import Claude Code agents into an On My Radar Agent Repo, over MCP.
 *
 *   OMR_MCP_URL=https://onmyradar.io/mcp OMR_TOKEN=omr_pat_… \
 *     pnpm --filter @onmyradar/server exec tsx scripts/import-claude-agents.ts [--dry-run] [--only a,b]
 *
 * Reads `~/.claude/agents/*.md` (frontmatter + prompt) and
 * `~/.claude/agent-memory/<name>/*.md` (one memory per file; MEMORY.md is an
 * index and is skipped — the Agent Repo computes its own). A memory directory
 * with no agent file becomes an agent with no prompt.
 *
 * **Read-only on the local side.** Nothing under ~/.claude is written, moved or
 * deleted; retiring the local copies is the person's decision. Each agent is
 * imported with `create_agent`, then exported with `export_agent` and compared
 * byte for byte, so the exit code says whether what arrived is what was read.
 * An agent whose slug already exists is reported and skipped, never merged.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  AGENT_REPO,
  HARNESSES,
  parseMemoryFile,
  repoSlugFrom,
  validateProfileSettings,
  type ImportAgentInput,
  type ProfileSettings,
} from '@onmyradar/contract';
import { httpTransport } from '../src/mcp/test-client.js';

const ROOT = process.env['CLAUDE_HOME'] ?? join(homedir(), '.claude');

/**
 * `--only a,b` and `--only=a,b` both. The usage line above documents the
 * spaced form, and this used to read only `--only=`: the documented form was
 * silently ignored and the run imported every agent instead of the named ones.
 */
export function parseArgs(argv: readonly string[]): {
  dryRun: boolean;
  only: Set<string> | null;
} {
  let onlyArg: string | null = null;
  for (const [index, arg] of argv.entries()) {
    if (arg.startsWith('--only=')) onlyArg = arg.slice('--only='.length);
    else if (arg === '--only') {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) throw new Error('--only needs a comma-separated list');
      onlyArg = next;
    }
  }
  const names = (onlyArg ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  return { dryRun: argv.includes('--dry-run'), only: names.length ? new Set(names) : null };
}

const KNOWN_KEYS = new Set([
  'name',
  'description',
  'model',
  'effort',
  'color',
  'tools',
  'disallowedTools',
  'memory',
]);

/** The frontmatter shape Claude Code writes: scalars, quoted or plain, continued by indentation. */
export function parseAgentFile(source: string): { fields: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(source);
  if (!match) return { fields: {}, body: source };
  const fields: Record<string, string> = {};
  let key: string | null = null;
  // Only Claude Code's own keys start a field. Real files are not always valid
  // YAML — a description followed by unindented `<example>` blocks is common,
  // and inside those `Context: …` looks like a key. Anything else continues the
  // current value: an indented line folds with a space (YAML's rule), an
  // unindented one keeps its newline (what the author meant).
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    const head = /^([A-Za-z_][\w-]*):\s?(.*)$/.exec(line);
    const name = head?.[1];
    if (name !== undefined && KNOWN_KEYS.has(name)) {
      key = name;
      fields[key] = head?.[2] ?? '';
    } else if (key) {
      const current = fields[key] ?? '';
      if (line.trim() === '') fields[key] = `${current}\n`;
      else if (/^\s+/.test(line))
        fields[key] = current.endsWith('\n')
          ? `${current}${line.trim()}`
          : `${current} ${line.trim()}`;
      else fields[key] = `${current}\n${line}`;
    }
  }
  for (const [k, raw] of Object.entries(fields)) {
    const v = raw.trim();
    if (v.startsWith('"') && v.endsWith('"')) {
      try {
        fields[k] = JSON.parse(v) as string;
        continue;
      } catch {
        /* fall through to the plain value */
      }
    }
    fields[k] = v.startsWith("'") && v.endsWith("'") ? v.slice(1, -1).replace(/''/g, "'") : v;
  }
  return { fields, body: (match[2] ?? '').replace(/^\s*\n/, '') };
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

export async function readBundles(
  root = ROOT,
  only: Set<string> | null = null,
): Promise<{
  bundles: ImportAgentInput[];
  skipped: string[];
  /** Names given to `only` that match no agent directory. */
  unknown: string[];
}> {
  const skipped: string[] = [];
  const bundles = new Map<string, ImportAgentInput>();
  const agentsDir = join(root, 'agents');
  const memoryDir = join(root, 'agent-memory');

  if (await exists(agentsDir)) {
    for (const file of (await readdir(agentsDir)).filter((f) => f.endsWith('.md')).sort()) {
      const dir = file.slice(0, -3);
      if (only && !only.has(dir)) continue;
      const { fields, body } = parseAgentFile(await readFile(join(agentsDir, file), 'utf8'));
      const slug = repoSlugFrom(fields['name'] ?? dir);
      // The Claude Code profile: each frontmatter key Claude Code's profile
      // has, checked one at a time, so one value the tool would not accept (a
      // colour Claude Code does not have) is reported and the rest still land.
      const config: ProfileSettings = {};
      for (const { key } of HARNESSES['claude-code'].fields) {
        const value = fields[key];
        if (!value) continue;
        const checked = validateProfileSettings('claude-code', { [key]: value });
        if (!checked.ok && (key === 'tools' || key === 'disallowedTools'))
          throw new Error(`${dir}: claude-code.${key} — ${checked.message}`);
        if (checked.ok) Object.assign(config, checked.value);
        else skipped.push(`${dir}: claude-code.${key} — ${checked.message}`);
      }
      bundles.set(dir, {
        name: fields['name'] ?? dir,
        slug,
        description: (fields['description'] ?? '').slice(0, AGENT_REPO.descriptionLength).trim(),
        ...(body.trim() ? { prompt: body } : {}),
        primaryHarness: 'claude-code',
        profiles: Object.keys(config).length ? { 'claude-code': config } : {},
        memories: [],
        briefs: [],
      });
    }
  }

  if (await exists(memoryDir)) {
    for (const dir of (await readdir(memoryDir)).sort()) {
      const path = join(memoryDir, dir);
      if (!(await stat(path)).isDirectory()) continue;
      const bundle =
        bundles.get(dir) ??
        ({
          name: dir,
          slug: repoSlugFrom(dir),
          description: '',
          profiles: {},
          memories: [],
          briefs: [],
        } satisfies ImportAgentInput);
      bundles.set(dir, bundle);
      const seen = new Set<string>();
      const files = (await readdir(path)).filter((f) => f.endsWith('.md')).sort();
      // MEMORY.md is normally an index of the other files, and the Agent Repo
      // computes its own. When it is the *only* file, it is not an index — it is
      // an older agent that kept everything in one place — and dropping it would
      // lose that agent's whole memory.
      const onlyIndex = files.length === 1 && files[0] === 'MEMORY.md';
      for (const file of files) {
        if (file === 'MEMORY.md' && !onlyIndex) continue;
        const source = await readFile(join(path, file), 'utf8');
        // A note with no frontmatter is still a memory somebody kept: it comes
        // across as `reference`, named from its file, described by its first
        // heading or line — rather than being dropped.
        const memory = parseMemoryFile(source, file.slice(0, -3)) ?? {
          name: onlyIndex ? 'notes' : repoSlugFrom(file.slice(0, -3)),
          type: onlyIndex ? ('project' as const) : ('reference' as const),
          description: (source.split('\n').find((l) => l.trim()) ?? file)
            .replace(/^#+\s*/, '')
            .slice(0, AGENT_REPO.memoryDescriptionLength)
            .trim(),
          body: source.trimEnd().slice(0, AGENT_REPO.memoryBodyLength),
        };
        if (!memory.name) {
          skipped.push(`${dir}/${file}: no usable name`);
          continue;
        }
        if (seen.has(memory.name)) {
          skipped.push(`${dir}/${file}: duplicate name '${memory.name}'`);
          continue;
        }
        seen.add(memory.name);
        bundle.memories.push(memory);
      }
    }
  }
  return {
    bundles: [...bundles.entries()]
      .filter(([dir]) => !only || only.has(dir))
      .map(([, bundle]) => bundle),
    skipped,
    unknown: only ? [...only].filter((dir) => !bundles.has(dir)) : [],
  };
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

async function main(): Promise<number> {
  const { dryRun, only } = parseArgs(process.argv.slice(2));
  const { bundles, skipped, unknown } = await readBundles(ROOT, only);
  // Asked for by name and not there is a typo, not an empty import.
  if (unknown.length) throw new Error(`--only names no local agent: ${unknown.join(', ')}`);
  const memories = bundles.reduce((n, b) => n + b.memories.length, 0);
  console.log(`read ${bundles.length} agents, ${memories} memories from ${ROOT}`);
  for (const s of skipped) console.log(`  skipped ${s}`);
  if (dryRun) return 0;

  const url = process.env['OMR_MCP_URL'];
  const token = process.env['OMR_TOKEN'];
  if (!url || !token) throw new Error('Set OMR_MCP_URL and OMR_TOKEN');
  const client = new Client({ name: 'import-claude-agents', version: '1' });
  await client.connect(
    httpTransport(new URL(url), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  const text = (r: Awaited<ReturnType<typeof client.callTool>>) =>
    (r.content as Array<{ text?: string }>)[0]?.text ?? '';

  let failed = 0;
  for (const bundle of bundles) {
    const created = await client.callTool({ name: 'create_agent', arguments: bundle });
    if (created.isError) {
      console.log(`  ✗ ${bundle.slug ?? bundle.name}: ${text(created)}`);
      failed += 1;
      continue;
    }
    const { id } = JSON.parse(text(created)) as { id: string };
    const exported = await client.callTool({ name: 'export_agent', arguments: { agent: id } });
    // Reported like any other mismatch rather than thrown: a throw here ended
    // the run half way, with the remaining agents neither imported nor listed.
    if (exported.isError) {
      console.log(
        `  ✗ ${bundle.slug ?? bundle.name}: imported, but export failed: ${text(exported)}`,
      );
      failed += 1;
      continue;
    }
    const back = JSON.parse(text(exported)) as ImportAgentInput;
    const sorted = [...bundle.memories].sort((a, b) => a.name.localeCompare(b.name, 'en'));
    const same =
      (back.prompt ?? '') === (bundle.prompt ?? '') &&
      back.description === bundle.description &&
      // jsonb stores object keys in its own order, so compare canonically.
      canonical(back.profiles ?? {}) === canonical(bundle.profiles ?? {}) &&
      JSON.stringify(back.memories) === JSON.stringify(sorted);
    console.log(
      `  ${same ? '✓' : '✗'} ${bundle.slug ?? bundle.name}: prompt ${bundle.prompt?.length ?? 0} chars, ${bundle.memories.length} memories${same ? '' : ' — EXPORT DIFFERS FROM SOURCE'}`,
    );
    if (!same) failed += 1;
  }
  await client.close();
  return failed === 0 ? 0 : 1;
}

/**
 * Whether this module is the one Node was asked to run. Compared as URLs, not
 * by prefixing `file://` onto the path: a path with a space or any other
 * character a URL escapes never matched, and the script exited 0 having done
 * nothing at all.
 */
export function isEntry(moduleUrl: string, argv1: string | undefined): boolean {
  return argv1 !== undefined && moduleUrl === pathToFileURL(argv1).href;
}

if (isEntry(import.meta.url, process.argv[1])) {
  process.exitCode = await main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  });
}
