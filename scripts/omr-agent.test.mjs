/**
 * agent-setup/omr-agent.mjs against an in-process fake of the server: OAuth
 * discovery, registration, the code, refresh and device grants, and a
 * stateless /mcp that answers `load_agent` over SSE the way the real one does.
 *
 * The fake plays the person at the consent screen too, so `login` runs end to
 * end with no browser. Nothing here touches the real keychain: tokens go to a
 * file store in a temp directory, and the keychain adapters are tested
 * through a recorded command runner.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import {
  accessToken,
  boot,
  shellWritesMemory,
  tomlKeyPaths,
  validateWithCodex,
  BOOT_SHIM,
  CODEX_APPROVED_TOOLS,
  DEFAULT_ORIGIN,
  codexBlock,
  guardMemory,
  lineDiff,
  packParts,
  partLabel,
  runCommand,
  VERSION,
  classifyBlock,
  fileStore,
  loginLoopback,
  macKeychainStore,
  packBlocks,
  otherOmrServers,
  readPointer,
  run,
  run as run0,
  secretToolStore,
} from '../agent-setup/omr-agent.mjs';

const AGENT_ID = '11111111-2222-4333-8444-555555555555';
const SESSION = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

/* ------------------------------- the fake -------------------------------- */

function loadBlocksFor(prompt, extra = {}) {
  return [
    `# System prompt — On My Radar agent \`arch\` (v3, live)\n\n${prompt}`,
    '# How your memory works (rules v2)\n\nRules text.',
    `# Memory index — 2 of 2\n\n${extra.index ?? '- [feedback] a (r1) — one\n- [project] b (r1) — two'}`,
    '# Briefs — 1\n\n- omr-platform (r1, 2026-10-01) — platform facts',
    JSON.stringify({ session: SESSION, agent: { id: AGENT_ID, slug: 'arch' } }, null, 2),
  ];
}

async function fakeServer(opts = {}) {
  const state = {
    calls: [],
    refreshes: 0,
    issued: 0,
    codes: new Map(),
    access: new Set(),
    refresh: new Set(),
    devicePolls: 0,
    rpcs: [],
    prompt: opts.prompt ?? 'Be the architect.',
    loadError: opts.loadError ?? null,
  };
  const mint = () => {
    state.issued += 1;
    const access = `at-${state.issued}`;
    const refresh = `rt-${state.issued}`;
    state.access.add(access);
    state.refresh.add(refresh);
    return { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: 3600 };
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    let raw = '';
    for await (const chunk of req) raw += chunk;
    state.calls.push({
      method: req.method,
      path: url.pathname,
      auth: req.headers.authorization ?? null,
      ua: req.headers['user-agent'] ?? null,
    });
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    };
    const base = `http://127.0.0.1:${server.address().port}`;
    const published = opts.setup?.[url.pathname.replace('/agent-setup/', '')];
    if (url.pathname.startsWith('/agent-setup/') && published !== undefined) {
      res.writeHead(200).end(published);
      return;
    }
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      return json(200, {
        issuer: base,
        authorization_endpoint: `${base}/oauth/authorize`,
        token_endpoint: opts.foreignTokenEndpoint ?? `${base}/oauth/token`,
        registration_endpoint: `${base}/oauth/register`,
        ...(opts.device
          ? { device_authorization_endpoint: `${base}/oauth/device_authorization` }
          : {}),
      });
    }
    if (url.pathname === '/oauth/register') {
      const body = JSON.parse(raw);
      state.registered = body;
      return json(201, { client_id: 'omr_client_test', redirect_uris: body.redirect_uris });
    }
    if (url.pathname === '/oauth/authorize') {
      // The person approves on the consent screen; the server redirects.
      const q = url.searchParams;
      state.authorizeScope = q.get('scope');
      const code = `code-${state.codes.size + 1}`;
      state.codes.set(code, {
        challenge: q.get('code_challenge'),
        redirect: q.get('redirect_uri'),
      });
      const back = new URL(q.get('redirect_uri'));
      back.searchParams.set('code', code);
      back.searchParams.set('state', q.get('state'));
      res.writeHead(302, { location: back.toString() }).end();
      return;
    }
    if (url.pathname === '/oauth/device_authorization') {
      return json(200, {
        device_code: 'dev-code',
        user_code: 'BCDF-GHJK',
        verification_uri: `${base}/connect/device`,
        expires_in: 600,
        interval: 1,
      });
    }
    if (url.pathname === '/oauth/token') {
      const form = new URLSearchParams(raw);
      const grant = form.get('grant_type');
      if (grant === 'authorization_code') {
        const entry = state.codes.get(form.get('code'));
        const challenge = createHash('sha256')
          .update(form.get('code_verifier') ?? '')
          .digest('base64url');
        if (
          !entry ||
          entry.challenge !== challenge ||
          entry.redirect !== form.get('redirect_uri')
        ) {
          return json(400, { error: 'invalid_grant' });
        }
        state.codes.delete(form.get('code'));
        return json(200, mint());
      }
      if (grant === 'refresh_token') {
        state.refreshes += 1;
        await new Promise((ok) => setTimeout(ok, opts.slowRefreshMs ?? 30));
        if (!state.refresh.delete(form.get('refresh_token')))
          return json(400, { error: 'invalid_grant' });
        return json(200, mint());
      }
      if (grant === 'urn:ietf:params:oauth:grant-type:device_code') {
        state.devicePolls += 1;
        if (state.devicePolls === 1) return json(400, { error: 'authorization_pending' });
        if (state.devicePolls === 2) return json(400, { error: 'slow_down' });
        return json(200, mint());
      }
      return json(400, { error: 'unsupported_grant_type' });
    }
    if (url.pathname === '/mcp') {
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      if (!state.access.has(token)) {
        res.writeHead(401, { 'www-authenticate': 'Bearer' }).end();
        return;
      }
      const msg = JSON.parse(raw);
      state.lastRpc = msg;
      state.rpcs.push(msg);
      if (opts.stallMcpBody) {
        // Headers, then a body that never finishes.
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('event: message\n');
        return;
      }
      let result;
      if (msg.method === 'tools/list') {
        result = {
          tools: [
            'create_blip',
            'delete_blip',
            'share_radar',
            'agent_remember',
            'list_arrays',
            'set_radar_array',
          ].map((name) => ({
            name,
          })),
        };
      } else if (msg.method === 'tools/call' && msg.params.name === 'checkout_agent') {
        const args = msg.params.arguments;
        const pointer = {
          version: 1,
          server: `${base}/mcp`,
          agents: [{ id: AGENT_ID, slug: 'arch', role: 'primary', prompt: 'live' }],
        };
        result =
          args.agent === AGENT_ID
            ? {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      harness: args.harness,
                      operations: [
                        {
                          path: '.omr/agent.json',
                          op: 'write',
                          content: `${JSON.stringify(pointer, null, 2)}\n`,
                        },
                        { path: 'CLAUDE.md', op: 'ensure-line', line: '@.omr/AGENT.md' },
                      ],
                    }),
                  },
                ],
              }
            : { isError: true, content: [{ type: 'text', text: 'No agent with that id.' }] };
      } else if (msg.method === 'tools/call' && msg.params.name === 'load_agent') {
        result = state.loadError
          ? { isError: true, content: [{ type: 'text', text: state.loadError }] }
          : { content: loadBlocksFor(state.prompt).map((text) => ({ type: 'text', text })) };
      } else {
        result = { content: [{ type: 'text', text: `ok ${msg.params?.name ?? msg.method}` }] };
      }
      // SSE, as the real stateless transport answers.
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n\n`,
      );
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  // A failed assertion skips a test's own close; this one still runs.
  after(() => {
    server.closeAllConnections();
    server.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    state,
    origin,
    close: () =>
      new Promise((ok) => {
        server.close(() => ok());
        server.closeAllConnections();
      }),
  };
}

/** A temp HOME with a config dir, a file store, and optionally a pointer. */
function sandbox(origin, pointer = {}) {
  const home = mkdtempSync(join(tmpdir(), 'omr-agent-test-'));
  const cfg = join(home, 'cfg');
  const ws = join(home, 'ws', 'nested');
  mkdirSync(ws, { recursive: true });
  if (pointer !== null) {
    mkdirSync(join(home, 'ws', '.omr'), { recursive: true });
    writeFileSync(
      join(home, 'ws', '.omr', 'agent.json'),
      JSON.stringify({
        version: 1,
        server: pointer.server ?? `${origin}/mcp`,
        agents: [{ id: AGENT_ID, slug: 'arch', role: 'primary', prompt: pointer.prompt ?? 'live' }],
      }),
    );
  }
  const env = {
    OMR_TOKEN_STORE: 'file',
    OMR_CONFIG_DIR: cfg,
    OMR_ALLOWED_SERVERS: origin.startsWith('http') ? origin : '',
    PATH: process.env.PATH,
  };
  return { home, cfg, ws, env, store: fileStore(cfg) };
}

const capture = () => {
  const chunks = [];
  return { write: (s) => chunks.push(s), text: () => chunks.join('') };
};

/** `open` that follows the authorize URL like a browser, then the redirect. */
const browserApproves = (url) => {
  void fetch(url, { redirect: 'manual' }).then((r) => fetch(r.headers.get('location')));
};

async function loggedIn(fake, box) {
  const stderr = capture();
  const code = await run(['login', '--server', `${fake.origin}/mcp`, '--device=false'], {
    env: box.env,
    cwd: box.home,
    stderr,
    stdout: capture(),
    open: browserApproves,
  });
  assert.equal(code, 0, stderr.text());
}

/* --------------------------------- tests --------------------------------- */

test('pointer: found from a nested directory, primary chosen, pin read', () => {
  const box = sandbox('https://onmyradar.io', { server: 'https://onmyradar.io/mcp', prompt: 4 });
  const p = readPointer(join(box.home, 'ws', '.omr', 'agent.json'));
  assert.deepEqual(p.agent, { id: AGENT_ID, slug: 'arch' });
  assert.equal(p.pin, 4);
  assert.equal(p.origin, 'https://onmyradar.io');
  assert.equal(p.mcpUrl, 'https://onmyradar.io/mcp');
});

test('pointer: plain http off loopback and credentials in the URL are refused', () => {
  for (const server of ['http://evil.example/mcp', 'https://u:p@onmyradar.io/mcp']) {
    const box = sandbox('x', { server });
    assert.throws(
      () => readPointer(join(box.home, 'ws', '.omr', 'agent.json')),
      /https|credentials/,
    );
  }
});

test('login (loopback + PKCE) stores the token in the store, never on stdout', async () => {
  const fake = await fakeServer();
  const box = sandbox(fake.origin);
  const stdout = capture();
  const code = await run(['login', '--server', `${fake.origin}/mcp`], {
    env: box.env,
    cwd: box.home,
    stdout,
    stderr: capture(),
    open: browserApproves,
  });
  assert.equal(code, 0);
  assert.equal(stdout.text(), '');
  const record = await box.store.get(fake.origin);
  assert.equal(record.access_token, 'at-1');
  assert.match(fake.state.registered.redirect_uris[0], /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  const file = join(box.cfg, 'credentials.json');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  await fake.close();
});

test('login ignores a callback with the wrong state and keeps listening', async () => {
  const fake = await fakeServer();
  const forged = [];
  // Something else on the machine hits the port first; then the real redirect.
  const open = async (url) => {
    const r = await fetch(url, { redirect: 'manual' });
    const real = new URL(r.headers.get('location'));
    const fake2 = new URL(real);
    fake2.searchParams.set('state', 'forged');
    fake2.searchParams.set('code', 'attacker-code');
    forged.push((await fetch(fake2)).status);
    await fetch(real);
  };
  const record = await loginLoopback(fake.origin, { open, timeoutMs: 5000 });
  assert.deepEqual(forged, [400]);
  assert.equal(record.access_token, 'at-1');
  await fake.close();
});

test('login with only a wrong-state callback times out instead of accepting it', async () => {
  const fake = await fakeServer();
  const open = async (url) => {
    const r = await fetch(url, { redirect: 'manual' });
    const forged = new URL(r.headers.get('location'));
    forged.searchParams.set('state', 'forged');
    await fetch(forged);
  };
  await assert.rejects(loginLoopback(fake.origin, { open, timeoutMs: 300 }), /timed out/);
  await fake.close();
});

test('login asks for read and write only, never radars:manage', async () => {
  const fake = await fakeServer();
  const box = sandbox(fake.origin);
  await loggedIn(fake, box);
  assert.equal(fake.state.authorizeScope, 'radars:read radars:write');
  await fake.close();
});

test('login refuses metadata that names another host for the token endpoint', async () => {
  const fake = await fakeServer({ foreignTokenEndpoint: 'https://collector.example/token' });
  const box = sandbox(fake.origin);
  const stderr = capture();
  const code = await run(['login', '--server', `${fake.origin}/mcp`], {
    env: box.env,
    cwd: box.home,
    stdout: capture(),
    stderr,
    open: browserApproves,
  });
  assert.equal(code, 1);
  assert.match(stderr.text(), /another host for token_endpoint/);
  await fake.close();
});

test('login --device polls through authorization_pending and slow_down', async () => {
  const fake = await fakeServer({ device: true });
  const box = sandbox(fake.origin);
  const { loginDevice } = await import('../agent-setup/omr-agent.mjs');
  const waits = [];
  const record = await loginDevice(fake.origin, { sleep: async (ms) => void waits.push(ms) });
  assert.equal(record.access_token, 'at-1');
  assert.deepEqual(waits, [1000, 1000, 6000]);
  void box;
  await fake.close();
});

test('login --device says plainly when the server has no device grant', async () => {
  const fake = await fakeServer();
  const box = sandbox(fake.origin);
  const stderr = capture();
  const code = await run(['login', '--server', `${fake.origin}/mcp`, '--device'], {
    env: box.env,
    cwd: box.home,
    stdout: capture(),
    stderr,
  });
  assert.equal(code, 1);
  assert.match(stderr.text(), /does not offer the device grant/);
  await fake.close();
});

test('an expired token refreshes once, even when two boots race for it', async () => {
  const fake = await fakeServer();
  const box = sandbox(fake.origin);
  await loggedIn(fake, box);
  const record = await box.store.get(fake.origin);
  await box.store.set(fake.origin, { ...record, expires_at: Date.now() - 1000 });
  const deps = { store: box.store, env: box.env };
  const [a, b] = await Promise.all([
    accessToken(fake.origin, deps),
    accessToken(fake.origin, deps),
  ]);
  assert.equal(a, 'at-2');
  assert.equal(b, 'at-2');
  assert.equal(fake.state.refreshes, 1);
  await fake.close();
});

test('boot injects the prompt, the session and the harness, for Claude Code', async () => {
  const fake = await fakeServer();
  const box = sandbox(fake.origin, { prompt: 3 });
  await loggedIn(fake, box);
  const stdout = capture();
  const code = await run(['boot', '--harness', 'claude-code'], {
    hookInput: null,
    env: box.env,
    cwd: box.ws,
    stdout,
    stderr: capture(),
  });
  assert.equal(code, 0);
  const out = JSON.parse(stdout.text());
  assert.equal(out.continue, undefined);
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /Be the architect\./);
  assert.match(ctx, new RegExp(`Your session is \`${SESSION}\``));
  assert.match(ctx, /# How your memory works/);
  assert.match(out.systemMessage, /running as arch/);
  const args = fake.state.lastRpc.params.arguments;
  assert.equal(fake.state.lastRpc.params.name, 'load_agent');
  assert.equal(args.agent, AGENT_ID);
  assert.equal(args.harness, 'claude-code');
  assert.equal(args.version, 3);
  assert.equal(args.workspace, join(box.home, 'ws'));
  await fake.close();
});

test('boot --format codex emits the same SessionStart schema', async () => {
  const fake = await fakeServer();
  const box = sandbox(fake.origin);
  await loggedIn(fake, box);
  const stdout = capture();
  await run(['boot', '--harness', 'codex'], {
    hookInput: null,
    env: box.env,
    cwd: box.ws,
    stdout,
    stderr: capture(),
  });
  const out = JSON.parse(stdout.text());
  assert.deepEqual(Object.keys(out).sort(), ['hookSpecificOutput', 'systemMessage']);
  assert.deepEqual(Object.keys(out.hookSpecificOutput).sort(), [
    'additionalContext',
    'hookEventName',
  ]);
  assert.equal(fake.state.lastRpc.params.arguments.harness, 'codex');
  await fake.close();
});

test('boot with no pointer is a silent no-op', async () => {
  const box = sandbox('x', null);
  const stdout = capture();
  const code = await run(['boot', '--harness', 'claude-code'], {
    hookInput: null,
    env: box.env,
    cwd: box.ws,
    stdout,
    stderr: capture(),
  });
  assert.equal(code, 0);
  assert.equal(stdout.text(), '');
});

/* ------------------------------ fail closed ------------------------------ */

async function bootFails(box, extra = []) {
  const stdout = capture();
  const code = await run(['boot', '--harness', 'claude-code', ...extra], {
    hookInput: null,
    env: box.env,
    cwd: box.ws,
    stdout,
    stderr: capture(),
  });
  assert.equal(code, 0, 'a hook reports through its JSON, not its exit code');
  return JSON.parse(stdout.text());
}

test('fail closed: server unreachable stops the session and says so', async () => {
  const fake = await fakeServer();
  const box = sandbox(fake.origin);
  await loggedIn(fake, box);
  await fake.close();
  const out = await bootFails(box);
  assert.equal(out.continue, false);
  assert.match(out.stopReason, /arch was NOT loaded: could not reach/);
  assert.match(out.hookSpecificOutput.additionalContext, /Do not act as `arch`/);
});

test('fail closed: not logged in names the fix', async () => {
  const fake = await fakeServer();
  const box = sandbox(fake.origin);
  const out = await bootFails(box);
  assert.equal(out.continue, false);
  assert.match(out.stopReason, /not logged in .*omr-agent login/);
  assert.equal(fake.state.calls.length, 0, 'nothing was sent without a credential');
  await fake.close();
});

test('fail closed: load_agent refusing the agent', async () => {
  const fake = await fakeServer({ loadError: 'No agent with that id.' });
  const box = sandbox(fake.origin);
  await loggedIn(fake, box);
  const out = await bootFails(box);
  assert.equal(out.continue, false);
  assert.match(out.stopReason, /load_agent refused: No agent with that id/);
  await fake.close();
});

test('fail closed: a refresh the server refuses (disconnected grant)', async () => {
  const fake = await fakeServer();
  const box = sandbox(fake.origin);
  await loggedIn(fake, box);
  const record = await box.store.get(fake.origin);
  await box.store.set(fake.origin, { ...record, expires_at: 0, refresh_token: 'revoked' });
  const out = await bootFails(box);
  assert.match(out.stopReason, /expired or was disconnected/);
  await fake.close();
});

test('--on-fail warn keeps the session but still tells the model', async () => {
  const fake = await fakeServer();
  const box = sandbox(fake.origin);
  const out = await bootFails(box, ['--on-fail', 'warn']);
  assert.equal(out.continue, undefined);
  assert.match(out.hookSpecificOutput.additionalContext, /was NOT loaded/);
  await fake.close();
});

test('--format text exits 3 on failure', async () => {
  const fake = await fakeServer();
  const box = sandbox(fake.origin);
  const stderr = capture();
  const code = await run(['boot', '--harness', 'cursor', '--format', 'text'], {
    hookInput: null,
    env: box.env,
    cwd: box.ws,
    stdout: capture(),
    stderr,
  });
  assert.equal(code, 3);
  assert.match(stderr.text(), /NOT loaded/);
  await fake.close();
});

test('a pointer naming a server off the allowlist fails closed before any request', async () => {
  const real = await fakeServer();
  const hostile = await fakeServer();
  const box = sandbox(real.origin, { server: `${hostile.origin}/mcp` });
  await loggedIn(real, box);
  const out = await bootFails(box);
  assert.match(out.stopReason, /is not an allowed On My Radar server/);
  assert.equal(hostile.state.calls.length, 0);
  await real.close();
  await hostile.close();
});

test('a token is never sent to an origin it was not issued by, even an allowed one', async () => {
  const real = await fakeServer();
  const other = await fakeServer();
  const box = sandbox(real.origin, { server: `${other.origin}/mcp` });
  await loggedIn(real, box);
  box.env.OMR_ALLOWED_SERVERS = `${real.origin},${other.origin}`;
  const out = await bootFails(box);
  assert.match(out.stopReason, /not logged in to http:\/\/127\.0\.0\.1/);
  assert.equal(other.state.calls.filter((c) => c.auth).length, 0);
  await real.close();
  await other.close();
});

test('login never takes its server from the workspace pointer', async () => {
  const fake = await fakeServer();
  const box = sandbox(fake.origin); // pointer names the (allowed) fake
  const asked = [];
  const code = await run(['login'], {
    env: box.env,
    cwd: box.ws,
    stdout: capture(),
    stderr: capture(),
    fetchImpl: async (url) => {
      asked.push(new URL(url).origin);
      throw new Error('offline');
    },
  });
  assert.equal(code, 1);
  assert.deepEqual(asked, [DEFAULT_ORIGIN]);
  assert.equal(fake.state.calls.length, 0);
  await fake.close();
});

test('login --server off the allowlist is refused before any request', async () => {
  const box = sandbox('https://onmyradar.io');
  const stderr = capture();
  let requests = 0;
  const code = await run(['login', '--server', 'https://collector.example/mcp'], {
    env: box.env,
    cwd: box.home,
    stdout: capture(),
    stderr,
    fetchImpl: async () => {
      requests += 1;
      throw new Error('no');
    },
  });
  assert.equal(code, 1);
  assert.equal(requests, 0);
  assert.match(stderr.text(), /not an allowed On My Radar server/);
});

/* -------------------------------- deadline -------------------------------- */

test('deadline: a slow refresh fails closed with a message, inside the deadline', async () => {
  const fake = await fakeServer({ slowRefreshMs: 5000 });
  const box = sandbox(fake.origin);
  await loggedIn(fake, box);
  const record = await box.store.get(fake.origin);
  await box.store.set(fake.origin, { ...record, expires_at: 0 });
  const started = Date.now();
  const out = await bootFails(box, ['--deadline-ms', '400']);
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
  assert.equal(out.continue, false);
  assert.match(out.stopReason, /NOT loaded: loading took longer than 0\.4 s/);
  await fake.close();
});

test('deadline: a live process holding the refresh lock is waited on, never raced', async () => {
  const fake = await fakeServer();
  const box = sandbox(fake.origin);
  await loggedIn(fake, box);
  const record = await box.store.get(fake.origin);
  await box.store.set(fake.origin, { ...record, expires_at: 0 });
  mkdirSync(join(box.cfg, 'refresh.lock'));
  writeFileSync(join(box.cfg, 'refresh.lock', 'pid'), String(process.pid)); // alive
  const out = await bootFails(box, ['--deadline-ms', '300']);
  assert.match(out.stopReason, /longer than 0\.3 s/);
  assert.equal(fake.state.refreshes, 0, 'the single-use refresh token was not spent');
  await fake.close();
});

test('a refresh lock left by a dead process is taken over at once', async () => {
  const fake = await fakeServer();
  const box = sandbox(fake.origin);
  await loggedIn(fake, box);
  const record = await box.store.get(fake.origin);
  await box.store.set(fake.origin, { ...record, expires_at: 0 });
  const dead = spawnSync(process.execPath, ['-e', 'process.pid']);
  mkdirSync(join(box.cfg, 'refresh.lock'));
  writeFileSync(join(box.cfg, 'refresh.lock', 'pid'), String(dead.pid));
  const token = await accessToken(fake.origin, { store: box.store, env: box.env });
  assert.equal(token, 'at-2');
  await fake.close();
});

/* --------------------------------- packing -------------------------------- */

test('packing drops whole blocks by priority and names what it dropped', () => {
  const blocks = loadBlocksFor('P'.repeat(3000), { index: '- x\n'.repeat(1500) });
  const packed = packBlocks('HEADER', blocks, 4000);
  assert.ok(packed.text.length <= 4000, `${packed.text.length}`);
  assert.match(packed.text, /P{3000}/);
  assert.match(packed.text, /# How your memory works/);
  assert.doesNotMatch(packed.text, /# Memory index/);
  assert.match(
    packed.text,
    /Not shown, to fit the hook's limit: the memory index \(agent_recall\)/,
  );
  assert.deepEqual(packed.dropped, ['index']);
});

test('a prompt over the hook limit fails closed — never injected in part', async () => {
  const fake = await fakeServer({ prompt: 'Q'.repeat(12_000) });
  const box = sandbox(fake.origin);
  await loggedIn(fake, box);
  const out = await bootFails(box);
  assert.equal(out.continue, false);
  assert.match(out.stopReason, /not loaded rather than loaded in part/);
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.doesNotMatch(ctx, /QQQQ/, 'no part of the prompt was injected');
  assert.ok(!existsSync(join(box.cfg, 'sessions')), 'nothing was spilled to disk');
  await fake.close();
});

test('classifyBlock knows every block loadBlocks writes', () => {
  assert.deepEqual(loadBlocksFor('x').map(classifyBlock), [
    'prompt',
    'rules',
    'index',
    'briefs',
    'summary',
  ]);
  assert.equal(classifyBlock('# For Codex — added to the shared prompt\n\nx'), 'addendum');
  assert.equal(classifyBlock('# Mentioned since you were last loaded — 1 unread'), 'mentions');
  assert.equal(classifyBlock('# Pinned memories\n'), 'pinned');
});

/* ---------------------------------- bridge --------------------------------- */

test('the mcp bridge relays a line each way and refreshes on a 401', async () => {
  const fake = await fakeServer();
  const box = sandbox(fake.origin);
  await loggedIn(fake, box);
  fake.state.access.clear(); // the server forgot the access token: expect a refresh
  const input = new PassThrough();
  const stdout = capture();
  const done = run(['mcp'], { env: box.env, cwd: box.ws, stdin: input, stdout, stderr: capture() });
  input.write(
    `${JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'agent_remember', arguments: {} } })}\n`,
  );
  input.end();
  assert.equal(await done, 0);
  const reply = JSON.parse(stdout.text().trim());
  assert.equal(reply.id, 9);
  assert.equal(reply.result.content[0].text, 'ok agent_remember');
  assert.equal(fake.state.refreshes, 1);
  await fake.close();
});

test('the mcp bridge answers requests with an error when not logged in', async () => {
  const box = sandbox('http://127.0.0.1:9', {});
  const input = new PassThrough();
  const stdout = capture();
  const done = run(['mcp'], { env: box.env, cwd: box.ws, stdin: input, stdout, stderr: capture() });
  input.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
  input.end();
  await done;
  const reply = JSON.parse(stdout.text().trim());
  assert.equal(reply.id, 1);
  assert.match(reply.error.message, /not logged in.*omr-agent login/);
});

test('the bridge answers a request whose reply body stalls with an error, not silence', async () => {
  const fake = await fakeServer({ stallMcpBody: true });
  const box = sandbox(fake.origin);
  await loggedIn(fake, box);
  box.env.OMR_HTTP_TIMEOUT_MS = '200';
  const input = new PassThrough();
  const stdout = capture();
  const done = run(['mcp'], { env: box.env, cwd: box.ws, stdin: input, stdout, stderr: capture() });
  input.write(
    `${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'create_blip', arguments: {} } })}\n`,
  );
  input.end();
  await done;
  const reply = JSON.parse(stdout.text().trim());
  assert.equal(reply.id, 7);
  assert.match(reply.error.message, /reply could not be read/);
  await fake.close();
});

test('the bridge lists and calls only the default tools; --allow opts one in', async () => {
  const fake = await fakeServer();
  const box = sandbox(fake.origin);
  await loggedIn(fake, box);
  const session = async (args, lines) => {
    const input = new PassThrough();
    const stdout = capture();
    const done = run(['mcp', ...args], {
      env: box.env,
      cwd: box.ws,
      stdin: input,
      stdout,
      stderr: capture(),
    });
    for (const l of lines) input.write(`${JSON.stringify(l)}\n`);
    input.end();
    await done;
    return stdout
      .text()
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .sort((a, b) => a.id - b.id);
  };
  const call = (id, name) => ({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: {} },
  });
  const [list, del, share, create] = await session(
    [],
    [
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      call(2, 'delete_blip'),
      call(3, 'share_radar'),
      call(4, 'create_blip'),
    ],
  );
  assert.deepEqual(
    list.result.tools.map((t) => t.name),
    ['create_blip', 'agent_remember', 'list_arrays'],
  );
  assert.match(del.error.message, /delete_blip is not enabled/);
  assert.match(share.error.message, /share_radar is not enabled/);
  assert.equal(create.result.content[0].text, 'ok create_blip');
  assert.deepEqual(
    fake.state.rpcs.filter((m) => m.method === 'tools/call').map((m) => m.params.name),
    ['create_blip'],
    'refused calls never reached the server',
  );
  // The collaboration tools are on by default.
  const collab = await session([], [call(6, 'claim_blip'), call(7, 'request_decision')]);
  assert.deepEqual(
    collab.map((r) => r.result.content[0].text),
    ['ok claim_blip', 'ok request_decision'],
  );
  const [allowed] = await session(['--allow', 'delete_blip'], [call(5, 'delete_blip')]);
  assert.equal(allowed.result.content[0].text, 'ok delete_blip');
  await fake.close();
});

/* -------------------------------- keychains -------------------------------- */

function recordingRunner(answer = { code: 0, stdout: '', stderr: '' }) {
  const calls = [];
  return {
    calls,
    run: async (cmd, args, input) => {
      calls.push({ cmd, args, input: input ?? '' });
      return answer;
    },
  };
}

test('macOS Keychain: the secret goes in on stdin, never in argv', async () => {
  const r = recordingRunner();
  const store = macKeychainStore(r.run);
  const record = {
    client_id: 'c',
    access_token: 'SECRET-ACCESS',
    refresh_token: 'SECRET-REFRESH',
    expires_at: 1,
  };
  await store.set('https://onmyradar.io', record);
  const [call] = r.calls;
  assert.equal(call.cmd, 'security');
  assert.deepEqual(call.args, ['-i']);
  const argv = JSON.stringify(r.calls.map((c) => c.args));
  assert.doesNotMatch(argv, /SECRET/);
  const encoded = /-w "([^"]+)"/.exec(call.input)[1];
  assert.deepEqual(JSON.parse(Buffer.from(encoded, 'base64url').toString()), record);
  await assert.rejects(store.set('https://x" -A "evil', record), /refusing to store/);
});

test('Secret Service: the secret goes in on stdin, never in argv', async () => {
  const r = recordingRunner();
  const store = secretToolStore(r.run);
  await store.set('https://onmyradar.io', { access_token: 'SECRET', refresh_token: 'SECRET2' });
  assert.doesNotMatch(JSON.stringify(r.calls.map((c) => c.args)), /SECRET/);
  assert.ok(r.calls[0].input.length > 0);
});

test('boot reads back what the macOS store wrote', async () => {
  let saved = '';
  const store = macKeychainStore(async (cmd, args, input) => {
    if (args[0] === '-i') saved = /-w "([^"]+)"/.exec(input)[1];
    return { code: 0, stdout: args[0] === 'find-generic-password' ? `${saved}\n` : '', stderr: '' };
  });
  await store.set('https://onmyradar.io', { access_token: 'a', refresh_token: 'r', expires_at: 5 });
  assert.equal((await store.get('https://onmyradar.io')).access_token, 'a');
  void boot;
});

/* ========================= slice 2: split, plugin, install ========================= */

/** A prompt shaped like lulu's: ~10.5K characters of paragraphs. */
const LONG_PROMPT = Array.from(
  { length: 60 },
  (_, i) => `Paragraph ${i}: ${'principle '.repeat(17)}end-${i}.`,
).join('\n\n');

const bootPart = (box, k, n, hookInput, extra = []) => {
  const stdout = capture();
  return run(['boot', '--harness', 'claude-code', '--part', `${k}/${n}`, ...extra], {
    env: box.env,
    cwd: box.home, // the hook input's cwd is what counts
    stdout,
    stderr: capture(),
    hookInput,
  }).then((code) => ({ code, out: stdout.text() ? JSON.parse(stdout.text()) : null }));
};

const loads = (fake) => fake.state.rpcs.filter((m) => m.params?.name === 'load_agent').length;

test('packParts: a ~10.5K prompt arrives whole across parts, each under the cap', () => {
  assert.ok(LONG_PROMPT.length > 10_000);
  const blocks = loadBlocksFor(LONG_PROMPT);
  const { parts } = packParts('HEADER', blocks, 9500, 4);
  assert.ok(parts.length >= 2 && parts.length <= 4, `${parts.length} parts`);
  parts.forEach((p, i) => {
    assert.ok(p.length <= 9500, `part ${i + 1} is ${p.length}`);
    assert.ok(p.startsWith(partLabel(i + 1, parts.length)));
  });
  const joined = parts.join('\n\n');
  for (let i = 0; i < 60; i++) assert.ok(joined.includes(`end-${i}.`), `paragraph ${i}`);
  assert.ok(joined.includes('HEADER'));
  assert.ok(joined.includes('# How your memory works'));
});

test('packParts: a prompt that needs more parts than configured fails closed', () => {
  const blocks = loadBlocksFor(
    `${LONG_PROMPT}\n\n${LONG_PROMPT}\n\n${LONG_PROMPT}\n\n${LONG_PROMPT}`,
  );
  assert.throws(() => packParts('H', blocks, 9500, 4), /not loaded rather than loaded in part/);
});

test('packParts: one oversized paragraph is split at lines, nothing lost', () => {
  const para = Array.from({ length: 400 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n');
  const { parts } = packParts('H', loadBlocksFor(para), 9500, 4);
  const joined = parts.join('\n');
  for (let i = 0; i < 400; i++) assert.ok(joined.includes(`line ${i} `));
});

test('split boot: four hooks, one load, every part under the cap, the whole prompt', async () => {
  const fake = await fakeServer({ prompt: LONG_PROMPT });
  const box = sandbox(fake.origin);
  await loggedIn(fake, box);
  const hookInput = { session_id: 'cc-session-1', cwd: box.ws, source: 'startup' };
  const results = await Promise.all([4, 3, 2, 1].map((k) => bootPart(box, k, 4, hookInput)));
  const byPart = results.reverse();
  assert.equal(loads(fake), 1, 'load_agent was called once for all four parts');
  const contexts = byPart.map((r) => r.out?.hookSpecificOutput?.additionalContext ?? '');
  contexts.forEach((c) => assert.ok(c.length <= 9500, `${c.length}`));
  assert.ok(byPart[0].out.systemMessage.includes('running as arch'));
  assert.equal(byPart[1].out.systemMessage, undefined, 'only part 1 speaks to the person');
  const joined = contexts.join('\n\n');
  for (let i = 0; i < 60; i++) assert.ok(joined.includes(`end-${i}.`));
  assert.ok(contexts[0].includes(`Your session is \`${SESSION}\``));
  assert.ok(byPart.every((r) => r.code === 0));
  assert.ok(
    byPart.slice(2).some((r) => r.out === null),
    'unused parts print nothing',
  );
  await fake.close();
});

test('split boot: an earlier round of the same session is never reused', async () => {
  const fake = await fakeServer({ prompt: LONG_PROMPT });
  const box = sandbox(fake.origin);
  await loggedIn(fake, box);
  const hookInput = { session_id: 'cc-session-2', cwd: box.ws };
  // An earlier round (say, before a /compact) left its claim and record behind.
  await Promise.all([1, 2].map((k) => bootPart(box, k, 4, hookInput)));
  const fs = await import('node:fs');
  const dir = join(box.cfg, 'boot');
  const claimFile = fs.readdirSync(dir).find((f) => f.endsWith('.claim'));
  const old = JSON.parse(fs.readFileSync(join(dir, claimFile), 'utf8'));
  writeFileSync(join(dir, claimFile), JSON.stringify({ ...old, startedAt: Date.now() - 60_000 }));
  const oldRecord = join(dir, `${claimFile.replace(/\.claim$/, '')}.${old.loadId}.json`);
  writeFileSync(oldRecord, JSON.stringify({ loadId: old.loadId, parts: ['STALE 1', 'STALE 2'] }));
  const [p2, p1] = await Promise.all([
    bootPart(box, 2, 4, hookInput),
    bootPart(box, 1, 4, hookInput),
  ]);
  assert.doesNotMatch(p2.out.hookSpecificOutput.additionalContext, /STALE/);
  assert.match(p1.out.hookSpecificOutput.additionalContext, /part 1 of/);
  await fake.close();
});

test('split boot: a later part binds to one load id and reads only that load', async () => {
  const box = sandbox('https://onmyradar.io', { server: 'https://onmyradar.io/mcp' });
  const hookInput = { session_id: 'bind', cwd: box.ws };
  const dir = join(box.cfg, 'boot');
  mkdirSync(dir, { recursive: true });
  const key = createHash('sha256').update('claude-code\nbind').digest('hex').slice(0, 40);
  const A = 'a'.repeat(16);
  const B = 'b'.repeat(16);
  writeFileSync(join(dir, `${key}.claim`), JSON.stringify({ loadId: A, startedAt: Date.now() }));
  const pending = bootPart(box, 2, 2, hookInput, ['--deadline-ms', '2000']);
  await new Promise((ok) => setTimeout(ok, 150));
  // A newer round claims and finishes first; the bound part must not take it.
  writeFileSync(join(dir, `${key}.claim`), JSON.stringify({ loadId: B, startedAt: Date.now() }));
  writeFileSync(join(dir, `${key}.${B}.json`), JSON.stringify({ loadId: B, parts: ['B1', 'B2'] }));
  await new Promise((ok) => setTimeout(ok, 150));
  writeFileSync(join(dir, `${key}.${A}.json`), JSON.stringify({ loadId: A, parts: ['A1', 'A2'] }));
  const { out } = await pending;
  assert.equal(out.hookSpecificOutput.additionalContext, 'A2');
});

test('split boot: part 1 failing stops the session once; later parts stay quiet', async () => {
  const fake = await fakeServer();
  const box = sandbox(fake.origin); // not logged in
  const hookInput = { session_id: 'cc-session-3', cwd: box.ws };
  const [p1, p2] = await Promise.all([
    bootPart(box, 1, 4, hookInput),
    bootPart(box, 2, 4, hookInput),
  ]);
  assert.equal(p1.out.continue, false);
  assert.match(p1.out.stopReason, /not logged in/);
  assert.equal(p2.out, null);
  await fake.close();
});

test('split boot: a later part whose part 1 never answers fails closed itself', async () => {
  const box = sandbox('https://onmyradar.io');
  const out = (
    await bootPart(box, 3, 4, { session_id: 'orphan', cwd: box.ws }, ['--deadline-ms', '200'])
  ).out;
  assert.equal(out.continue, false);
  assert.match(out.stopReason, /part 3 of the load never received part 1/);
});

test('split boot: without the harness session id, part 1 fails closed', async () => {
  const box = sandbox('https://onmyradar.io');
  const p1 = (await bootPart(box, 1, 4, { cwd: box.ws })).out;
  const p2 = (await bootPart(box, 2, 4, { cwd: box.ws })).out;
  assert.equal(p1.continue, false);
  assert.match(p1.stopReason, /needs the harness session id/);
  assert.equal(p2, null);
});

test("boot follows the hook input's cwd, not the process's", async () => {
  const fake = await fakeServer();
  const box = sandbox(fake.origin);
  await loggedIn(fake, box);
  const { out } = await bootPart(box, 1, 1, { session_id: 's', cwd: box.ws });
  assert.match(out.hookSpecificOutput.additionalContext, /Be the architect/);
  const none = await bootPart(box, 1, 1, { session_id: 's', cwd: box.cfg });
  assert.equal(none.out, null, 'no pointer above the hook cwd: a silent no-op');
  await fake.close();
});

/* --------------------------- deadline kills the helper --------------------------- */

test('deadline: a hung keychain helper is killed, not left behind', async () => {
  const box = sandbox('https://onmyradar.io', { server: 'https://onmyradar.io/mcp' });
  // The helper would leave a file at 0.7 s; killed at the 0.3 s deadline, it
  // never does. (No `ps`: CI's node image does not ship procps.)
  const marker = join(box.home, 'helper-finished');
  const started = Date.now();
  const result = await boot(
    { cwd: box.ws, harness: 'claude-code', format: 'claude', deadlineMs: 300 },
    {
      env: { ...box.env, OMR_TOKEN_STORE: 'keychain' },
      // Whatever the platform asks the keychain, it hangs.
      run: (cmd, args, input, opts) =>
        runCommand('/bin/sh', ['-c', `sleep 0.7; touch '${marker}'`], input, opts),
    },
  );
  assert.ok(Date.now() - started < 2000);
  assert.match(JSON.parse(result.stdout).stopReason, /longer than 0\.3 s/);
  await new Promise((ok) => setTimeout(ok, 1000));
  assert.ok(!existsSync(marker), 'the helper was killed before it could finish');
});

/* ------------------------------------ guard ------------------------------------ */

test('guard-memory: refuses local memory writes in an agent workspace, only there', () => {
  const box = sandbox('https://onmyradar.io', { server: 'https://onmyradar.io/mcp' });
  const home = join(box.home, 'home');
  const deny = (file_path, cwd = box.ws) =>
    guardMemory({ cwd, tool_name: 'Write', tool_input: { file_path } }, { home });
  const memory = join(home, '.claude/projects/-ws/memory/MEMORY.md');
  const out = JSON.parse(deny(memory));
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /agent_remember/);
  assert.ok(deny(join(home, '.codex/memories/x.md')));
  assert.ok(deny(join(box.home, 'ws/.omr/snapshot/arch/prompt.md')));
  assert.ok(deny(join(box.home, 'ws/.claude/agent-memory/arch/notes.md')));
  assert.equal(deny(join(box.home, 'ws/src/index.ts')), '', 'ordinary files are untouched');
  assert.equal(deny(memory, box.cfg), '', 'no agent pointer: no opinion');
  assert.ok(
    guardMemory(
      { cwd: box.ws, tool_name: 'NotebookEdit', tool_input: { notebook_path: memory } },
      { home },
    ),
  );
});

/* ----------------------------------- install ----------------------------------- */

function installBox(existing, validator = async () => true) {
  const box = sandbox('https://onmyradar.io', null);
  const codexHome = join(box.home, 'codex');
  mkdirSync(codexHome, { recursive: true });
  if (existing !== undefined) writeFileSync(join(codexHome, 'config.toml'), existing);
  const go = async (...args) => {
    const stdout = capture();
    const stderr = capture();
    const code = await run(['install', '--harness', 'codex', '--codex-home', codexHome, ...args], {
      env: box.env,
      cwd: box.home,
      stdout,
      stderr,
      stdin: { isTTY: false },
      validateToml: validator,
    });
    return { code, diff: stdout.text(), said: stderr.text() };
  };
  const config = () => readFileSync(join(codexHome, 'config.toml'), 'utf8');
  return { box, codexHome, go, config };
}

test('install: shows the diff and writes nothing without --yes', async () => {
  const before = 'model = "gpt-6"\n\n[mcp_servers.node_repl]\ncommand = "x"\n';
  const t = installBox(before);
  const dry = await t.go('--dry-run');
  assert.equal(dry.code, 0);
  assert.match(dry.diff, /^\+ \[mcp_servers\.omr\]$/m);
  assert.match(dry.diff, /^\+ \[\[hooks\.SessionStart\]\]$/m);
  assert.match(dry.diff, /^\+ additionalContextLimit = 0$/m);
  assert.equal(t.config(), before);
  const noYes = await t.go();
  assert.equal(noYes.code, 3);
  assert.match(noYes.said, /Nothing was written/);
  assert.equal(t.config(), before);
  assert.ok(!existsSync(join(t.box.cfg, 'bin')));
});

test('install --yes: writes the block, the CLI and the shim, keeps a backup; a rerun changes nothing', async () => {
  const before = 'model = "gpt-6"\n\n[mcp_servers.node_repl]\ncommand = "x"\n';
  const t = installBox(before);
  const first = await t.go('--yes');
  assert.equal(first.code, 0, first.said);
  const after1 = t.config();
  assert.ok(after1.startsWith(before.trimEnd()), 'existing settings untouched');
  assert.match(
    after1,
    /\[mcp_servers\.omr\]\ncommand = "node"\nargs = \[".*omr-agent\.mjs", "mcp", "--harness", "codex"\]/,
  );
  assert.match(after1, /command = "sh '.*omr-boot' codex 1\/1 --max-chars 200000"/);
  assert.equal(readFileSync(join(t.codexHome, 'config.toml.omr-backup'), 'utf8'), before);
  assert.equal(statSync(join(t.box.cfg, 'bin', 'omr-boot')).mode & 0o777, 0o700);
  assert.equal(readFileSync(join(t.box.cfg, 'bin', 'omr-boot'), 'utf8'), BOOT_SHIM);
  const second = await t.go('--yes');
  assert.equal(second.code, 0);
  assert.match(second.said, /already set up/);
  assert.equal(t.config(), after1, 'idempotent');
  assert.equal((after1.match(/\[mcp_servers\.omr\]/g) ?? []).length, 1);
});

test('install replaces its own block in place rather than adding a second', async () => {
  const t = installBox('');
  await t.go('--yes');
  const edited = t.config().replace('timeout = 20', 'timeout = 5');
  writeFileSync(join(t.codexHome, 'config.toml'), `${edited}\n[profiles.x]\nmodel = "y"\n`);
  const again = await t.go('--yes');
  assert.equal(again.code, 0);
  assert.match(again.diff, /^- timeout = 5$/m);
  assert.match(again.diff, /^\+ timeout = 20$/m);
  const text = t.config();
  assert.equal((text.match(/omr-agent \(managed/g) ?? []).length, 1);
  assert.match(text, /\[profiles\.x\]\nmodel = "y"/);
});

test('install refuses to fight a hand-written omr server or an inline SessionStart', async () => {
  for (const existing of [
    '[mcp_servers.omr]\ncommand = "other"\n',
    '[hooks]\nSessionStart = []\n',
  ]) {
    const t = installBox(existing);
    const r = await t.go('--yes');
    assert.equal(r.code, 1);
    assert.match(r.said, /"omr" MCP server|inline/);
    assert.equal(t.config(), existing);
  }
});

test('lineDiff marks only what changed', () => {
  assert.equal(lineDiff('a\nb\nc', 'a\nB\nc'), '  a\n- b\n+ B\n  c');
});

/* ------------------------------------- node ------------------------------------- */

test('Node older than 22: boot fails closed with a clear message; other commands say so', async () => {
  const box = sandbox('https://onmyradar.io', { server: 'https://onmyradar.io/mcp' });
  const stdout = capture();
  const code = await run(['boot', '--harness', 'claude-code'], {
    hookInput: null,
    env: box.env,
    cwd: box.ws,
    stdout,
    stderr: capture(),
    nodeVersion: '20.11.1',
  });
  assert.equal(code, 0);
  const out = JSON.parse(stdout.text());
  assert.equal(out.continue, false);
  assert.match(out.stopReason, /needs Node\.js 22 or newer; this is Node\.js 20\.11\.1/);
  const stderr = capture();
  assert.equal(
    await run(['status'], {
      env: box.env,
      cwd: box.ws,
      stdout: capture(),
      stderr,
      nodeVersion: '18.0.0',
    }),
    1,
  );
  assert.match(stderr.text(), /needs Node\.js 22/);
});

function shimDir(fakeNodeMajor) {
  const dir = mkdtempSync(join(tmpdir(), 'omr-shim-'));
  writeFileSync(join(dir, 'omr-boot'), BOOT_SHIM);
  writeFileSync(
    join(dir, 'omr-agent.mjs'),
    readFileSync(new URL('../agent-setup/omr-agent.mjs', import.meta.url)),
  );
  const fakeBin = join(dir, 'fakebin');
  mkdirSync(fakeBin);
  if (fakeNodeMajor !== undefined) {
    writeFileSync(join(fakeBin, 'node'), `#!/bin/sh\necho ${fakeNodeMajor}\n`, { mode: 0o755 });
  }
  return { dir, path: `${fakeBin}:/usr/bin:/bin` };
}

const runShim = (dir, path, cwd, args) =>
  spawnSync('/bin/sh', [join(dir, 'omr-boot'), ...args], {
    cwd,
    env: { PATH: path, HOME: tmpdir() },
    input: '',
  });

test('shim: Node missing or too old fails closed in the hook JSON (part 1 only)', () => {
  const box = sandbox('https://onmyradar.io', { server: 'https://onmyradar.io/mcp' });
  for (const [major, found] of [
    [18, '18'],
    [undefined, 'none'],
  ]) {
    const { dir, path } = shimDir(major);
    const r = runShim(dir, path, box.ws, ['claude-code', '1/4']);
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout.toString());
    assert.equal(out.continue, false);
    assert.match(out.stopReason, new RegExp(`needs Node\\.js 22 or newer \\(found: ${found}\\)`));
    assert.equal(runShim(dir, path, box.ws, ['claude-code', '2/4']).stdout.toString(), '');
    assert.equal(
      runShim(dir, path, box.home, ['claude-code', '1/4']).stdout.toString(),
      '',
      'no pointer: no-op',
    );
    assert.equal(runShim(dir, path, box.ws, ['guard-memory']).status, 0);
  }
});

test('shim: with Node 22 it hands over to omr-agent boot', () => {
  const box = sandbox('https://onmyradar.io', { server: 'https://onmyradar.io/mcp' });
  const { dir } = shimDir();
  const r = spawnSync('/bin/sh', [join(dir, 'omr-boot'), 'claude-code', '1/1'], {
    cwd: box.ws,
    env: { ...box.env, PATH: `${dirname(process.execPath)}:/usr/bin:/bin` },
    input: JSON.stringify({ session_id: 'x', cwd: box.ws }),
  });
  const out = JSON.parse(r.stdout.toString());
  assert.equal(out.continue, false);
  assert.match(out.stopReason, /not logged in to https:\/\/onmyradar\.io/);
});

/* -------------------------------- plugin build -------------------------------- */

/** Names and modes from a zip's central directory. */
function readZip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  const out = {};
  for (let i = 0; i < count; i++) {
    const nameLen = buf.readUInt16LE(at + 28);
    const extra = buf.readUInt16LE(at + 30);
    const comment = buf.readUInt16LE(at + 32);
    const mode = (buf.readUInt32LE(at + 38) >>> 16) & 0o777;
    const local = buf.readUInt32LE(at + 42);
    const size = buf.readUInt32LE(at + 20);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen);
    const dataAt = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    out[name] = { mode, data: buf.subarray(dataAt, dataAt + size) };
    at += 46 + nameLen + extra + comment;
  }
  return out;
}

test('plugin build: reproducible zip, sha256 in marketplace.json, the right hooks inside', async () => {
  const { build } = await import('../agent-setup/build-plugin.mjs');
  const outA = mkdtempSync(join(tmpdir(), 'omr-build-'));
  const outB = mkdtempSync(join(tmpdir(), 'omr-build-'));
  const a = build({ out: outA });
  const b = build({ out: outB });
  assert.equal(a.sha256, b.sha256, 'byte-for-byte reproducible');
  const zipBytes = readFileSync(a.archive);
  assert.equal(createHash('sha256').update(zipBytes).digest('hex'), a.sha256);
  const market = JSON.parse(readFileSync(a.marketplace, 'utf8'));
  assert.deepEqual(market.plugins[0].source, {
    source: 'archive',
    url: `${DEFAULT_ORIGIN}/agent-setup/omr-plugin-${VERSION}-${a.sha256.slice(0, 12)}.zip`,
    sha256: a.sha256,
  });
  const files = readZip(zipBytes);
  assert.deepEqual(Object.keys(files).sort(), [
    '.claude-plugin/plugin.json',
    '.mcp.json',
    'bin/omr-agent.mjs',
    'bin/omr-boot',
    'hooks/hooks.json',
  ]);
  assert.equal(JSON.parse(files['.claude-plugin/plugin.json'].data).version, VERSION);
  assert.equal(files['bin/omr-boot'].data.toString(), BOOT_SHIM);
  assert.equal(files['bin/omr-boot'].mode, 0o755);
  assert.equal(
    files['bin/omr-agent.mjs'].data.toString(),
    readFileSync(new URL('../agent-setup/omr-agent.mjs', import.meta.url), 'utf8'),
  );
  const hooks = JSON.parse(files['hooks/hooks.json'].data).hooks;
  const boots = hooks.SessionStart[0].hooks.map((h) => h.command);
  assert.deepEqual(
    boots.map((c) => /claude-code (\d\/\d)/.exec(c)[1]),
    ['1/4', '2/4', '3/4', '4/4'],
  );
  assert.ok(hooks.SessionStart[0].hooks.every((h) => h.timeout === 20));
  assert.equal(hooks.SessionStart[0].matcher, 'startup|clear|compact', 'not on resume or fork');
  assert.equal(hooks.PreToolUse[0].matcher, 'Write|Edit|MultiEdit|NotebookEdit|Bash');
  assert.match(hooks.PreToolUse[0].hooks[0].command, /omr-boot" guard-memory$/);
  const mcp = JSON.parse(files['.mcp.json'].data).mcpServers.omr;
  assert.deepEqual(mcp, {
    command: 'node',
    args: ['${CLAUDE_PLUGIN_ROOT}/bin/omr-agent.mjs', 'mcp'],
  });
});

/* ============================ slice 2 QA fixes ============================ */

test('tomlKeyPaths finds an omr server in every spelling, and not in strings or comments', () => {
  const has = (text) =>
    tomlKeyPaths(text).some(({ path }) => path[0] === 'mcp_servers' && path[1] === 'omr');
  for (const text of [
    '[mcp_servers.omr]\ncommand = "x"\n',
    '[ mcp_servers . "omr" ]\ncommand = "x"\n',
    "[mcp_servers.'omr'.env]\nA = '1'\n",
    '[mcp_servers]\nomr = { command = "x" }\n',
    '[mcp_servers]\n"omr".command = "x"\n',
    'mcp_servers.omr.command = "x"\n',
    'mcp_servers = { omr = { command = "x" } }\n',
    '[mcp_servers]\nother = { command = "y" }\nomr = { command = "x" }\n',
  ]) {
    assert.ok(has(text), text);
  }
  for (const text of [
    '# [mcp_servers.omr]\n',
    'notes = """\n[mcp_servers.omr]\nomr = 1\n"""\n',
    '[mcp_servers.omrx]\ncommand = "x"\n',
    'args = [\n  "omr = 1",\n]\n',
  ]) {
    assert.ok(!has(text), text);
  }
});

test('install refuses an existing omr server in any spelling (the duplicate-key blocker)', async () => {
  for (const existing of [
    '[mcp_servers]\nomr = { command = "x" }\n',
    '[mcp_servers.omr.env]\nA = "1"\n',
    'mcp_servers.omr.command = "x"\n',
    'mcp_servers = { omr = { command = "x" } }\n',
  ]) {
    const t = installBox(existing);
    const r = await t.go('--yes');
    assert.equal(r.code, 1, existing);
    assert.match(r.said, /"omr" MCP server/);
    assert.equal(t.config(), existing, 'nothing written');
  }
});

test("install asks Codex's parser before and after, and writes nothing if either fails", async () => {
  const rejectCurrent = installBox('model = "x"\n', async () => false);
  const r1 = await rejectCurrent.go('--yes');
  assert.equal(r1.code, 1);
  assert.match(r1.said, /Codex cannot load/);
  assert.equal(rejectCurrent.config(), 'model = "x"\n');
  const rejectNext = installBox('model = "x"\n', async (text) => !text.includes('omr-agent'));
  const r2 = await rejectNext.go('--yes');
  assert.equal(r2.code, 1);
  assert.match(r2.said, /would leave .* unloadable by Codex; nothing was written/);
  assert.equal(rejectNext.config(), 'model = "x"\n');
  assert.ok(!existsSync(join(rejectNext.box.cfg, 'bin')), 'no files copied either');
});

const hasCodex = spawnSync('codex', ['--version']).status === 0;

test(
  "validateWithCodex uses Codex's own parser",
  { skip: !hasCodex && 'codex not on PATH' },
  async () => {
    assert.equal(await validateWithCodex('model = "x"\n'), true);
    assert.equal(
      await validateWithCodex(
        '[mcp_servers]\nomr = { command = "x" }\n\n[mcp_servers.omr]\ncommand = "node"\n',
      ),
      false,
    );
    assert.equal(await validateWithCodex('model = \n'), false);
    const t = installBox('model = "gpt-6"\n', (text) => validateWithCodex(text));
    assert.equal((await t.go('--yes')).code, 0);
    assert.equal(await validateWithCodex(t.config()), true, 'what install wrote, Codex loads');
  },
);

test('install writes through a symlinked config.toml and keeps the link', async () => {
  const fs = await import('node:fs');
  const t = installBox();
  const target = join(t.box.home, 'dotfiles', 'codex.toml');
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, 'model = "x"\n');
  fs.symlinkSync(target, join(t.codexHome, 'config.toml'));
  const r = await t.go('--yes');
  assert.equal(r.code, 0, r.said);
  assert.ok(fs.lstatSync(join(t.codexHome, 'config.toml')).isSymbolicLink(), 'still a link');
  assert.match(readFileSync(target, 'utf8'), /\[mcp_servers\.omr\]/);
  assert.equal(readFileSync(`${target}.omr-backup`, 'utf8'), 'model = "x"\n');
  assert.match((await t.go('--yes')).said, /already set up/);
});

test('install adds the SessionStart matcher so a resume is not re-injected', async () => {
  const t = installBox('');
  await t.go('--yes');
  assert.match(
    t.config(),
    /\[\[hooks\.SessionStart\]\]\n(?:#.*\n)*matcher = "startup\|clear\|compact"/,
  );
});

test('guard-memory (advisory) catches shell writes into memory; leaves reads and other files alone', () => {
  const box = sandbox('https://onmyradar.io', { server: 'https://onmyradar.io/mcp' });
  const home = join(box.home, 'home');
  const bash = (command, cwd = box.ws) =>
    guardMemory({ cwd, tool_name: 'Bash', tool_input: { command } }, { home });
  for (const command of [
    "cat > ~/.claude/projects/-ws/memory/MEMORY.md <<'EOF'\nnote\nEOF",
    'echo hi >> $HOME/.claude/projects/-ws/memory/notes.md',
    'printf x | tee "${HOME}/.codex/memories/a.md"',
    'cp notes.md ~/.claude/agent-memory/arch/',
    `mv a ${home}/.claude/projects/x/memory/b`,
    'mkdir -p ~/.claude/projects/-ws/memory && echo a > ~/.claude/projects/-ws/memory/x',
    "python3 -c \"open('/x/.claude/projects/p/memory/m.md','w').write('a')\"",
    'rm .omr/snapshot/arch/prompt.md',
  ]) {
    const out = bash(command);
    assert.ok(out, command);
    assert.equal(JSON.parse(out).hookSpecificOutput.permissionDecision, 'deny');
  }
  for (const command of [
    'cat ~/.claude/projects/-ws/memory/MEMORY.md',
    'ls ~/.codex/memories',
    'echo done > out.txt',
    'grep -r memory src/',
  ]) {
    assert.equal(bash(command), '', command);
  }
  assert.equal(
    bash('echo a > ~/.claude/projects/-ws/memory/x', box.home),
    '',
    'no pointer: no opinion',
  );
  assert.equal(shellWritesMemory(''), false);
});

/* ============================ slice 3: agent-setup ============================ */

test('use: shows the pointer the server issues and writes only it, only with --yes', async () => {
  const fake = await fakeServer();
  const box = sandbox(fake.origin, null);
  await loggedIn(fake, box);
  const ws = join(box.home, 'project');
  mkdirSync(ws, { recursive: true });
  const go = async (...args) => {
    const stdout = capture();
    const stderr = capture();
    const code = await run(
      [
        'use',
        '--agent',
        AGENT_ID,
        '--harness',
        'claude-code',
        '--server',
        `${fake.origin}/mcp`,
        ...args,
      ],
      { env: box.env, cwd: ws, stdout, stderr },
    );
    return { code, diff: stdout.text(), said: stderr.text() };
  };
  const dry = await go();
  assert.equal(dry.code, 3);
  assert.match(dry.diff, /^\+ +"slug": "arch",$/m);
  assert.ok(!existsSync(join(ws, '.omr')), 'nothing written without --yes');
  const wrote = await go('--yes');
  assert.equal(wrote.code, 0, wrote.said);
  const pointer = JSON.parse(readFileSync(join(ws, '.omr/agent.json'), 'utf8'));
  assert.equal(pointer.agents[0].id, AGENT_ID);
  assert.ok(!existsSync(join(ws, 'CLAUDE.md')), 'only the pointer: the hook does the loading');
  const call = fake.state.rpcs.find((m) => m.params?.name === 'checkout_agent');
  assert.deepEqual(call.params.arguments, {
    agent: AGENT_ID,
    harness: 'claude-code',
    mode: 'primary',
  });
  assert.match((await go('--yes')).said, /already points at this agent/);
  await fake.close();
});

test('use: an unknown agent or a malformed id is refused, nothing written', async () => {
  const fake = await fakeServer();
  const box = sandbox(fake.origin, null);
  await loggedIn(fake, box);
  for (const id of ['11111111-2222-4333-8444-000000000000', 'not-a-uuid']) {
    const stderr = capture();
    const code = await run(['use', '--agent', id, '--server', `${fake.origin}/mcp`, '--yes'], {
      env: box.env,
      cwd: box.home,
      stdout: capture(),
      stderr,
    });
    assert.equal(code, 1);
    assert.match(stderr.text(), /checkout_agent refused|needs --agent/);
  }
  assert.ok(!existsSync(join(box.home, '.omr')));
  await fake.close();
});

test('site build stamps the deployment origin into prompt.md and the bundled omr-agent', async () => {
  const { buildSite } = await import('../agent-setup/build-plugin.mjs');
  const out = mkdtempSync(join(tmpdir(), 'omr-stamp-'));
  const baseUrl = 'https://omr.example.org/agent-setup';
  const site = buildSite({ out, baseUrl });
  const prompt = readFileSync(join(out, 'prompt.md'), 'utf8');
  assert.match(prompt, /https:\/\/omr\.example\.org\/agent-setup\/omr-agent\.mjs/);
  assert.doesNotMatch(prompt, /localhost|\{\{/);
  const agent = readFileSync(join(out, 'omr-agent.mjs'), 'utf8');
  assert.match(agent, /^export const DEFAULT_ORIGIN = 'https:\/\/omr\.example\.org';$/m);
  // The plugin zip carries the same stamped file, and SHA256SUMS describes what is served.
  const zipped = readZip(readFileSync(site.archive))['bin/omr-agent.mjs'].data.toString();
  assert.equal(zipped, agent);
  const sums = readFileSync(join(out, 'SHA256SUMS'), 'utf8');
  assert.ok(sums.includes(createHash('sha256').update(agent).digest('hex')));
  const market = JSON.parse(readFileSync(join(out, 'marketplace.json'), 'utf8'));
  assert.equal(market.owner.url, 'https://omr.example.org');
});

test('site build: every file prompt.md names, SHA256SUMS true, prompt static and stamped', async () => {
  const { buildSite } = await import('../agent-setup/build-plugin.mjs');
  const out = mkdtempSync(join(tmpdir(), 'omr-site-'));
  const site = buildSite({ out });
  const names = (await import('node:fs')).readdirSync(out).sort();
  assert.deepEqual(names, [...site.files].sort());
  assert.match(
    site.archiveName,
    new RegExp(`^omr-plugin-${VERSION.replaceAll('.', '\\.')}-[0-9a-f]{12}\\.zip$`),
  );
  const sums = readFileSync(join(out, 'SHA256SUMS'), 'utf8').trim().split('\n');
  for (const line of sums) {
    const [digest, name] = line.split(/\s+/);
    assert.equal(
      createHash('sha256')
        .update(readFileSync(join(out, name)))
        .digest('hex'),
      digest,
      name,
    );
  }
  assert.equal(
    readFileSync(join(out, 'omr-agent.mjs'), 'utf8'),
    readFileSync(new URL('../agent-setup/omr-agent.mjs', import.meta.url), 'utf8'),
  );
  const prompt = readFileSync(join(out, 'prompt.md'), 'utf8');
  assert.match(prompt, new RegExp(`omr-agent-setup ${VERSION.replaceAll('.', '\\.')}`));
  assert.doesNotMatch(prompt, /\{\{/);
  // a96ed27 replaced "show the person … and wait for their OK" with autonomous delivery. The
  // prompt is public, so it states that rule itself and never points at a file on our machines.
  assert.match(prompt, /without stopping to ask/);
  assert.doesNotMatch(prompt, /STANDARDS\.md|~\/Documents|\/Users\//);
  assert.match(prompt, /Never print, paste, ask for or store a token or password/);
  // Everything prompt.md tells the agent to fetch is something the site serves.
  for (const [, file] of prompt.matchAll(
    /https:\/\/onmyradar\.io\/agent-setup\/([A-Za-z0-9._-]+)/g,
  )) {
    assert.ok(names.includes(file), `prompt.md names ${file}`);
  }
  // And every command it names exists in this omr-agent.
  for (const [, cmd] of prompt.matchAll(/omr-agent\.mjs (\w[\w-]*)/g)) {
    assert.ok(['login', 'status', 'install', 'use'].includes(cmd), cmd);
  }
  assert.match(prompt, /claude plugin install omr@onmyradar/);
  const market = JSON.parse(readFileSync(join(out, 'marketplace.json'), 'utf8'));
  assert.equal(market.name, 'onmyradar');
  assert.equal(market.plugins[0].name, 'omr');
});

/* ------------------------------ S3: the Codex path ------------------------------ */

test('every request to the server names this omr-agent version', async () => {
  const fake = await fakeServer();
  const box = sandbox(fake.origin);
  await loggedIn(fake, box);
  const out = await boot(
    { cwd: box.ws, harness: 'codex', format: 'text' },
    { env: box.env, store: box.store },
  );
  assert.equal(out.loaded, true);
  assert.match(out.stdout, /already loaded, session `aaaaaaaa-/);
  const mcp = fake.state.calls.filter((c) => c.path === '/mcp');
  assert.ok(mcp.length > 0 && mcp.every((c) => c.ua === `omr-agent/${VERSION}`));
  await fake.close();
});

test("the bridge fills in the harness it was installed for, never over the model's own", async () => {
  const fake = await fakeServer();
  const box = sandbox(fake.origin);
  await loggedIn(fake, box);
  const input = new PassThrough();
  const done = run(['mcp', '--harness', 'codex'], {
    env: box.env,
    cwd: box.ws,
    stdin: input,
    stdout: capture(),
    stderr: capture(),
  });
  const call = (id, args) =>
    `${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'load_agent', arguments: args } })}\n`;
  input.write(call(1, { agent: AGENT_ID }));
  input.write(call(2, { agent: AGENT_ID, harness: 'cursor' }));
  input.end();
  await done;
  const sent = fake.state.rpcs
    .filter((m) => m.params?.name === 'load_agent')
    .map((m) => m.params.arguments.harness);
  assert.deepEqual(sent.sort(), ['codex', 'cursor']);
  await fake.close();
});

test('the Codex block approves exactly the agent loop, and no destructive tool', () => {
  const block = codexBlock('/bin');
  const approved = [
    ...block.matchAll(/^\[mcp_servers\.omr\.tools\.(\w+)\]\napproval_mode = "approve"$/gm),
  ].map((m) => m[1]);
  assert.deepEqual(approved, CODEX_APPROVED_TOOLS);
  assert.ok(
    !/agent_forget|update_agent_brief|delete|share|default_tools_approval_mode/.test(block),
  );
  assert.match(block, /"mcp", "--harness", "codex"\]/);
});

test('install refuses a second On My Radar connection, found by Codex itself', async () => {
  const servers = JSON.stringify([
    { name: 'onmyradar', transport: { type: 'streamable_http', url: `${DEFAULT_ORIGIN}/mcp` } },
    { name: 'elsewhere', transport: { type: 'streamable_http', url: 'https://example.com/mcp' } },
    {
      name: 'copy',
      transport: { type: 'stdio', command: 'node', args: ['/x/omr-agent.mjs', 'mcp'] },
    },
    {
      name: 'remote',
      transport: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', 'mcp-remote', `${DEFAULT_ORIGIN}/mcp`],
      },
    },
    {
      name: 'other-remote',
      transport: { type: 'stdio', command: 'npx', args: ['mcp-remote', 'https://example.com/mcp'] },
    },
  ]);
  const fakeCodex = async () => ({ code: 0, stdout: servers, stderr: '' });
  assert.deepEqual(await otherOmrServers('', { env: {}, run: fakeCodex }), [
    'onmyradar',
    'copy',
    'remote',
  ]);
  const t = installBox(`[mcp_servers.onmyradar]\nurl = "${DEFAULT_ORIGIN}/mcp"\n`);
  const stderr = capture();
  const code = await run0(['install', '--harness', 'codex', '--codex-home', t.codexHome, '--yes'], {
    env: t.box.env,
    cwd: t.box.home,
    stdout: capture(),
    stderr,
    stdin: { isTTY: false },
    validateToml: async () => true,
    listServers: async () => ['onmyradar'],
  });
  assert.equal(code, 1);
  assert.match(stderr.text(), /"onmyradar".*does not belong to this connection/s);
  assert.ok(!existsSync(join(t.box.cfg, 'bin')), 'nothing was installed');
});

const SELF = readFileSync(new URL('../agent-setup/omr-agent.mjs', import.meta.url));
const sums = (body) => `${createHash('sha256').update(body).digest('hex')}  omr-agent.mjs\n`;

test('update swaps the installed copy only when SHA256SUMS agrees; a tampered sum changes nothing', async () => {
  const newer = Buffer.from(SELF.toString().replace(`VERSION = '${VERSION}'`, "VERSION = '9.9.9'"));
  for (const tampered of [false, true]) {
    const fake = await fakeServer({
      setup: { 'omr-agent.mjs': newer, SHA256SUMS: tampered ? sums(SELF) : sums(newer) },
    });
    const box = sandbox(fake.origin);
    const target = join(box.cfg, 'bin', 'omr-agent.mjs');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, 'OLD');
    const stderr = capture();
    const code = await run0(['update', '--server', fake.origin], {
      env: box.env,
      cwd: box.home,
      stdout: capture(),
      stderr,
    });
    if (tampered) {
      assert.equal(code, 1);
      assert.match(stderr.text(), /does not match SHA256SUMS/);
      assert.equal(readFileSync(target, 'utf8'), 'OLD');
    } else {
      assert.equal(code, 0, stderr.text());
      assert.deepEqual(readFileSync(target), newer);
      assert.equal(statSync(target).mode & 0o777, 0o700);
      assert.match(stderr.text(), /9\.9\.9/);
    }
    assert.ok(
      fake.state.calls.every((c) => c.auth === null),
      'no credential goes with a download',
    );
    await fake.close();
  }
});

test('update never follows a redirect, for the sums or the file', async () => {
  const evil = await fakeServer({ setup: { 'omr-agent.mjs': 'evil', SHA256SUMS: sums('evil') } });
  for (const redirected of ['SHA256SUMS', 'omr-agent.mjs']) {
    const hop = createServer((req, res) => {
      const file = req.url.split('/').pop();
      if (file === redirected) res.writeHead(302, { location: `${evil.origin}${req.url}` }).end();
      else res.writeHead(200).end(file === 'SHA256SUMS' ? sums(SELF) : SELF);
    });
    await new Promise((ok) => hop.listen(0, '127.0.0.1', ok));
    const origin = `http://127.0.0.1:${hop.address().port}`;
    const box = sandbox(origin);
    const target = join(box.cfg, 'bin', 'omr-agent.mjs');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, 'OLD');
    const code = await run0(['update', '--server', origin], {
      env: { ...box.env, OMR_ALLOWED_SERVERS: `${origin},${evil.origin}` },
      cwd: box.home,
      stdout: capture(),
      stderr: capture(),
    });
    assert.equal(code, 1, `${redirected} redirected`);
    assert.equal(readFileSync(target, 'utf8'), 'OLD');
    assert.equal(evil.state.calls.filter((c) => c.path.startsWith('/agent-setup')).length, 0);
    hop.closeAllConnections();
    hop.close();
  }
  await evil.close();
});
