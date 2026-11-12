/**
 * <PUBLIC_URL>/agent-setup/, built once in memory for the running deployment.
 *
 * The public image cannot bake this at build time: one image serves every
 * deployment, and the origin in `prompt.md`, the marketplace URL and the CLI's
 * `DEFAULT_ORIGIN` is where an agent is told to send its credentials. So when
 * `AGENT_SETUP_SRC` names the `agent-setup/` source directory the server stamps
 * the files for `PUBLIC_URL` on first request and serves them from memory.
 *
 * The origin is configuration and nothing else. It is never read from the
 * request: a forged Host header must not be able to retarget the CLI's only
 * credential destination.
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { env } from './env.js';

type SiteFiles = ReadonlyMap<string, Buffer>;

interface BuildPlugin {
  siteFiles(baseUrl: string): SiteFiles;
}

let cached: { key: string; files: Promise<SiteFiles> } | null = null;

/** The stamped files, or null when `AGENT_SETUP_SRC` is unset (serve from disk instead). */
export function agentSetupFiles(): Promise<SiteFiles> | null {
  const { AGENT_SETUP_SRC: src, PUBLIC_URL: publicUrl } = env();
  if (!src) return null;
  const key = `${src}\n${publicUrl}`;
  if (cached?.key === key) return cached.files;
  const files = (
    import(pathToFileURL(join(src, 'build-plugin.mjs')).href) as Promise<BuildPlugin>
  ).then((mod) => mod.siteFiles(`${publicUrl}/agent-setup`));
  const entry = { key, files };
  cached = entry;
  // A failed build is not remembered: the next request tries again.
  files.catch(() => {
    if (cached === entry) cached = null;
  });
  return files;
}

/** Drop the memoised build (tests change env between cases). */
export function resetAgentSetupForTesting(): void {
  cached = null;
}
