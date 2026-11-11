/**
 * Is this hostname one a person reaches from their own machine or home network?
 *
 * Single-user mode signs in whoever can reach the server, so it is only allowed
 * where that means "somebody on my own network". Loopback, private and
 * link-local address literals qualify, and so do the names a home network
 * resolves for itself. A name like `notes.example.com` never does: nothing about
 * it says who can reach it.
 */
import { isIP } from 'node:net';

const LOCAL_SUFFIXES = ['.localhost', '.local', '.lan', '.home.arpa', '.internal'];

function localIpv4(host: string): boolean {
  const [a = 0, b = 0] = host.split('.').map(Number);
  return (
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254)
  );
}

/** `hostname` as `URL.hostname` gives it: lower case, IPv6 in brackets. */
export function isLocalHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const family = isIP(host);
  if (family === 4) return localIpv4(host);
  if (family === 6) return host === '::1' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host);
  return host === 'localhost' || LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix));
}
