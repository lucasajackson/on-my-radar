import { subscriptionRoutes } from './routes/subscriptions.js';
/** Assembles the HTTP application: middleware, API routes, MCP, and the SPA. */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { API_V1 } from '@onmyradar/contract';
import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { secureHeaders } from 'hono/secure-headers';
import { eq } from 'drizzle-orm';
import { boundRequestBody } from './body-limit.js';
import { rateLimitBearer } from './rate-limit.js';
import { observeHttp } from './metrics.js';
import { routePath } from 'hono/route';
import { withRequestGate } from './db/request-gate.js';
import { attachActor, HELPDESK_PREFIX } from './auth/middleware.js';
import { singleUserHostFence } from './auth/single-user.js';
import { crossOriginAccess } from './cors.js';
import { refuseCrossSiteWrites } from './csrf.js';
import { getDb, schema } from './db/client.js';
import { env } from './env.js';
import { ApiError, errorBody, type AppEnv, type Ctx } from './http.js';
import { logger } from './logger.js';
import { adminRoutes } from './routes/admin.js';
import { attachmentRoutes, blipRoutes, commentRoutes, webhookRoutes } from './routes/blips.js';
import { searchRoutes } from './routes/search.js';
import { authRoutes } from './routes/auth.js';
import { dashboardRoutes } from './routes/dashboards.js';
import { rssRouter } from './routes/rss.js';
import { emailCaptureRoutes, emailIngestRoutes } from './routes/inbound-email.js';
import { healthRoutes } from './routes/health.js';
import { redirectToHttps } from './https-redirect.js';
import { helpdeskRoutes } from './routes/helpdesk.js';
import { anchorRoutes } from './routes/anchors.js';
import { accountExportRoutes } from './routes/account-export.js';
import { supportRoutes } from './routes/support.js';
import { guestSupportRoutes } from './routes/guest-support.js';
import { hookRoutes } from './routes/hooks.js';
import { integrationRoutes } from './routes/integrations.js';
import { inviteRoutes } from './routes/invites.js';
import { mcpRoutes } from './routes/mcp.js';
import { modelRoutes, repoAgentRoutes } from './routes/repo-agents.js';
import { notificationRoutes } from './routes/notifications.js';
import { oauthRoutes, wellKnownRoutes } from './routes/oauth.js';
import { publicRoutes } from './routes/public.js';
import { radarRoutes } from './routes/radars.js';
import { tokenRoutes } from './routes/tokens.js';
import { topicRoutes } from './routes/topics.js';
import { waitlistRoutes } from './routes/waitlist.js';

/**
 * The JSON-RPC 2.0 form of a refusal raised before the MCP handler ran (rate limit, body
 * size, auth). `id` is null: the request was refused before it was parsed, which is what the
 * spec prescribes when the id cannot be determined.
 */
export function jsonRpcError(status: number, apiCode: string, message: string) {
  const code =
    status === 429
      ? -32029
      : status === 413
        ? -32600
        : status === 401
          ? -32001
          : status === 403
            ? -32003
            : status >= 500
              ? -32603
              : -32000;
  // `data` keeps this API's own error code (`rate_limited`, `forbidden`, ...) for a
  // client that wants to branch on it, so nothing is lost by speaking JSON-RPC.
  return {
    jsonrpc: '2.0' as const,
    error: { code, message, data: { code: apiCode, status } },
    id: null,
  };
}

export function createApp() {
  const app = new Hono<AppEnv>();

  // First of all: a request that reached Cloudflare over plain http is answered with where to go.
  app.use('*', redirectToHttps());

  // Single-user mode only: refuse a Host that is not ours, before anything else sees the request.
  app.use('*', singleUserHostFence());

  // One query cap per request, so a single request cannot hold the whole pool.
  app.use('*', (_c, next) => withRequestGate(next));

  app.use('*', async (c, next) => {
    const requestId = c.req.header('cf-ray') ?? randomUUID();
    c.set('requestId', requestId);
    c.header('x-request-id', requestId);
    const started = Date.now();
    await next();
    // The matched route pattern, never the path: paths carry ids and credentials.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- hono/route types its context as Context<any>
    const route = routePath(c, -1);
    observeHttp(
      c.req.method,
      route === '/*' || route === '*' ? 'unmatched' : route,
      c.res.status,
      (Date.now() - started) / 1000,
    );
    // Probes would otherwise dominate the log at one line per second.
    if (!c.req.path.startsWith('/health')) {
      logger.info(
        {
          requestId,
          method: c.req.method,
          // Not scrubbed here: `logger` redacts every `path` it is handed, so
          // the credential in a webhook or invitation URL cannot reach the log
          // from this call or from any other. See `scrubPath`.
          path: c.req.path,
          status: c.res.status,
          ms: Date.now() - started,
        },
        'request',
      );
    }
  });

  /*
   * A tighter policy for a published radar, and an honest note about its limits.
   *
   * Registered BEFORE `secureHeaders` on purpose. Middleware post-`next()` code
   * runs in reverse registration order, so this one's runs *after* the header
   * has been set and can replace it; registered afterwards it would be
   * overwritten every time.
   *
   * ## What this is not
   *
   * It is **not** what makes user theming safe. `img-src` has to allow `https:`
   * because blips carry open-graph thumbnails from arbitrary hosts, and
   * `img-src https:` is exactly the channel a CSS exfiltration uses: an
   * attribute selector that matches on a value and fires a `background-image`
   * request per match. As long as link previews exist, raw user CSS on a public
   * page would be unsafe whatever this header said. That is why the theme is a
   * closed vocabulary of enum keys — see `packages/contract/src/theme.ts`. The
   * CSP cannot be the defence, so the vocabulary is.
   *
   * ## What it is
   *
   * The directives that a public radar genuinely does not need, closed:
   *
   * - `connect-src 'self'` — the page talks to its own origin and nowhere else.
   *   The app-wide policy allows `https:` for the signed-in SPA; a stranger
   *   reading a radar needs none of it.
   * - `font-src 'self'` — no webfont from any origin, ever. Every face in the
   *   theme vocabulary is a system stack, and this is what keeps that true if
   *   somebody later adds an axis without thinking about it.
   * - `form-action 'none'` — there is no form on this page, and there should
   *   never be one that submits somewhere else.
   * - `base-uri 'none'` — a `<base>` tag would re-point every relative URL on
   *   the page at once.
   * - `frame-src 'self'` — only the isolated email reader may be embedded.
   *
   * `frame-ancestors 'none'` is already inherited from the app-wide policy, and
   * it is the one that stops a themed page being framed inside chrome that
   * pretends to be somebody else's.
   */
  app.use('*', async (c, next) => {
    await next();
    if (!/^\/r\/[A-Za-z0-9_-]{6,64}\/?$/.test(c.req.path)) return;
    c.header(
      'content-security-policy',
      [
        "default-src 'self'",
        "script-src 'self'",
        // React sets inline `style` attributes, which `style-src` governs. Not
        // load-bearing here: no user-authored CSS exists to be injected, and the
        // theme's only inline values are hexes read out of our own registry.
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob: https:",
        "connect-src 'self'",
        "font-src 'self'",
        "object-src 'none'",
        "frame-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "form-action 'none'",
      ].join('; '),
    );
  });

  /*
   * Before `secureHeaders`, so its post-`next()` half runs after and can replace
   * the app-wide `cross-origin-resource-policy`. Scoped to the OAuth and MCP
   * surfaces inside the middleware itself rather than by path here, so the
   * allow-list and the argument for it sit in one file — see `cors.ts`, and do
   * not hoist it to `/api`.
   */
  app.use('*', async (c, next) => {
    await next();
    if (/^\/api(?:\/v1)?\/guest-support(?:\/|$)/.test(c.req.path)) {
      c.header('Cache-Control', 'no-store');
      c.header('Referrer-Policy', 'no-referrer');
      c.header('X-Robots-Tag', 'noindex, nofollow');
    }
  });
  app.use('*', crossOriginAccess());

  app.use(
    '*',
    secureHeaders({
      // The SPA is same-origin and inlines nothing beyond Vite's own module
      // preloads; images may come from anywhere because blips embed remote
      // open-graph thumbnails.
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
        connectSrc: ["'self'", 'https:'],
        fontSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        frameSrc: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
      referrerPolicy: 'strict-origin-when-cross-origin',
      crossOriginEmbedderPolicy: false,
    }),
  );

  // The actor first (it reads headers, never the body): the body cap depends on whether there is one.
  app.use('*', attachActor());
  // Before the body is read: a caller over its limit must not make the server buffer a request first.
  app.use('*', rateLimitBearer());
  app.use('*', boundRequestBody());
  app.use('*', refuseCrossSiteWrites());

  app.get('/.well-known/apple-app-site-association', (c) =>
    c.json({
      applinks: {
        details: [
          {
            appIDs: ['6BUHQ4F5AN.io.onmyradar.app'],
            components: [{ '/': '/radar/*' }, { '/': '/topic/*' }, { '/': '/notifications' }],
          },
        ],
      },
    }),
  );

  app.route('/health', healthRoutes);
  app.route('/.well-known', wellKnownRoutes);
  app.route('/oauth', oauthRoutes);
  app.route('/mcp', mcpRoutes);
  // Unauthenticated ingress, outside /api because the URL is pasted into other
  // people's products. Authorization is decided in services/webhooks.ts.
  app.route('/hooks/email-capture', emailIngestRoutes);
  app.route('/hooks', hookRoutes);

  /*
   * The API is mounted twice: once unversioned and once under `/api/v1`, from
   * one list so the two can never drift.
   *
   * The version segment exists for clients that ship on their own cadence. A
   * web client deployed with the server can always be assumed current; a mobile
   * client sitting in an App Store review queue cannot, and the moment to have
   * a version segment is before that client exists rather than after it has
   * shipped without one.
   *
   * `/api/*` is not deprecated and does not move. When a v2 becomes necessary,
   * the unversioned prefix continues to mean v1 and the deprecation is
   * announced then — nothing that already works has to change for this.
   *
   * Unauthenticated by design, and both in the list: `/api/invites`, because the
   * holder of an invitation has no account yet, which is the entire situation it
   * exists for; `/api/waitlist`, the marketing site's form, for the same
   * reason; and `/api/public`, which is the published-radar surface.
   */
  const apiRoutes = [
    ['/auth', authRoutes],
    ['/invites', inviteRoutes],
    ['/waitlist', waitlistRoutes],
    ['/support', supportRoutes],
    ['/account', accountExportRoutes],
    ['/guest-support', guestSupportRoutes],
    ['/topics', topicRoutes],
    // The same router under the new vocabulary; bodies and DTOs keep `topic`.
    ['/arrays', topicRoutes],
    ['/radars', radarRoutes],
    ['/radars', subscriptionRoutes],
    ['/radars', rssRouter],
    ['', emailCaptureRoutes],
    ['/blips', blipRoutes],
    ['/anchors', anchorRoutes],
    ['/search', searchRoutes],
    ['/comments', commentRoutes],
    ['/attachments', attachmentRoutes],
    ['/webhooks', webhookRoutes],
    ['/notifications', notificationRoutes],
    ['/dashboards', dashboardRoutes],
    ['/tokens', tokenRoutes],
    ['/integrations', integrationRoutes],
    ['/repo-agents', repoAgentRoutes],
    ['/models', modelRoutes],
    ['/admin', adminRoutes],
    ['/public', publicRoutes],
  ] as const;

  for (const [path, routes] of apiRoutes) {
    app.route(`/api${path}`, routes);
    app.route(`${API_V1}${path}`, routes);
  }

  // The client portal's surface, versioned only: the portal is a separately
  // deployed client, which is what `/api/v1` is for, and `attachActor`
  // resolves an integration credential under this prefix and nowhere else.
  app.route(HELPDESK_PREFIX, helpdeskRoutes);

  /*
   * The SPA fallback is what makes client-side routes work, and it must not
   * reach anything a machine calls.
   *
   * `/api`, `/oauth` and `/hooks` were already carved out. `/mcp/…` and
   * `/.well-known/…` are here because a client probing for a transport this
   * server does not implement — `/mcp/sse` and `/mcp/messages` from the
   * deprecated HTTP+SSE transport are the obvious ones — was getting
   * `200 text/html`: the React shell, which reads to a client as a connection
   * that succeeded and then never says anything. A 404 fails loudly and lets it
   * fall back. (LM Studio, for the record, never asked for either: the
   * 2026-08-27 logs show Streamable HTTP throughout. This is a wart closed on
   * its own merits, not that incident's cause.)
   */
  app.notFound((c) => {
    const path = c.req.path;
    if (
      path.startsWith('/api/') ||
      path.startsWith('/oauth/') ||
      path.startsWith('/hooks/') ||
      path.startsWith('/.well-known/') ||
      // Metrics live on their own internal port (metrics.ts); never the SPA shell here.
      path === '/metrics' ||
      path === '/mcp' ||
      path.startsWith('/mcp/')
    ) {
      return c.json({ error: { code: 'not_found', message: 'No such endpoint' } }, 404);
    }
    return serveSpa(c);
  });

  app.onError((err, c) => {
    const { status, body } = errorBody(err);
    if (status >= 500) {
      logger.error(
        { err, errorId: body.error.id, requestId: c.get('requestId'), path: c.req.path },
        'request failed',
      );
    }
    // An `insufficient_scope` refusal has to name the scope it wanted in
    // `WWW-Authenticate` or the client cannot tell a missing grant from a
    // missing permission. This is the only error that carries headers.
    if (err instanceof ApiError && err.headers) {
      for (const [name, value] of Object.entries(err.headers)) c.header(name, value);
    }
    if (body.error.code === 'database_busy') c.header('Retry-After', '2');
    // An MCP client parses JSON-RPC, not this API's error object: a 429 or a 413 that
    // arrives in the REST shape is an error it cannot read.
    if (c.req.path === '/mcp' || c.req.path.startsWith('/mcp/')) {
      return c.json(jsonRpcError(status, body.error.code, body.error.message), status as 400);
    }
    return c.json(body, status as 400);
  });

  mountSpa(app);
  return app;
}

/* ----------------------------------- SPA --------------------------------- */

function uiDir(): string | null {
  return env().UI_DIST_DIR ?? null;
}

let cachedIndexHtml: string | null = null;

async function indexHtml(): Promise<string | null> {
  if (cachedIndexHtml) return cachedIndexHtml;
  const dir = uiDir();
  if (!dir) return null;
  try {
    cachedIndexHtml = await readFile(join(dir, 'index.html'), 'utf8');
    return cachedIndexHtml;
  } catch {
    return null;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) =>
    ch === '&'
      ? '&amp;'
      : ch === '<'
        ? '&lt;'
        : ch === '>'
          ? '&gt;'
          : ch === '"'
            ? '&quot;'
            : '&#39;',
  );
}

interface PageMeta {
  title: string;
  description: string;
  index: boolean;
  url: string;
}

/**
 * The SPA renders public radars client-side, which is fine for people and
 * useless for anything that reads the raw HTML — a chat unfurl, a crawler. The
 * document is therefore rewritten server-side with the radar's real title and
 * description before it is sent.
 */
async function metaForPath(path: string): Promise<PageMeta | null> {
  const match = /^\/r\/([A-Za-z0-9_-]{6,64})\/?$/.exec(path);
  if (!match?.[1]) return null;

  const rows = await getDb()
    .select({
      name: schema.radars.name,
      tagline: schema.radars.tagline,
      description: schema.radars.description,
      visibility: schema.radars.visibility,
      allowIndex: schema.radars.allowIndex,
    })
    .from(schema.radars)
    .where(eq(schema.radars.publicSlug, match[1]))
    .limit(1);

  const radar = rows[0];
  if (!radar || radar.visibility !== 'public') return null;

  return {
    title: `${radar.name} · On My Radar`,
    description: radar.tagline ?? radar.description ?? `A public radar on On My Radar.`,
    index: radar.allowIndex,
    url: `${env().APP_URL}${path}`,
  };
}

function injectMeta(html: string, meta: PageMeta): string {
  const tags = [
    `<title>${escapeHtml(meta.title)}</title>`,
    `<meta name="description" content="${escapeHtml(meta.description)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="On My Radar">`,
    `<meta property="og:title" content="${escapeHtml(meta.title)}">`,
    `<meta property="og:description" content="${escapeHtml(meta.description)}">`,
    `<meta property="og:url" content="${escapeHtml(meta.url)}">`,
    `<meta name="twitter:card" content="summary">`,
    meta.index ? '' : `<meta name="robots" content="noindex, nofollow">`,
  ]
    .filter(Boolean)
    .join('\n    ');

  // Drop the bundle's own <title> so there is exactly one.
  return html.replace(/<title>[\s\S]*?<\/title>/i, '').replace('</head>', `  ${tags}\n  </head>`);
}

/**
 * The client's runtime configuration, injected into the document rather than
 * baked into the bundle.
 *
 * A build-time value would mean one bundle per environment, so the artifact
 * that was tested is not the artifact that gets promoted. Injecting it here
 * keeps one bundle correct everywhere, and it is the same object a
 * separately-hosted client would get from its own static host.
 *
 * `apiBase` is empty for the SPA this server serves, because it *is* the API —
 * relative paths are correct and there is nothing to configure. It exists so
 * that the client asks the question at all: a client that never reads a base
 * URL is a client that cannot be moved.
 */
function injectConfig(html: string): string {
  // A JSON data block, not an inline script: the app-wide CSP is
  // `script-src 'self'`, which would refuse an inline one, and loosening that
  // for a configuration object would be a poor trade. `type="application/json"`
  // is never executed, so the policy does not apply and the client parses it.
  const safe = JSON.stringify({ apiBase: '' }).replace(/</g, '\\u003c');
  return html.replace(
    '</head>',
    `  <script type="application/json" id="omr-config">${safe}</script>\n  </head>`,
  );
}

async function serveSpa(c: Ctx) {
  const html = await indexHtml();
  if (!html) {
    return c.text('On My Radar API is running, but no UI bundle is installed.', 200);
  }
  const meta = await metaForPath(c.req.path).catch(() => null);
  // A radar that is not public falls through to the plain shell, which shows
  // the SPA's own "not found" state — the HTML must not confirm it exists.
  return c.html(injectConfig(meta ? injectMeta(html, meta) : html));
}

const AGENT_SETUP_TYPES: Record<string, string> = {
  '.md': 'text/markdown; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.zip': 'application/zip',
};

function mountSpa(app: Hono<AppEnv>) {
  const dir = uiDir();
  if (!dir) return;

  // Hashed asset filenames make these safe to cache hard; index.html is not
  // served from here so it never gets a long max-age.
  app.use(
    '/assets/*',
    serveStatic({
      root: dir,
      rewriteRequestPath: (path) => path,
      onFound: (_path, c) => {
        c.header('cache-control', 'public, max-age=31536000, immutable');
      },
    }),
  );

  app.get('/favicon.svg', serveStatic({ root: dir, path: 'favicon.svg' }));
  /*
   * The mark every email shows (`services/mail-layout.ts`). A PNG because mail
   * clients block SVG, at a stable unhashed path because an email sent today is
   * opened next year. Cached for a day, not forever, so a redrawn mark reaches
   * old emails too.
   */
  app.get('/email-mark.png', async (c, next) => {
    c.header('cache-control', 'public, max-age=86400');
    return serveStatic({ root: dir, path: 'email-mark.png' })(c, next);
  });
  app.get('/build.json', async (c, next) => {
    c.header('cache-control', 'no-cache');
    return serveStatic({ root: dir, path: 'build.json' })(c, next);
  });

  /*
   * The service worker, and it has to be served from the origin ROOT. A worker's
   * default scope is the directory it was served from, so one living under
   * /assets/ could only ever control /assets/ — and push would register without
   * error and then never deliver anything. It is deliberately not under the
   * hashed-asset cache rule above either: a worker pinned for a year is a worker
   * that cannot be replaced.
   */
  app.get('/sw.js', serveStatic({ root: dir, path: 'sw.js' }));

  /*
   * https://onmyradar.io/agent-setup/ — what a coding agent fetches to set
   * itself up (docs/AGENT_REPO.md §V2.18), when the API serves the bundle
   * itself (`ui.enabled=false`, a local production build). The same rules as
   * nginx (packages/ui/deploy/nginx.conf): exact types; `no-cache` except the
   * zip, whose name carries its digest; and a 404 — never the SPA shell — for
   * anything absent, so `curl … | node` is never handed HTML.
   */
  app.get('/agent-setup/:file', async (c) => {
    const file = c.req.param('file');
    const type =
      file === 'SHA256SUMS' ? 'text/plain; charset=utf-8' : AGENT_SETUP_TYPES[extname(file)];
    if (!type || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(file)) return c.text('Not found', 404);
    let body: Buffer;
    try {
      body = await readFile(join(dir, 'agent-setup', file));
    } catch {
      return c.text('Not found', 404);
    }
    c.header('content-type', type);
    c.header(
      'cache-control',
      /^omr-plugin-[^/]+\.zip$/.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache',
    );
    return c.body(new Uint8Array(body));
  });
  app.get('/agent-setup/*', (c) => c.text('Not found', 404));
  app.get('/robots.txt', (c) =>
    c.text(`User-agent: *\nDisallow: /api/\nDisallow: /oauth/\nDisallow: /hooks/\nAllow: /\n`),
  );
}
