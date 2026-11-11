/**
 * Link previews.
 *
 * This shares its public-address transport with Web Push. Fetching a URL a user
 * chose carries an SSRF risk: without a guard, pasting
 * `http://169.254.169.254/…` or an internal hostname would turn the pod into a
 * proxy for the cluster network. Every candidate address is resolved and checked
 * against private ranges *before* the connection, redirects are followed
 * manually so each hop is re-checked, and the response is size- and time-capped.
 *
 * ## Why this does not use `fetch`
 *
 * It used to, and that was the hole. `assertPublicHost` resolved the hostname,
 * checked every address, then **threw the addresses away**; `fetch(url)` made
 * undici resolve the same name a second time and connect to whatever came back.
 * Two lookups, two answers — the classic check-then-connect race. A URL on a
 * nameserver the attacker controls, answering with a TTL of 0, passes the check
 * on the first answer and connects on the second: `127.0.0.1`, `10.x`, a
 * ClusterIP, `169.254.169.254`, on any port. And it is not blind — the `<title>`
 * and the `og:*` tags are stored on the blip and rendered straight back.
 *
 * The fix is to resolve **once** and connect to exactly what was vetted, which
 * means owning the DNS step. `node:http`/`node:https` take a `lookup` hook;
 * global `fetch` has no equivalent without adding undici as a dependency. The
 * hook here ignores its hostname argument and hands back the vetted list, so
 * there is no second resolution for anything to change underneath — while the
 * request still carries the real hostname in `Host` and in the TLS SNI, so
 * certificate validation is unaffected.
 *
 * The vetting is per hop, because a redirect can point anywhere.
 */
import type { LinkPreviewDto } from '@onmyradar/contract';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { publicRequest } from './public-request.js';

const MAX_REDIRECTS = 3;

/** The only two schemes that are ever fetched, checked again at every hop. */
function isFetchableScheme(url: URL): boolean {
  return url.protocol === 'http:' || url.protocol === 'https:';
}

function bareHost(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '');
}

function decodeEntities(value: string): string {
  return value
    .replace(/&(#\d+|#x[0-9a-f]+|amp|lt|gt|quot|apos|#39);/gi, (match, entity: string) => {
      const lower = entity.toLowerCase();
      if (lower === 'amp') return '&';
      if (lower === 'lt') return '<';
      if (lower === 'gt') return '>';
      if (lower === 'quot') return '"';
      if (lower === 'apos' || lower === '#39') return "'";
      if (lower.startsWith('#x')) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
      if (lower.startsWith('#')) return String.fromCodePoint(Number.parseInt(lower.slice(1), 10));
      return match;
    })
    .trim();
}

/** Meta-tag scraping without an HTML parser dependency; good enough for OG tags. */
function readMeta(html: string, names: string[]): string | null {
  for (const name of names) {
    const pattern = new RegExp(
      `<meta[^>]+(?:property|name)\\s*=\\s*["']${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>`,
      'i',
    );
    const tag = pattern.exec(html)?.[0];
    if (!tag) continue;
    const content = /content\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    if (content?.trim()) return decodeEntities(content).slice(0, 500);
  }
  return null;
}

function readTitle(html: string): string | null {
  const match = /<title[^>]*>([\s\S]{0,500}?)<\/title>/i.exec(html);
  return match?.[1] ? decodeEntities(match[1].replace(/\s+/g, ' ')).slice(0, 300) : null;
}

/**
 * A preview image is put in an `<img src>`, so it may not be an arbitrary
 * scheme. Only checked here because `og:image` is attacker-controlled text on a
 * page we already decided to read.
 */
function safeImageUrl(candidate: string, base: URL): string | null {
  try {
    const resolved = new URL(candidate, base);
    return isFetchableScheme(resolved) ? resolved.toString().slice(0, 2048) : null;
  } catch {
    return null;
  }
}

/** Returns null rather than throwing: a preview is a nicety, never a failure. */
export async function unfurl(rawUrl: string): Promise<LinkPreviewDto | null> {
  let current: URL;
  try {
    current = new URL(rawUrl);
  } catch {
    return null;
  }

  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      // Inside the loop, not before it. The scheme check used to sit outside,
      // so a redirect to `file:` or `data:` was accepted by this code and
      // refused only by the accident that `dns.lookup('')` returns nothing.
      if (!isFetchableScheme(current)) return null;

      const res = await publicRequest(current, {
        headers: {
          'user-agent': `OnMyRadarBot/1.0 (+${env().APP_URL})`,
          accept: 'text/html,application/xhtml+xml',
        },
        wantsBody: (status, headers) =>
          status >= 200 && status < 300 && (headers['content-type'] ?? '').includes('html'),
      });

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.location;
        if (!location) return null;
        current = new URL(location, current);
        continue;
      }
      if (res.status < 200 || res.status >= 300) return null;
      if (!(res.headers['content-type'] ?? '').includes('html')) {
        return {
          title: null,
          description: null,
          siteName: bareHost(current.hostname).replace(/^www\./, ''),
          imageUrl: null,
          fetchedAt: new Date().toISOString(),
        };
      }

      const html = res.body;
      const image = readMeta(html, ['og:image', 'twitter:image', 'twitter:image:src']);

      return {
        title: readMeta(html, ['og:title', 'twitter:title']) ?? readTitle(html),
        description: readMeta(html, ['og:description', 'twitter:description', 'description']),
        siteName:
          readMeta(html, ['og:site_name']) ?? bareHost(current.hostname).replace(/^www\./, ''),
        imageUrl: image ? safeImageUrl(image, current) : null,
        fetchedAt: new Date().toISOString(),
      };
    }
    return null;
  } catch (err) {
    logger.debug({ err, url: rawUrl }, 'unfurl failed');
    return null;
  }
}
