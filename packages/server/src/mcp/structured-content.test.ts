/**
 * No MCP tool here returns `structuredContent`, and none declares an
 * `outputSchema` that would call for it.
 *
 * The rule exists because of a production failure. The MCP spec lets a client
 * prefer `structuredContent` over the text blocks, and Claude Code does: it hands
 * the model the structured JSON and drops the text. `load_agent` returned its
 * prompt, rules and memory index as text and only a session/counts summary as
 * structured content, so the model loaded an agent and reported "no system prompt
 * and no earlier memories". Structured content that is a lossy subset of the text
 * is worse than none, because some clients show it *instead*.
 *
 * If a tool ever needs an `outputSchema`, its `structuredContent` has to carry
 * everything its text does — change this test deliberately, with that tool's
 * superset assertion beside it, rather than loosening it.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { UserRow } from '../auth/accounts.js';
import { loadEnv, setEnvForTesting } from '../env.js';
import { buildMcpServer } from './server.js';

describe.skipIf(!process.env['DATABASE_URL'])(
  'MCP results are text, never a lossy structured view',
  () => {
    let client: Client;

    beforeAll(async () => {
      setEnvForTesting(
        loadEnv({
          ...process.env,
          DATABASE_URL: process.env['DATABASE_URL'] ?? 'postgres://unused/unused',
          SESSION_SECRET: 'structured-content-test-secret-not-used-anywhere',
        }),
      );
      // Listing tools reads no row, so a stand-in user is enough.
      const user = { id: '00000000-0000-4000-8000-000000000001', state: 'active' } as UserRow;
      const server = buildMcpServer({ user, kind: 'user' });
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      client = new Client({ name: 'structured-content-test', version: '1' });
      await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    });

    afterAll(async () => {
      await client.close();
      setEnvForTesting(null);
    });

    it('declares no outputSchema on any tool', async () => {
      const { tools } = await client.listTools();
      // Positive control: the listing really is the whole surface, not an empty page.
      expect(tools.length).toBeGreaterThan(50);
      expect(tools.map((t) => t.name)).toContain('load_agent');
      expect(tools.filter((t) => t.outputSchema).map((t) => t.name)).toEqual([]);
    });

    it('builds no structuredContent in any tool module', () => {
      const directory = new URL('./', import.meta.url);
      const sources = readdirSync(directory).filter(
        (file) => file.endsWith('.ts') && !file.endsWith('.test.ts'),
      );
      expect(sources).toContain('agent-repo.ts');
      const offenders = sources.filter((file) =>
        /structuredContent\s*[:,}]/.test(readFileSync(new URL(file, directory), 'utf8')),
      );
      expect(offenders).toEqual([]);
    });
  },
);
