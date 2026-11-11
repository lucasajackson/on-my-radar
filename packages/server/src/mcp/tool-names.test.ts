/**
 * The public guides list the MCP tools (blip 25cb0202). `docs/mcp-tools.json` is the sorted name
 * list of the live registry; the website vendors a copy and lints its guides against it. This fails
 * when a tool is added, renamed or removed without updating the JSON:
 * `UPDATE_MCP_TOOLS=1 pnpm --filter @onmyradar/server test src/mcp/tool-names.test.ts`.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import type { Actor } from '../http.js';
import { buildMcpServer } from './server.js';

const listFile = new URL('../../../../docs/mcp-tools.json', import.meta.url);

it('docs/mcp-tools.json is exactly the tools a full-scope /mcp connection lists', async () => {
  const actor = { kind: 'agent', user: { id: 'u' }, scopes: null } as unknown as Actor;
  const [near, far] = InMemoryTransport.createLinkedPair();
  await buildMcpServer(actor).connect(far);
  const client = new Client({ name: 'tool-names', version: '1' });
  await client.connect(near);
  const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
  await client.close();
  if (process.env['UPDATE_MCP_TOOLS'])
    writeFileSync(listFile, JSON.stringify(names, null, 2) + '\n');
  expect(JSON.parse(readFileSync(listFile, 'utf8'))).toEqual(names);
  expect(new Set(names).size).toBe(names.length);
});
