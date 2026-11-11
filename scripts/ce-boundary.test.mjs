/**
 * The Community Edition must not import the Enterprise Edition (ee/). The rule lives in
 * eslint.config.js; this proves it bites, on a real package path, for each way of writing
 * the import. A dynamic `import('…')` is not covered by the rule; it fails the CE-only build
 * anyway, because the package or path does not exist there.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ESLint } from 'eslint';

const eslint = new ESLint({ cwd: new URL('..', import.meta.url).pathname });
const FILE = 'packages/contract/src/index.ts';

async function restricted(code, filePath = FILE) {
  const [result] = await eslint.lintText(code, { filePath });
  return result.messages.filter((m) => m.ruleId === 'no-restricted-imports');
}

for (const source of [
  '@onmyradar/ee-server',
  '@onmyradar/ee-ui/extension',
  'ee/server/src/main',
  '../../../ee/server/src/main',
  '../../../../ee/server/src/main.js',
]) {
  test(`packages/ may not import ${source}`, async () => {
    assert.equal((await restricted(`import x from '${source}';\nexport { x };\n`)).length, 1);
  });
}

test('nor re-export from it', async () => {
  assert.equal((await restricted(`export * from '@onmyradar/ee-server';\n`)).length, 1);
});

test('ordinary imports are untouched, including paths that merely contain "ee"', async () => {
  const code = `import a from '@onmyradar/contract';\nimport b from './tree/free.js';\nimport c from 'feed-parser';\nexport { a, b, c };\n`;
  assert.deepEqual(await restricted(code), []);
});
