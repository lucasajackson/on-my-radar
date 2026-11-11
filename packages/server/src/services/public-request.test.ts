import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { must } from '../errors.js';

interface Route {
  status: number;
  headers: Record<string, string>;
  body?: string;
}

/** url -> canned response. */
const routes = new Map<string, Route>();
/** Every hop the module attempted, with the lookup hook it installed. */
const dialled: Array<{
  url: string;
  lookup: unknown;
  options: Record<string, unknown>;
  body: Buffer | undefined;
}> = [];
/** Every hostname handed to DNS, in order. */
const resolved: string[] = [];
/** hostname -> what DNS says, when it says anything. */
const dns = new Map<string, Array<{ address: string; family: number }>>();

vi.mock('node:dns/promises', () => ({
  lookup: async (hostname: string) => {
    resolved.push(hostname);
    const answer = dns.get(hostname);
    if (!answer) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
    return answer;
  },
}));

function fakeRequest(
  url: URL,
  options: Record<string, unknown>,
  callback: (res: Readable & { statusCode: number; headers: Record<string, string> }) => void,
) {
  const req = new EventEmitter() as EventEmitter & {
    end: (body?: Buffer) => void;
    destroy: () => void;
  };
  req.destroy = () => req.emit('close');
  req.end = (body) => {
    dialled.push({ url: url.toString(), lookup: options['lookup'], options, body });
    const route = routes.get(url.toString());
    queueMicrotask(() => {
      if (!route) {
        req.emit('error', new Error(`no route for ${url.toString()}`));
        req.emit('close');
        return;
      }
      const res = Readable.from(route.body ? [Buffer.from(route.body)] : []) as Readable & {
        statusCode: number;
        headers: Record<string, string>;
      };
      res.statusCode = route.status;
      res.headers = route.headers;
      res.on('close', () => req.emit('close'));
      callback(res);
    });
  };
  return req;
}

vi.mock('node:http', () => ({ request: fakeRequest }));
vi.mock('node:https', () => ({ request: fakeRequest }));

const { networkOf, publicRequest, UnsafeOutboundUrlError } = await import('./public-request.js');

/** The `lookup` hook the module installed, called the way `net` calls it. */
function askPinnedLookup(hook: unknown, hostname: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    (hook as (h: string, o: object, cb: (e: Error | null, a: unknown, f?: number) => void) => void)(
      hostname,
      { all: true },
      (err, address) => (err ? reject(err) : resolve(address)),
    );
  });
}

beforeEach(() => {
  routes.clear();
  dialled.length = 0;
  resolved.length = 0;
  dns.clear();
});

describe('networkOf, the rate-limit key for a caller', () => {
  it('keys IPv4 by address, IPv6 by /64, and garbage by nothing', () => {
    expect(networkOf('203.0.113.9')).toBe('203.0.113.9');
    expect(networkOf('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64');
    expect(networkOf('2001:0db8:0001:0002:ffff:ffff:ffff:ffff')).toBe('2001:db8:1:2::/64');
    expect(networkOf('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(networkOf('[2001:db8::1]')).toBe('2001:db8:0:0::/64');
    expect(networkOf('not-an-address')).toBeNull();
    expect(networkOf('')).toBeNull();
  });
});

describe('public outbound requests used by push', () => {
  it('refuses private endpoints before making any request', async () => {
    for (const endpoint of [
      'https://127.0.0.1/push',
      'https://10.0.0.1/push',
      'https://169.254.169.254/push',
      'https://192.168.1.1/push',
      'https://[::1]/push',
      'https://[::ffff:7f00:1]/push',
      'https://[64:ff9b::a00:1]/push',
      'https://[fd00::1]/push',
      'https://[fec0::1]/push',
      'https://[64:ff9b:1::a00:1]/push',
      // 6to4 carrying loopback and 10/8, and Teredo.
      'https://[2002:7f00:1::]/push',
      'https://[2002:a00:1::1]/push',
      'https://[2001:0:4136:e378::1]/push',
      // Benchmarking and documentation ranges: never a public host.
      'https://198.18.0.1/push',
      'https://192.0.2.10/push',
      'https://198.51.100.7/push',
      'https://203.0.113.9/push',
      'https://192.0.0.8/push',
      'https://localhost/push',
      'https://svc.cluster.local/push',
    ]) {
      await expect(publicRequest(new URL(endpoint), { httpsOnly: true })).rejects.toBeInstanceOf(
        UnsafeOutboundUrlError,
      );
    }
    expect(dialled).toEqual([]);
    expect(resolved).toEqual([]);
  });

  it('judges 6to4 by the IPv4 it carries, so a public one is not refused as private', async () => {
    const outcome = await publicRequest(new URL('https://[2002:5db8:d822::1]/push'), {
      httpsOnly: true,
    }).catch((err: unknown) => err);
    expect(outcome).not.toBeInstanceOf(UnsafeOutboundUrlError);
  });

  it('requires HTTPS for push, including legacy stored HTTP endpoints', async () => {
    await expect(
      publicRequest(new URL('http://public.example/push'), { httpsOnly: true }),
    ).rejects.toBeInstanceOf(UnsafeOutboundUrlError);
    expect(dialled).toEqual([]);
    expect(resolved).toEqual([]);
  });

  it('refuses a DNS answer if any candidate is private', async () => {
    dns.set('push.example', [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ]);
    await expect(
      publicRequest(new URL('https://push.example/push'), { httpsOnly: true }),
    ).rejects.toBeInstanceOf(UnsafeOutboundUrlError);
    expect(dialled).toEqual([]);
  });

  it('pins POST delivery to vetted DNS and preserves the real hostname and payload', async () => {
    const endpoint = 'https://push.example/push';
    dns.set('push.example', [{ address: '93.184.216.34', family: 4 }]);
    routes.set(endpoint, { status: 201, headers: {} });
    const body = Buffer.from('encrypted bytes');
    const response = await publicRequest(new URL(endpoint), {
      method: 'POST',
      httpsOnly: true,
      body,
      headers: { authorization: 'vapid test', 'content-type': 'application/octet-stream' },
    });
    expect(response.status).toBe(201);
    expect(dialled).toHaveLength(1);
    const request = must(dialled[0]);
    expect(request.url).toBe(endpoint);
    expect(request.options['agent']).toBe(false);
    expect(request.options['method']).toBe('POST');
    expect(request.body).toEqual(body);
    dns.set('push.example', [{ address: '127.0.0.1', family: 4 }]);
    expect(await askPinnedLookup(request.lookup, 'push.example')).toEqual([
      { address: '93.184.216.34', family: 4 },
    ]);
    expect(resolved).toEqual(['push.example']);
  });

  it('returns a redirect without following it or forwarding the push credential', async () => {
    const endpoint = 'https://push.example/push';
    dns.set('push.example', [{ address: '93.184.216.34', family: 4 }]);
    routes.set(endpoint, { status: 307, headers: { location: 'http://127.0.0.1/private' } });
    const response = await publicRequest(new URL(endpoint), {
      method: 'POST',
      httpsOnly: true,
      headers: { authorization: 'vapid test' },
      body: Buffer.from('encrypted'),
    });
    expect(response.status).toBe(307);
    expect(dialled.map((request) => request.url)).toEqual([endpoint]);
    expect(resolved).toEqual(['push.example']);
  });
});
