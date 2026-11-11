/* global __ENV, __VU, __ITER, open */
/**
 * k6 scenarios for the scale test.
 *
 *   agents  150 VUs, one personal access token each, looping over the MCP tools
 *           an agent actually uses: list_radars, read_radar x3 pages, search_blips,
 *           create_blip (30% to one hot radar), update_blip, create_comment.
 *   ui       50 VUs, one browser session each, polling the notification counts.
 *   ready     1 request per second to /health/ready; it must never leave 200.
 *
 * A 429 from the rate limiter is counted on its own (`rate_limited`) and is not
 * an error. Every other failure (HTTP, JSON-RPC, tool isError) is.
 *
 * Environment (all via `k6 run -e`): BASE_URL, FIXTURES (absolute path),
 * DURATION (default 5m), THINK_MS (mean pause between calls, default 1500),
 * AGENT_VUS (150), UI_VUS (50), IDEMPOTENCY (1 = send an idempotencyKey on
 * create_blip / create_comment and replay 5% of them), UI_POLL_S (5).
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://127.0.0.1:3500';
const DURATION = __ENV.DURATION || '5m';
const THINK_MS = Number(__ENV.THINK_MS || 1500);
const AGENT_VUS = Number(__ENV.AGENT_VUS || 150);
const UI_VUS = Number(__ENV.UI_VUS || 50);
const UI_POLL_S = Number(__ENV.UI_POLL_S || 5);
const IDEMPOTENCY = __ENV.IDEMPOTENCY === '1';

const fixtures = JSON.parse(open(__ENV.FIXTURES));

const tools = [
  'list_radars',
  'read_radar',
  'search_blips',
  'create_blip',
  'update_blip',
  'create_comment',
];
const trends = {};
for (const t of tools) trends[t] = new Trend(`mcp_${t}`, true);
const uiCounts = new Trend('ui_notification_counts', true);
const errors = new Rate('errors');
const rateLimited = new Counter('rate_limited');
const readyOk = new Rate('ready_ok');
const duplicatesReplayed = new Counter('idempotent_replays_sent');

export const options = {
  scenarios: {
    agents: {
      executor: 'constant-vus',
      vus: AGENT_VUS,
      duration: DURATION,
      exec: 'agent',
    },
    ui: {
      executor: 'constant-vus',
      vus: UI_VUS,
      duration: DURATION,
      exec: 'ui',
    },
    ready: {
      executor: 'constant-arrival-rate',
      rate: 1,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: 2,
      exec: 'ready',
    },
  },
  thresholds: {
    mcp_read_radar: ['p(95)<400'],
    mcp_search_blips: ['p(95)<500'],
    mcp_list_radars: ['p(95)<300'],
    mcp_create_blip: ['p(95)<300'],
    errors: ['rate<0.005'],
    ready_ok: ['rate==1'],
  },
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function think() {
  sleep((THINK_MS * (0.5 + Math.random())) / 1000);
}

let rpcId = 0;
function nonce() {
  return `${__VU}-${__ITER}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

/** The first JSON-RPC message in an application/json or text/event-stream body. */
function parseRpc(res) {
  const body = res.body || '';
  const type = String(res.headers['Content-Type'] || '');
  try {
    if (type.includes('text/event-stream')) {
      for (const line of body.split('\n')) {
        if (line.startsWith('data:')) return JSON.parse(line.slice(5).trim());
      }
      return null;
    }
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/** One tools/call. Returns the tool's parsed JSON payload, or null when it failed or was limited. */
function call(token, name, args) {
  const res = http.post(
    `${BASE}/mcp`,
    JSON.stringify({
      jsonrpc: '2.0',
      id: ++rpcId,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      tags: { tool: name },
      responseCallback: http.expectedStatuses(200, 429),
    },
  );
  if (res.status === 429) {
    rateLimited.add(1, { tool: name });
    return null;
  }
  trends[name].add(res.timings.duration);
  const rpc = res.status === 200 ? parseRpc(res) : null;
  const ok = res.status === 200 && rpc !== null && !rpc.error && rpc.result && !rpc.result.isError;
  errors.add(!ok, { tool: name });
  if (!ok) {
    check(res, { [`${name} ok`]: () => false });
    return null;
  }
  const text = rpc.result.content && rpc.result.content[0] && rpc.result.content[0].text;
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

export function agent() {
  const token = fixtures.tokens[(__VU - 1) % fixtures.tokens.length];

  call(token, 'list_radars', {});
  think();

  const radar = pick(fixtures.radars);
  let cursor;
  for (let page = 0; page < 3; page++) {
    const page1 = call(token, 'read_radar', {
      radarId: radar.id,
      limit: 50,
      ...(cursor ? { cursor } : {}),
    });
    cursor = page1 && page1.nextCursor;
    think();
    if (!cursor) break;
  }

  call(token, 'search_blips', {
    query: `w${Math.floor(Math.random() * 400)} w${Math.floor(Math.random() * 400)}`,
    limit: 25,
  });
  think();

  const target =
    Math.random() < 0.3
      ? fixtures.radars.find((r) => r.id === fixtures.hotRadarId)
      : pick(fixtures.radars);
  const key = nonce();
  const createArgs = {
    radarId: target.id,
    body: `load test capture nonce:${key} w${Math.floor(Math.random() * 400)} w${Math.floor(Math.random() * 400)}`,
    ...(IDEMPOTENCY ? { idempotencyKey: key } : {}),
  };
  call(token, 'create_blip', createArgs);
  if (IDEMPOTENCY && Math.random() < 0.05) {
    // A client retry after a lost response: must replay, never write a second blip.
    duplicatesReplayed.add(1);
    call(token, 'create_blip', createArgs);
  }
  think();

  const edited = pick(pick(fixtures.radars).blips);
  call(token, 'update_blip', { blipId: edited, tags: ['lt', `u${Math.floor(Math.random() * 7)}`] });
  think();

  const commented = pick(pick(fixtures.radars).blips);
  const ckey = nonce();
  call(token, 'create_comment', {
    blipId: commented,
    body: `load test comment nonce:${ckey}`,
    ...(IDEMPOTENCY ? { idempotencyKey: ckey } : {}),
  });
  think();
}

export function ui() {
  const session = fixtures.sessions[(__VU - 1) % fixtures.sessions.length];
  const res = http.get(`${BASE}/api/notifications/counts`, {
    headers: { Cookie: `omr_session=${session}` },
    tags: { endpoint: 'notification_counts' },
    responseCallback: http.expectedStatuses(200, 429),
  });
  if (res.status === 429) rateLimited.add(1, { tool: 'ui_counts' });
  else {
    uiCounts.add(res.timings.duration);
    errors.add(res.status !== 200, { tool: 'ui_counts' });
  }
  sleep(UI_POLL_S * (0.8 + Math.random() * 0.4));
}

export function ready() {
  const res = http.get(`${BASE}/health/ready`, { tags: { endpoint: 'ready' } });
  readyOk.add(res.status === 200);
}
