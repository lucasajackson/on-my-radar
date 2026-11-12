/**
 * Environment. Non-secret values come from the `onmyradar-config` ConfigMap and
 * secrets from five purpose-scoped Secrets (`onmyradar-postgres`, `-app`,
 * `-minio`, `-oidc`, `-push`) — all via `envFrom`, so nothing here is ever read
 * from a file or baked into the image.
 *
 * The minio, oidc and push secrets are mounted `optional: true`, which is why
 * storage, SSO and web push are checked with `storageConfigured()` /
 * `oidcConfigured()` / `pushKeysConfigured()` rather
 * than being required: their absence turns a feature off, it does not stop the
 * server booting.
 */
import { z } from 'zod';
import { emailSchema } from '@onmyradar/contract';
import { isLocalHost } from './local-host.js';
import { parseSmtpUrl } from './smtp-url.js';

const bool = (dflt: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? dflt : /^(1|true|yes|on)$/i.test(v)));

const csv = () =>
  z
    .string()
    .optional()
    .transform((v) =>
      (v ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );

/** The two GitLab token maps. Raw strings in the schema; parsed in `loadEnv`. */
export const GITLAB_TOKEN_SETTINGS = ['GITLAB_READ_TOKENS', 'GITLAB_MIRROR_TOKENS'] as const;
export type GitLabTokenSetting = (typeof GITLAB_TOKEN_SETTINGS)[number];

/**
 * A JSON object of GitLab project path → token, or null when it is not one.
 * Unset or empty is an empty map. Never echoes the value: it holds credentials.
 */
export function parseTokenMap(raw: string | undefined): Record<string, string> | null {
  const none: Record<string, string> = {};
  if (raw === undefined || raw.trim() === '') return none;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      Object.values(parsed).every((t) => typeof t === 'string' && t.length > 0)
    )
      return parsed as Record<string, string>;
  } catch {
    // malformed: reported by name below, never by value
  }
  return null;
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3500),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  /**
   * The API's own identity. Absolute, no trailing slash.
   *
   * This is what the OAuth `issuer` and endpoint URLs, the `/mcp` challenge, the
   * OIDC `redirect_uri`, the MCP connection URL and every webhook ingest URL are
   * built from — contracts held by third parties, several of which are stored in
   * other people's systems. It must not move once a client has seen it.
   *
   * Where a *person* goes is `APP_URL`, which is a different question the moment
   * a client is hosted separately.
   */
  PUBLIC_URL: z
    .string()
    .url()
    .default('http://localhost:3500')
    .transform((v) => v.replace(/\/+$/, '')),

  /**
   * Where a person goes. Absolute, no trailing slash. Defaults to `PUBLIC_URL`,
   * so a deployment that has not split its client sees no change at all.
   *
   * Every link handed to a human is built from this: invitations, notification
   * hrefs, share links, the buttons in email, `og:url`. Deliberately NOT the
   * webhook ingest URL, which looks human-facing and is not.
   */
  APP_URL: z
    .string()
    .url()
    .optional()
    .transform((v) => (v ? v.replace(/\/+$/, '') : undefined)),

  /**
   * Origins permitted to call `/api` cross-origin, comma-separated. Empty by
   * default, which is exactly today's behaviour: no cross-origin access to the
   * API at all.
   *
   * The allowance is for bearer callers only. `Access-Control-Allow-Credentials`
   * is never sent, so a browser will not attach the session cookie to these
   * requests and will not expose the response to a caller that asks it to — and
   * `attachActor` refuses the cookie on a cross-origin request besides, because
   * a property enforced only by the browser is enforced by somebody else's code.
   * See `cors.ts`.
   */
  CORS_ALLOWED_ORIGINS: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim().replace(/\/+$/, ''))
        .filter(Boolean),
    ),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  MIGRATE_ON_BOOT: bool(false),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  DB_POOL_IDLE_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(300_000).default(30_000),
  DB_POOL_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(10_000),
  DB_APPLICATION_NAME: z.string().trim().min(1).max(63).default('onmyradar'),
  /**
   * Set on every pooled connection at startup. A runaway query is cancelled by
   * Postgres instead of holding a pool slot; jobs that legitimately run longer
   * (account export) `SET LOCAL` their own value. The migrator turns it off for
   * its own session.
   */
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).max(600_000).default(5_000),
  /** A transaction left open and idle this long is terminated, releasing its row locks. */
  DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(600_000)
    .default(30_000),
  /** Per-statement `lock_timeout` inside each migration, and how many times a lock timeout is retried. */
  MIGRATE_LOCK_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(3_000),
  MIGRATE_LOCK_RETRIES: z.coerce.number().int().min(0).max(20).default(5),
  /**
   * Queries one request may have in flight at once (hydrate, read_radar). A single
   * request must never be able to hold the whole pool.
   */
  REQUEST_QUERY_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  /** Readiness gets its own single connection; this bounds how long its ping may take. */
  READY_PING_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(2_000),
  /**
   * A readiness ping that cannot get an answer is excused by the last good one
   * for this long, so a saturated pool does not mark the pod unready; a dead
   * database (an error, not a timeout) is never excused.
   */
  READY_STALE_MS: z.coerce.number().int().min(1_000).max(300_000).default(30_000),
  SHUTDOWN_DRAIN_MS: z.coerce.number().int().min(0).max(30_000).default(5_000),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(25_000),
  // 100k UTF-16 code units can occupy 600k bytes as escaped JSON. Two MiB
  // also accommodates attachment references, MCP envelopes and widget config.
  HTTP_BODY_LIMIT_BYTES: z.coerce.number().int().min(1_048_576).max(16_777_216).default(2_097_152),
  /**
   * `/mcp` bodies: a tool call is arguments, not an upload, and zod 3 allocates
   * ~165 bytes per byte of a failing array (GHSA-mrhx-c7xc-m3w5), so the generic
   * 2 MiB limit is a memory-blowup path for authenticated agents. 256 KiB holds
   * a full 100,000-character blip body of ordinary text; a body of mostly
   * 3-byte characters (CJK) near the cap needs this raised.
   */
  MCP_BODY_LIMIT_BYTES: z.coerce.number().int().min(16_384).max(2_097_152).default(262_144),

  /**
   * Token-bucket rate limits for bearer (PAT / OAuth) callers on REST and MCP, shared
   * across replicas through Postgres. A bucket holds `BURST` requests and refills at
   * `PER_MINUTE / 60` per second. The user bucket is charged by every connection of
   * one person, so it caps what a person's several agents can do together.
   * `LEASE` is how many tokens a replica takes from the database at once (1 = one
   * write per request); the cost is that, across R replicas, a bucket can run up to
   * R x LEASE requests over its limit.
   */
  RATE_LIMIT_ENABLED: bool(true),
  RATE_LIMIT_TOKEN_PER_MINUTE: z.coerce.number().int().min(1).max(1_000_000).default(600),
  RATE_LIMIT_TOKEN_BURST: z.coerce.number().int().min(1).max(100_000).default(60),
  RATE_LIMIT_USER_PER_MINUTE: z.coerce.number().int().min(1).max(1_000_000).default(1_200),
  RATE_LIMIT_USER_BURST: z.coerce.number().int().min(1).max(100_000).default(120),
  RATE_LIMIT_LEASE: z.coerce.number().int().min(1).max(100).default(5),
  /**
   * Charter saves per writer and radar (`services/charter-limits.ts`). Working-text saves are what an
   * editor sends as the person types; sealed saves each make a version, so they get a smaller budget.
   */
  CHARTER_SAVE_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).default(240),
  CHARTER_SAVE_BURST: z.coerce.number().int().min(1).max(100_000).default(120),
  CHARTER_SEAL_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).default(30),
  CHARTER_SEAL_BURST: z.coerce.number().int().min(1).max(100_000).default(15),

  /**
   * `/metrics` (Prometheus text) is served by its own listener on this port, bound
   * to all interfaces but never routed by the ingress, and optionally behind a bearer
   * token. 0 disables it.
   */
  METRICS_PORT: z.coerce.number().int().min(0).max(65_535).default(9464),
  METRICS_TOKEN: z.string().min(16).optional(),

  /** How long per-radar counts and tallies are reused (services/stats-cache.ts). 0 disables the cache. */
  STATS_CACHE_TTL_MS: z.coerce.number().int().min(0).max(600_000).default(30_000),

  /** `list_architecture`-style whole-radar reads refuse past this many blips with a clear error. */
  ARCHITECTURE_MAX_BLIPS: z.coerce.number().int().min(100).max(1_000_000).default(20_000),

  /** 32+ bytes. Signs session cookies and hashes login codes. */
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),

  SUPPORT_RADAR_ID: z.string().uuid().optional(),
  SUPPORT_OWNER_ID: z.string().uuid().optional(),

  /* --- object storage (MinIO) --- */
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().default('on-my-radar'),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool(true),

  /* --- outbound mail --- */
  /**
   * Unset means "whatever is configured": Resend when `RESEND_API_KEY` is set,
   * otherwise the development log. Production sets neither this nor `SMTP_URL`,
   * which is why it behaves exactly as it did before they existed. See `mailProvider`.
   */
  MAIL_PROVIDER: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.enum(['resend', 'smtp', 'console']).optional(),
  ),
  RESEND_API_KEY: z.string().optional(),
  /** Holds the password: a secret, parsed by `parseSmtpUrl`. */
  SMTP_URL: z.string().optional(),
  /**
   * The whole of one SMTP send, however slowly the relay answers. It runs inside
   * the recipient fence's transaction, which Postgres ends after
   * DB_IDLE_IN_TRANSACTION_TIMEOUT_MS, so it has to be shorter than that.
   */
  SMTP_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(20_000),
  EMAIL_CAPTURE_ENABLED: bool(false),
  EMAIL_CAPTURE_DOMAIN: z
    .string()
    .regex(/^[a-z0-9.-]+$/)
    .optional(),
  EMAIL_INGEST_SECRET: z.string().min(32).optional(),
  /** Default: `On My Radar <noreply@<PUBLIC_URL host>>`, filled in by `loadEnv`. */
  MAIL_FROM: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),

  /* --- browser push (VAPID, RFC 8292) --- */
  /**
   * Both halves live in the `onmyradar-push` secret, mounted `optional: true`.
   * The public key is not a secret — every subscribing browser is handed it —
   * but a public key out of step with its private half breaks push with no
   * diagnostic that says so, so the pair is kept and rotated together.
   *
   * Rotating them invalidates every existing subscription: each browser has to
   * grant permission again. There is no way around that; the application server
   * key is baked into the subscription the browser holds.
   */
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  /** RFC 8292 requires a contact a push service operator can reach. */
  /** Default: `mailto:` the MAIL_FROM address, filled in by `loadEnv`. */
  VAPID_SUBJECT: z.string().optional(),
  APNS_TEAM_ID: z
    .string()
    .regex(/^[A-Z0-9]{10}$/)
    .optional(),
  APNS_BUNDLE_ID: z.string().min(1).max(200).default('io.onmyradar.app'),
  APNS_PRODUCTION_KEY_ID: z
    .string()
    .regex(/^[A-Z0-9]{10}$/)
    .optional(),
  APNS_PRODUCTION_PRIVATE_KEY: z.string().min(1).optional(),
  APNS_SANDBOX_KEY_ID: z
    .string()
    .regex(/^[A-Z0-9]{10}$/)
    .optional(),
  APNS_SANDBOX_PRIVATE_KEY: z.string().min(1).optional(),

  /* --- OIDC SSO (any standards-conforming provider; see .env.example) --- */
  OIDC_ISSUER_URL: z.string().optional(),
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_CLIENT_SECRET: z.string().optional(),
  OIDC_PROVIDER_NAME: z.string().default('SSO'),
  OIDC_SCOPES: z.string().default('openid email profile'),
  /**
   * How the client authenticates to the token endpoint. `basic` (client_secret_basic)
   * is the RFC 6749 default. `post` sends the credentials in the form body instead.
   * RFC 6749 §2.3 says a client MUST NOT use more than one method per request and
   * some servers reject it, so `both` exists only for a server that wants both.
   */
  OIDC_TOKEN_AUTH_METHOD: z.enum(['post', 'basic', 'both']).default('basic'),
  /** PKCE (S256) is sent by default; this turns it off for a provider that mishandles it. */
  OIDC_USE_PKCE: bool(true),
  /**
   * Back-channel timeout for the token and userinfo calls. A sign-in only happens
   * on a deliberate click, so a slow provider is better waited on than failed.
   */
  OIDC_HTTP_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(120_000).default(30_000),
  /**
   * Explicit endpoints. Authorization and token together replace discovery; set
   * them (and OIDC_JWKS_URI, which the ID token signature check needs) for a
   * provider that serves no discovery document. Otherwise leave them unset.
   */
  OIDC_AUTHORIZATION_ENDPOINT: z.string().optional(),
  OIDC_TOKEN_ENDPOINT: z.string().optional(),
  OIDC_USERINFO_ENDPOINT: z.string().optional(),
  OIDC_JWKS_URI: z.string().optional(),
  /**
   * An operator's assertion that the IdP only releases verified email addresses
   * and that users cannot change their own email there. For a provider that sends
   * no `email_verified` claim: without this an address can never be attached to an
   * existing account or used to create one. It applies only to the FIRST link or
   * create: an existing (issuer, subject) match never needs it, and it never lets
   * a different subject onto an account that already has an identity for the
   * issuer. Leave off unless that assertion is true.
   */
  OIDC_TRUST_IDP_EMAIL: bool(false),
  /**
   * Accept an ID token that carries no `nonce` claim. Off: we always send a nonce
   * and the token must echo it. Turn it on only for a provider that never does;
   * the sign-in is then bound by the PKCE verifier and the signed state cookie.
   */
  OIDC_ALLOW_MISSING_NONCE: bool(false),

  /* --- access policy --- */
  /** Bootstrap admins. Matched on normalized email; they are auto-approved. */
  ADMIN_EMAILS: csv(),
  /** Addresses (or @domains) that skip the waitlist. Everyone else lands pending. */
  AUTO_APPROVE_EMAILS: csv(),
  /**
   * `open`: every new sign-in lands active, and a still-pending account is let in
   * the next time it signs in or makes a request.
   * `waitlist`: new accounts wait for an admin unless a list above covers them.
   */
  SIGNUP_MODE: z.enum(['open', 'waitlist']).default('open'),

  /**
   * Single-user mode, for an instance only its owner can reach (a laptop, a home
   * server): the browser is signed in as this one account with no sign-in step.
   * Empty means off. Refused at boot unless `PUBLIC_URL` and `APP_URL` are local
   * hosts, and unless password and SSO sign-in are off. See `auth/single-user.ts`.
   */
  SINGLE_USER_EMAIL: z.preprocess((v) => (v === '' ? undefined : v), emailSchema.optional()),
  /** Sign in with an email address and a password. Needs working mail: reset goes by code. */
  PASSWORD_LOGIN_ENABLED: bool(false),

  /* --- MCP --- */
  MCP_ENABLED: bool(true),
  MCP_ALLOWED_REDIRECT_HOSTS: csv(),

  /* --- agent briefs bound to a repository (docs/AGENT_REPO.md §V2.17) --- */
  /**
   * The one GitLab this server talks to. Operator configuration, never a
   * user's: a brief binding names a project *on this host*, so a binding can
   * never point the worker at another server (this is not a user URL, and
   * `unfurl.ts` stays the only outbound fetch to one).
   */
  GITLAB_URL: z
    .string()
    .url()
    .optional()
    .transform((v) => (v ? v.replace(/\/+$/, '') : undefined)),
  /**
   * Read-only, project-scoped access tokens (`read_repository`), as JSON:
   * `{"lucas/on-my-radar":"glpat-…"}`. From the optional `onmyradar-gitlab`
   * secret, synced from your secret store. A project with no token here is reported
   * "not checked", never an error. Worker only.
   */
  GITLAB_READ_TOKENS: z.string().optional(),
  /**
   * Project-scoped tokens that may open a merge request (`api`, Developer), as
   * JSON in the same shape. Only read when `BRIEF_MIRROR_ENABLED` is on.
   */
  GITLAB_MIRROR_TOKENS: z.string().optional(),
  /** The one-way mirror, OMR → repo, by merge request. Off until the product owner turns it on. */
  BRIEF_MIRROR_ENABLED: bool(false),

  /** Behind cloudflared, XFF is the tunnel pod for everyone; CF-Connecting-IP is the client. */
  TRUSTED_IP_HEADER: z.string().default('cf-connecting-ip'),

  /** Where the built SPA lives. Set by the Dockerfile. */
  UI_DIST_DIR: z.string().optional(),

  /**
   * The `agent-setup/` source directory (it holds `build-plugin.mjs`). Set by the
   * runtime image. When set, `/agent-setup/*` is stamped from `PUBLIC_URL` and
   * served from memory; when unset it is served from the UI bundle on disk.
   */
  AGENT_SETUP_SRC: z.string().optional(),

  /** Set by CI as the git SHA of the commit this image was built from. */
  ONMYRADAR_BUILD_SHA: z.string().default(''),
});

/**
 * `APP_URL` is optional in the schema and always present here: `loadEnv` fills
 * it from `PUBLIC_URL` when it is unset, so every reader can treat it as a
 * string and none of them has to know about the default.
 */
export type Env = Omit<
  z.infer<typeof envSchema>,
  'APP_URL' | 'MAIL_FROM' | 'VAPID_SUBJECT' | 'GITLAB_READ_TOKENS' | 'GITLAB_MIRROR_TOKENS'
> & {
  APP_URL: string;
  MAIL_FROM: string;
  VAPID_SUBJECT: string;
  GITLAB_READ_TOKENS: Record<string, string>;
  GITLAB_MIRROR_TOKENS: Record<string, string>;
  /**
   * Token settings that were set but are not a JSON map. Unlike the rest of
   * this file, they do not stop the boot: a typo in an optional credential
   * turns repository checks (or the mirror) off and is logged by name, while
   * capture — the product — keeps running.
   */
  GITLAB_TOKEN_ERRORS: GitLabTokenSetting[];
};

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment:\n${detail}`);
  }
  // Sender and push contact follow the deployment's own host unless set.
  const mailFrom =
    parsed.data.MAIL_FROM ?? `On My Radar <noreply@${new URL(parsed.data.PUBLIC_URL).hostname}>`;
  validateMail({ ...parsed.data, MAIL_FROM: mailFrom });
  if (parsed.data.SHUTDOWN_DRAIN_MS >= parsed.data.SHUTDOWN_TIMEOUT_MS) {
    throw new Error('Invalid environment: SHUTDOWN_DRAIN_MS must be less than SHUTDOWN_TIMEOUT_MS');
  }
  for (const environment of ['PRODUCTION', 'SANDBOX'] as const) {
    const key = parsed.data[`APNS_${environment}_KEY_ID`];
    const secret = parsed.data[`APNS_${environment}_PRIVATE_KEY`];
    if (Boolean(key) !== Boolean(secret) || (key && !parsed.data.APNS_TEAM_ID))
      throw new Error(
        `Invalid environment: complete APNS_${environment} key pair and APNS_TEAM_ID required`,
      );
  }
  // `APP_URL` defaults to `PUBLIC_URL` rather than to a literal, so a deployment
  // that has not split its client cannot end up pointing people somewhere else.
  const read = parseTokenMap(parsed.data.GITLAB_READ_TOKENS);
  const mirror = parseTokenMap(parsed.data.GITLAB_MIRROR_TOKENS);
  const errors = GITLAB_TOKEN_SETTINGS.filter(
    (name) => (name === 'GITLAB_READ_TOKENS' ? read : mirror) === null,
  );
  const config: Env = {
    ...parsed.data,
    APP_URL: parsed.data.APP_URL ?? parsed.data.PUBLIC_URL,
    MAIL_FROM: mailFrom,
    VAPID_SUBJECT:
      parsed.data.VAPID_SUBJECT ?? `mailto:${/<([^>]+)>/.exec(mailFrom)?.[1] ?? mailFrom}`,
    GITLAB_READ_TOKENS: read ?? {},
    GITLAB_MIRROR_TOKENS: mirror ?? {},
    // A mirror whose tokens cannot be read is a mirror that is off.
    BRIEF_MIRROR_ENABLED: parsed.data.BRIEF_MIRROR_ENABLED && mirror !== null,
    GITLAB_TOKEN_ERRORS: errors,
  };
  validateAuth(config);
  return config;
}

/**
 * How people may sign in has to hang together; refused at boot, not at the first request.
 * Single-user mode has no override flag: an instance that anyone can reach signs in with
 * a password or SSO.
 */
function validateAuth(config: Env): void {
  if (config.SINGLE_USER_EMAIL) {
    for (const url of [config.PUBLIC_URL, config.APP_URL]) {
      if (!isLocalHost(new URL(url).hostname))
        throw new Error(
          `Invalid environment: SINGLE_USER_EMAIL signs in anyone who can reach the server, so ${url} must be a local host (localhost, a private address, .local, .lan, .internal). For a public host, leave SINGLE_USER_EMAIL empty and use PASSWORD_LOGIN_ENABLED or SSO`,
        );
    }
    if (config.PASSWORD_LOGIN_ENABLED || oidcConfigured(config))
      throw new Error(
        'Invalid environment: SINGLE_USER_EMAIL cannot be combined with PASSWORD_LOGIN_ENABLED or OIDC sign-in',
      );
  }
  if (config.PASSWORD_LOGIN_ENABLED && mailProvider(config) === 'none')
    throw new Error(
      'Invalid environment: PASSWORD_LOGIN_ENABLED needs outbound mail (a forgotten password is reset by an emailed code); set MAIL_PROVIDER and SMTP_URL',
    );
}

/** True when every value the S3 client needs is present. */
/** Log, by name and never by value, each GitLab token setting that could not be read. */
export function reportTokenErrors(
  config: Env,
  log: { error: (obj: object, msg: string) => void },
): void {
  for (const setting of config.GITLAB_TOKEN_ERRORS) {
    log.error(
      { setting },
      `${setting} is set but is not a JSON object of "group/project": "token" — ${
        setting === 'GITLAB_READ_TOKENS'
          ? 'repository checks are off; bound briefs read "not checked"'
          : 'the brief mirror is off'
      }`,
    );
  }
}

export function storageConfigured(env: Env): boolean {
  return Boolean(env.S3_ENDPOINT && env.S3_ACCESS_KEY && env.S3_SECRET_KEY && env.S3_BUCKET);
}

/**
 * Which outbound mail provider is in effect.
 *
 * `none` is a production instance with nothing configured: sending throws, as it
 * always has, rather than pretending to deliver.
 */
export function mailProvider(
  env: Pick<Env, 'MAIL_PROVIDER' | 'RESEND_API_KEY' | 'NODE_ENV'>,
): 'resend' | 'smtp' | 'console' | 'none' {
  if (env.MAIL_PROVIDER) return env.MAIL_PROVIDER;
  if (env.RESEND_API_KEY) return 'resend';
  return env.NODE_ENV === 'production' ? 'none' : 'console';
}

/** True when a magic-link email can actually be delivered (the log provider delivers nothing). */
export function mailConfigured(
  env: Pick<Env, 'MAIL_PROVIDER' | 'RESEND_API_KEY' | 'NODE_ENV'>,
): boolean {
  const provider = mailProvider(env);
  return provider === 'resend' || provider === 'smtp';
}

/** Settings that name a provider have to be able to use it; refused at boot, not at the first sign-in. */
function validateMail(
  data: Pick<
    Env,
    | 'MAIL_PROVIDER'
    | 'RESEND_API_KEY'
    | 'SMTP_URL'
    | 'SMTP_TIMEOUT_MS'
    | 'DB_IDLE_IN_TRANSACTION_TIMEOUT_MS'
    | 'MAIL_FROM'
    | 'NODE_ENV'
  >,
): void {
  if (/[\r\n]/.test(data.MAIL_FROM))
    throw new Error('Invalid environment: MAIL_FROM must be a single line');
  if (data.MAIL_PROVIDER === 'console' && data.NODE_ENV === 'production')
    throw new Error(
      'Invalid environment: MAIL_PROVIDER=console is development only (it logs the message, sign-in code included)',
    );
  if (data.MAIL_PROVIDER === 'resend' && !data.RESEND_API_KEY)
    throw new Error('Invalid environment: MAIL_PROVIDER=resend requires RESEND_API_KEY');
  if (data.MAIL_PROVIDER === 'smtp') {
    if (!data.SMTP_URL)
      throw new Error('Invalid environment: MAIL_PROVIDER=smtp requires SMTP_URL');
    try {
      parseSmtpUrl(data.SMTP_URL);
    } catch (err) {
      throw new Error(`Invalid environment: ${(err as Error).message}`);
    }
    if (data.SMTP_TIMEOUT_MS >= data.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS)
      throw new Error(
        'Invalid environment: SMTP_TIMEOUT_MS must be less than DB_IDLE_IN_TRANSACTION_TIMEOUT_MS',
      );
  }
}

/**
 * True when browser push can actually be delivered.
 *
 * Absent is a supported state, like storage and SSO: the server logs a line at
 * boot and the UI hides the control, rather than offering somebody a switch
 * that cannot do anything.
 */
export function pushKeysConfigured(env: Env): boolean {
  return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
}

/** True when SSO is worth offering on the login screen. */
export function oidcConfigured(
  env: Env,
): env is Env & { OIDC_ISSUER_URL: string; OIDC_CLIENT_ID: string; OIDC_CLIENT_SECRET: string } {
  return Boolean(env.OIDC_ISSUER_URL && env.OIDC_CLIENT_ID && env.OIDC_CLIENT_SECRET);
}

let cached: Env | null = null;
export function env(): Env {
  cached ??= loadEnv();
  return cached;
}

/** Test seam — lets a suite install a fixture env without touching process.env. */
export function setEnvForTesting(value: Env | null): void {
  cached = value;
}
