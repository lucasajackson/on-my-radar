/**
 * The unfurl SSRF guard.
 *
 * This is the only outbound request the server makes to a URL a user chose, so
 * the address checks are worth testing directly rather than only through the
 * fetch path.
 *
 * Three of the properties below are regression guards for defects found by
 * review, and each one had been "covered" by a test that passed for the wrong
 * reason:
 *
 * - **The connection is pinned to the address that was vetted.** The guard used
 *   to resolve a hostname, check every answer, throw the answers away and let
 *   `fetch` resolve again — so a nameserver answering with a TTL of 0 could pass
 *   the check and then be connected to at `127.0.0.1`. Asserted by invoking the
 *   `lookup` the request was actually given: it must answer with the vetted
 *   address without consulting DNS at all.
 * - **The scheme is re-checked at every hop.** It used to be checked once,
 *   before the loop, so a redirect to `file:` or `data:` was accepted by this
 *   code and refused only by the accident that `dns.lookup('')` returns nothing.
 * - **An IPv6 literal is judged as an IPv6 literal.** `URL.hostname` keeps the
 *   brackets, so `isIP('[::1]')` is 0 and the whole IPv6 branch was dead code:
 *   `http://[::1]/` was refused by a failing DNS lookup rather than by the
 *   guard. The test asserts DNS is never consulted, which is the difference.
 *
 * The transport is mocked and the logic is not: `resolvePublicHost`, the hop
 * loop, the redirect walk and the scraping all run for real. A local server
 * would prove less, because no locally-reachable address survives the private
 * check — which is the point of the check.
 */
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface Route {
  status: number;
  headers: Record<string, string>;
  body?: string;
}

/** url -> canned response. */
const routes = new Map<string, Route>();
/** Every hop the module attempted, with the lookup hook it installed. */
const dialled: Array<{ url: string; lookup: unknown }> = [];
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
  const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void };
  req.destroy = () => req.emit('close');
  req.end = () => {
    dialled.push({ url: url.toString(), lookup: options['lookup'] });
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

const { unfurl } = await import('./unfurl.js');

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

describe('unfurl', () => {
  it('refuses non-http schemes', async () => {
    expect(await unfurl('file:///etc/passwd')).toBeNull();
    expect(await unfurl('gopher://example.com')).toBeNull();
    expect(await unfurl('not a url')).toBeNull();
    // Refused by the scheme check, so nothing was resolved or dialled.
    expect(resolved).toEqual([]);
    expect(dialled).toEqual([]);
  });

  it('refuses loopback, link-local and private literals', async () => {
    // 169.254.169.254 is the cloud metadata endpoint — the canonical SSRF target.
    expect(await unfurl('http://169.254.169.254/latest/meta-data/')).toBeNull();
    expect(await unfurl('http://127.0.0.1:8080/')).toBeNull();
    expect(await unfurl('http://10.0.0.5/')).toBeNull();
    expect(await unfurl('http://192.168.1.1/')).toBeNull();
    expect(await unfurl('http://172.16.0.1/')).toBeNull();
    expect(await unfurl('http://100.64.0.1/')).toBeNull();
    expect(dialled).toEqual([]);
  });

  it('judges a bracketed IPv6 literal as a literal, never through DNS', async () => {
    for (const url of [
      'http://[::1]/',
      'http://[::]/',
      'http://[fd00::1]/',
      'http://[fe80::1]/',
      'http://[feb0::1]/',
      'http://[ff02::1]/',
      // `new URL()` normalises this to `[::ffff:7f00:1]` before the guard ever
      // sees it, which is how a check written against the dotted spelling let
      // loopback through. Both spellings, both refused.
      'http://[::ffff:127.0.0.1]/',
      'http://[::ffff:7f00:1]/',
      'http://[::ffff:a00:5]/',
      'http://[64:ff9b::169.254.169.254]/',
    ]) {
      expect(await unfurl(url)).toBeNull();
    }
    // The whole point: without unwrapping the brackets these fall through to
    // the DNS path and are refused by luck rather than by the guard.
    expect(resolved).toEqual([]);
    expect(dialled).toEqual([]);
  });

  it('refuses internal hostnames without needing DNS', async () => {
    expect(await unfurl('http://localhost/')).toBeNull();
    expect(await unfurl('http://db-server.corp.internal/')).toBeNull();
    expect(await unfurl('http://kubernetes.default.svc.cluster.local/')).toBeNull();
    expect(resolved).toEqual([]);
  });

  it('refuses a hostname that resolves to a private address', async () => {
    dns.set('rebind.example', [{ address: '127.0.0.1', family: 4 }]);
    expect(await unfurl('http://rebind.example/')).toBeNull();
    expect(resolved).toEqual(['rebind.example']);
    expect(dialled).toEqual([]);
  });

  it('refuses when only one of several answers is private', async () => {
    dns.set('mixed.example', [
      { address: '93.184.216.34', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ]);
    expect(await unfurl('http://mixed.example/')).toBeNull();
    expect(dialled).toEqual([]);
  });

  /* ------------------------------- the pin -------------------------------- */

  it('pins the connection to the address it vetted, and resolves exactly once', async () => {
    dns.set('news.example', [{ address: '93.184.216.34', family: 4 }]);
    routes.set('http://news.example/story', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: '<html><head><title>A story</title></head></html>',
    });

    const preview = await unfurl('http://news.example/story');
    expect(preview?.title).toBe('A story');

    // One resolution for one hop. The old code resolved here and let the HTTP
    // client resolve again, which is the whole of the vulnerability.
    expect(resolved).toEqual(['news.example']);
    expect(dialled).toHaveLength(1);

    // And the hook the socket was handed answers with the vetted address
    // without asking DNS anything — the count above is unchanged by calling it.
    const answer = await askPinnedLookup(dialled[0]?.lookup, 'news.example');
    expect(answer).toEqual([{ address: '93.184.216.34', family: 4 }]);
    expect(resolved).toEqual(['news.example']);
  });

  /* ------------------------------- redirects ------------------------------ */

  it('re-vets every redirect hop against DNS', async () => {
    dns.set('start.example', [{ address: '93.184.216.34', family: 4 }]);
    dns.set('second.example', [{ address: '93.184.216.35', family: 4 }]);
    routes.set('http://start.example/', {
      status: 302,
      headers: { location: 'http://second.example/final' },
    });
    routes.set('http://second.example/final', {
      status: 200,
      headers: { 'content-type': 'text/html' },
      body: '<html><head><title>Arrived</title></head></html>',
    });

    expect((await unfurl('http://start.example/'))?.title).toBe('Arrived');
    expect(resolved).toEqual(['start.example', 'second.example']);
  });

  it('refuses a redirect into a private address', async () => {
    dns.set('start.example', [{ address: '93.184.216.34', family: 4 }]);
    routes.set('http://start.example/', {
      status: 302,
      headers: { location: 'http://169.254.169.254/latest/meta-data/' },
    });

    expect(await unfurl('http://start.example/')).toBeNull();
    // The metadata endpoint was never dialled: one hop attempted, not two.
    expect(dialled).toHaveLength(1);
  });

  it('refuses a redirect that changes scheme to file: or data:', async () => {
    dns.set('start.example', [{ address: '93.184.216.34', family: 4 }]);
    for (const location of ['file:///etc/passwd', 'data:text/html,<title>pwn</title>']) {
      dialled.length = 0;
      resolved.length = 0;
      routes.set('http://start.example/', { status: 302, headers: { location } });
      expect(await unfurl('http://start.example/')).toBeNull();
      expect(dialled).toHaveLength(1);
      // Refused *by the scheme check*, before anything is resolved. Without the
      // check the hop is still refused — but only because these URLs have an
      // empty hostname and `dns.lookup('')` finds nothing, which is luck rather
      // than a guard, and a scheme with a host (`gopher://…`) would not have it.
      expect(resolved).toEqual(['start.example']);
    }
  });

  it('refuses a redirect to a scheme that does have a host', async () => {
    dns.set('start.example', [{ address: '93.184.216.34', family: 4 }]);
    dns.set('files.example', [{ address: '93.184.216.34', family: 4 }]);
    routes.set('http://start.example/', {
      status: 302,
      headers: { location: 'gopher://files.example/1/' },
    });
    expect(await unfurl('http://start.example/')).toBeNull();
    // Nothing about `gopher://files.example/` would fail a DNS check, so this
    // hop is refused by the scheme rule or not at all.
    expect(resolved).toEqual(['start.example']);
    expect(dialled).toHaveLength(1);
  });

  it('gives up rather than following a redirect loop forever', async () => {
    dns.set('loop.example', [{ address: '93.184.216.34', family: 4 }]);
    routes.set('http://loop.example/', {
      status: 302,
      headers: { location: 'http://loop.example/' },
    });
    expect(await unfurl('http://loop.example/')).toBeNull();
    expect(dialled.length).toBeLessThanOrEqual(4);
  });

  /* ------------------------------- scraping ------------------------------- */

  it('prefers open-graph tags and refuses a hostile og:image scheme', async () => {
    dns.set('shop.example', [{ address: '93.184.216.34', family: 4 }]);
    routes.set('http://shop.example/item', {
      status: 200,
      headers: { 'content-type': 'text/html' },
      body:
        '<html><head><title>fallback</title>' +
        '<meta property="og:title" content="A thing &amp; another">' +
        '<meta property="og:image" content="javascript:alert(1)">' +
        '</head></html>',
    });

    const preview = await unfurl('http://shop.example/item');
    expect(preview?.title).toBe('A thing & another');
    // An og:image lands in an <img src>, so only http(s) survives.
    expect(preview?.imageUrl).toBeNull();
  });

  it('reports a non-HTML document as a bare site name rather than scraping it', async () => {
    dns.set('files.example', [{ address: '93.184.216.34', family: 4 }]);
    routes.set('http://files.example/report.pdf', {
      status: 200,
      headers: { 'content-type': 'application/pdf' },
      body: '%PDF-1.7 never read',
    });

    const preview = await unfurl('http://files.example/report.pdf');
    expect(preview?.siteName).toBe('files.example');
    expect(preview?.title).toBeNull();
  });
});
