/**
 * Plain-HTTP requests are sent to HTTPS.
 *
 * Cloudflare terminates TLS and cloudflared reaches Traefik over https, so this process never sees
 * the visitor's scheme itself. Cloudflare says it in `CF-Visitor: {"scheme":"http"}`; that header
 * is the only thing consulted (the UI's nginx does the same, see packages/ui/deploy/nginx.conf).
 * A request without it, which is every probe from inside the cluster, is never redirected, and
 * `/health` is exempt whatever it carries.
 */
import type { MiddlewareHandler } from 'hono';

const PLAIN = /"scheme"\s*:\s*"http"/i;
// A Host header is attacker-supplied text echoed into a Location: only a hostname[:port] passes.
const HOST = /^[a-z0-9.-]+(:\d{1,5})?$/i;

export function redirectToHttps(): MiddlewareHandler {
  return async (c, next) => {
    const host = c.req.header('host');
    if (
      PLAIN.test(c.req.header('cf-visitor') ?? '') &&
      !/^\/health(\/|$)/.test(c.req.path) &&
      host !== undefined &&
      HOST.test(host)
    ) {
      const url = new URL(c.req.url);
      return c.redirect(`https://${host}${url.pathname}${url.search}`, 301);
    }
    return next();
  };
}
