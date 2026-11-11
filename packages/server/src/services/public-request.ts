/**
 * Public outbound HTTP transport shared by link previews and Web Push.
 * Resolve once, reject every private candidate, and connect only to the vetted
 * addresses. Host and TLS SNI retain the original hostname. Redirects are never
 * followed here: callers must vet each new hop (unfurl) or refuse it (push).
 */
import { lookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';

/** A permanent policy refusal, distinct from a transient DNS/socket outage. */
export class UnsafeOutboundUrlError extends Error {}

export interface PublicRequestOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: Buffer;
  httpsOnly?: boolean;
  timeoutMs?: number;
  maxBytes?: number;
  wantsBody?: (status: number, headers: IncomingHttpHeaders) => boolean;
}

function assertSupportedUrl(url: URL, httpsOnly: boolean | undefined): void {
  if (
    (url.protocol !== 'https:' && (httpsOnly || url.protocol !== 'http:')) ||
    url.username ||
    url.password
  )
    throw new UnsafeOutboundUrlError('unsupported outbound URL');
}

/**
 * The same policy `publicRequest` applies, without connecting — for the moment
 * a URL is *saved* (an outbound subscription, a feed), so a person who pastes
 * an internal address is told so then, not by a delivery failure days later.
 *
 * Throws only `UnsafeOutboundUrlError`, a policy refusal. A host that does not
 * resolve right now is let through: DNS may simply not exist yet, and the
 * delivery path re-checks every time anyway — this is an early answer, never
 * the guard.
 */
export async function vetPublicUrl(
  url: URL,
  options: { httpsOnly?: boolean; timeoutMs?: number } = {},
): Promise<void> {
  assertSupportedUrl(url, options.httpsOnly);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      resolvePublicHost(url.hostname),
      new Promise<never>((_, reject) => {
        deadline = setTimeout(
          () => reject(new Error('outbound DNS timed out')),
          options.timeoutMs ?? 3_000,
        );
      }),
    ]);
  } catch (err) {
    if (err instanceof UnsafeOutboundUrlError) throw err;
  } finally {
    clearTimeout(deadline);
  }
}

/** `vetPublicUrl`'s refusal as a sentence for the person who typed the URL. */
export function unsafeUrlMessage(url: URL, err: UnsafeOutboundUrlError): string {
  return err.message === 'unsupported outbound URL'
    ? 'Use an https:// URL without a username or password in it.'
    : `${url.hostname} is a private or internal address (${err.message}), so nothing will ever ` +
        'be delivered there. Use a URL that is reachable from the public internet.';
}

/** Each call performs a fresh policy check; DNS is part of the same deadline. */
export async function publicRequest(url: URL, options: PublicRequestOptions = {}): Promise<Hop> {
  assertSupportedUrl(url, options.httpsOnly);
  const timeoutMs = options.timeoutMs ?? 6_000;
  const started = Date.now();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const addresses = await Promise.race([
      resolvePublicHost(url.hostname),
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error('outbound DNS timed out')), timeoutMs);
      }),
    ]);
    clearTimeout(deadline);
    return await requestOnce(url, addresses, {
      ...options,
      timeoutMs: Math.max(1, timeoutMs - (Date.now() - started)),
    });
  } finally {
    clearTimeout(deadline);
  }
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  const [a = 0, b = 0] = parts;
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking, 198.18.0.0/15
  // IETF protocol assignments and the three documentation ranges: never a
  // public host, so never a reason to dial.
  const c = parts[2] ?? 0;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // 192.0.0.0/24, 192.0.2.0/24
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24
  if (a >= 224) return true; // multicast + reserved
  return false;
}

/**
 * `URL.hostname` keeps the brackets on an IPv6 literal — `http://[::1]/` gives
 * `[::1]`, which `isIP` scores 0 — so every literal has to be unwrapped before
 * it is judged. Skipping this made the whole IPv6 branch below dead code:
 * `http://[::1]/` fell through to the DNS path and was refused only because
 * `lookup('[::1]')` fails, which is luck rather than a guard.
 */
function bareHost(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '');
}

/**
 * An IPv6 address as its sixteen bytes, or null when it will not parse.
 *
 * Written out because every textual form of the same address has to reach the
 * same verdict, and string prefixes cannot do that. `http://[::ffff:127.0.0.1]/`
 * is normalised by `new URL()` to `[::ffff:7f00:1]` before this code ever sees
 * it, so a check written against the dotted-quad spelling missed loopback
 * entirely and the address was dialled. Bytes have one spelling.
 */
function ipv6Bytes(ip: string): Uint8Array | null {
  // A zone index (`fe80::1%eth0`) is about the interface, not the address.
  let text = ip.toLowerCase().split('%')[0] ?? '';

  // A trailing dotted quad is folded into the two hex groups it stands for, so
  // the expansion below only ever deals with one notation.
  const dotted = /^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(text);
  if (dotted?.[1] !== undefined && dotted[2] !== undefined) {
    const quad = dotted[2].split('.').map(Number);
    if (quad.length !== 4 || quad.some((n) => !Number.isInteger(n) || n < 0 || n > 255))
      return null;
    const [a = 0, b = 0, c = 0, d = 0] = quad;
    text = `${dotted[1]}${(((a << 8) | b) >>> 0).toString(16)}:${(((c << 8) | d) >>> 0).toString(16)}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const groups =
    halves.length === 2
      ? [...head, ...Array<string>(8 - head.length - tail.length).fill('0'), ...tail]
      : head;
  if (groups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i += 1) {
    const group = groups[i] ?? '';
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    const value = Number.parseInt(group, 16);
    bytes[i * 2] = (value >> 8) & 0xff;
    bytes[i * 2 + 1] = value & 0xff;
  }
  return bytes;
}

const dotted4 = (b: Uint8Array, at: number) => Array.from(b.subarray(at, at + 4)).join('.');

/**
 * The network a caller's address stands for, as a rate-limit key: an IPv4
 * address as itself, an IPv6 address as its /64 — one subscriber's
 * allocation, every address of which a single host can use — and an
 * IPv4-mapped IPv6 address as the IPv4 it carries. Null for anything that is
 * not an address, so a garbage header keys nothing rather than one shared
 * bucket everybody lands in.
 */
export function networkOf(ip: string): string | null {
  const host = bareHost(ip.trim());
  const family = isIP(host);
  if (family === 4) return host;
  if (family !== 6) return null;
  const b = ipv6Bytes(host);
  if (!b) return null;
  if (b.slice(0, 10).every((byte) => byte === 0) && b[10] === 0xff && b[11] === 0xff) {
    return dotted4(b, 12);
  }
  const groups: string[] = [];
  for (let i = 0; i < 8; i += 2) groups.push((((b[i] ?? 0) << 8) | (b[i + 1] ?? 0)).toString(16));
  return `${groups.join(':')}::/64`;
}

/**
 * Fail-closed: an address this cannot parse is treated as private, because the
 * alternative is dialling something nobody in this file understood.
 */
function isPrivateIpv6(ip: string): boolean {
  const b = ipv6Bytes(bareHost(ip));
  if (!b) return true;

  const topZero = b.slice(0, 10).every((byte) => byte === 0);
  // IPv4-mapped, ::ffff:0:0/96 — judged entirely by the IPv4 it carries.
  if (topZero && b[10] === 0xff && b[11] === 0xff) return isPrivateIpv4(dotted4(b, 12));
  // ::/96 covers ::1 (loopback), :: (unspecified) and the deprecated
  // IPv4-compatible form. None of it is public space; refuse the lot.
  if (topZero && b[10] === 0 && b[11] === 0) return true;
  // NAT64 well-known prefix 64:ff9b::/96 is a real route to a real IPv4 host,
  // so it is judged by that host rather than blocked outright.
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) {
    const middleZero = b.slice(4, 12).every((byte) => byte === 0);
    if (middleZero) return isPrivateIpv4(dotted4(b, 12));
    // RFC 8215's local-use translation prefix may route to private IPv4 space.
    if (b[4] === 0 && b[5] === 1) return true; // 64:ff9b:1::/48
  }

  // 6to4, 2002::/16, carries an IPv4 in its next four bytes and a relay will
  // deliver to it — `2002:7f00:1::` is loopback by another name. Judged by
  // that IPv4, like NAT64.
  if (b[0] === 0x20 && b[1] === 0x02) return isPrivateIpv4(dotted4(b, 2));
  // Teredo, 2001::/32, tunnels to an obfuscated IPv4 through a relay. Nothing
  // this server fetches lives behind one; refused rather than decoded.
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0 && b[3] === 0) return true;

  const first = b[0] ?? 0;
  const second = b[1] ?? 0;
  if ((first & 0xfe) === 0xfc) return true; // fc00::/7 unique-local
  if (first === 0xfe && (second & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (first === 0xfe && (second & 0xc0) === 0xc0) return true; // fec0::/10 site-local
  if (first === 0xff) return true; // ff00::/8 multicast
  return false;
}

/** One address the connection is allowed to use, in the shape `net` wants back. */
interface VettedAddress {
  address: string;
  family: number;
}

/**
 * Resolve a hostname and return **the addresses that were checked**, so the
 * connection can be pinned to exactly those.
 *
 * Returning them rather than a bare pass/fail is the whole point: the previous
 * version validated a set of addresses and then discarded it, which left the
 * actual connection free to be made to a different one.
 */
async function resolvePublicHost(hostname: string): Promise<VettedAddress[]> {
  const host = bareHost(hostname);
  const literal = isIP(host);
  if (literal === 4) {
    if (isPrivateIpv4(host)) throw new UnsafeOutboundUrlError('private address');
    return [{ address: host, family: 4 }];
  }
  if (literal === 6) {
    if (isPrivateIpv6(host)) throw new UnsafeOutboundUrlError('private address');
    return [{ address: host, family: 6 }];
  }

  if (/^(localhost|.*\.local|.*\.internal|.*\.cluster\.local)$/i.test(host)) {
    throw new UnsafeOutboundUrlError('internal hostname');
  }

  const addresses = await lookup(host, { all: true });
  if (addresses.length === 0) throw new Error('unresolvable host');
  for (const { address, family } of addresses) {
    const blocked = family === 4 ? isPrivateIpv4(address) : isPrivateIpv6(address);
    if (blocked) throw new UnsafeOutboundUrlError('resolves to a private address');
  }
  return addresses.map(({ address, family }) => ({ address, family }));
}

/**
 * A `lookup` that answers with the vetted list and never consults DNS.
 *
 * The hostname argument is deliberately ignored: this is only ever installed on
 * a request whose host is the one that was just vetted, and honouring a second
 * resolution is precisely the behaviour being removed.
 */
function pinnedLookup(addresses: VettedAddress[]): LookupFunction {
  return (_hostname, options, callback) => {
    const opts = (typeof options === 'function' ? {} : options) as { all?: boolean };
    const done = typeof options === 'function' ? options : callback;
    const first = addresses[0];
    if (!first) {
      done(Object.assign(new Error('no vetted address'), { code: 'ENOTFOUND' }), '');
      return;
    }
    if (opts.all) done(null, addresses);
    else done(null, first.address, first.family);
  };
}

/** What one hop answered, with the body read only when it is worth reading. */
interface Hop {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

/**
 * One request, over `node:http`/`node:https` so the connection can be pinned.
 *
 * Redirects are never followed here — `unfurl` walks them itself so each hop is
 * re-vetted. `wantsBody` decides whether the response is read at all, so a
 * redirect or a non-HTML document costs no transfer: the socket is destroyed as
 * soon as the headers say there is nothing to scrape.
 */
function requestOnce(
  url: URL,
  addresses: VettedAddress[],
  options: PublicRequestOptions,
): Promise<Hop> {
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise<Hop>((resolve, reject) => {
    const req = send(
      url,
      {
        method: options.method ?? 'GET',
        headers: options.headers,
        // Never reuse an earlier socket whose address was vetted by another request.
        agent: false,
        lookup: pinnedLookup(addresses),
        // Belt and braces: the pinned lookup already makes this the only family
        // that can be dialled, and a mismatch would otherwise be a silent hang.
        ...(addresses[0]?.family === 6 ? { family: 6 } : {}),
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (!options.wantsBody?.(status, res.headers)) {
          res.destroy();
          resolve({ status, headers: res.headers, body: '' });
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (chunk: Buffer) => {
          const remaining = (options.maxBytes ?? 512 * 1024) - total;
          const kept = chunk.subarray(0, remaining);
          chunks.push(kept);
          total += kept.byteLength;
          // Read at most MAX_BYTES, so a hostile server cannot stream us out of
          // memory. Destroying mid-body is a complete answer, not an error.
          if (total >= (options.maxBytes ?? 512 * 1024)) res.destroy();
        });
        const finish = () =>
          resolve({
            status,
            headers: res.headers,
            body: new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks)),
          });
        res.on('end', finish);
        res.on('close', finish);
        res.on('error', finish);
      },
    );
    // One deadline for the whole hop, so a server that trickles bytes forever
    // cannot hold the request open by staying technically active.
    const deadline = setTimeout(
      () => req.destroy(new Error('outbound request timed out')),
      options.timeoutMs ?? 6_000,
    );
    req.on('error', reject);
    req.on('close', () => clearTimeout(deadline));
    req.end(options.body);
  });
}
