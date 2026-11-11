/** Shared HTTP plumbing: typed context, error shape, and body validation. */
import { randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { ZodError, type ZodType, type ZodTypeDef } from 'zod';
import type { ApiErrorDto, BlipDto, RadarRole, TokenScope, Voice } from '@onmyradar/contract';
import { env } from './env.js';
import { isDatabaseBusy, isMalformedId } from './errors.js';
import type { UserRow } from './auth/accounts.js';

/**
 * The persona an agent-borne connection speaks as, resolved once by
 * `attachActor` and carried from there.
 *
 * Declared here rather than imported from `services/agents.ts` because `Actor`
 * is the type every authorization decision flows through and it must not depend
 * on a service. `services/agents.ts` re-exports the same shape for the code that
 * builds one.
 */
export interface ActorAgent {
  agentId: string;
  name: string;
  handle: string;
  /**
   * The human this agent belongs to. Equal to `Actor.user.id` when the agent
   * comes from the credential (`auth/bearer.ts` refuses a token bound to
   * somebody else's agent). A load session can bind an agent *shared* with the
   * caller (`writeAsAgent`), and then the caller is the cosigner, not the owner.
   */
  ownerId: string;
}

/**
 * The stable identity of a bearer connection: a PAT's id, or an OAuth grant's
 * client id — never an access-token row, which rotates on refresh. `label` is
 * server-derived (the PAT's name, the client's registered name), so it can be
 * shown as provenance without trusting anything the caller said.
 */
export interface ActorConnection {
  kind: 'pat' | 'oauth';
  id: string;
  label: string | null;
}

/** Who is making this request, and how they proved it. */
export interface Actor {
  user: UserRow;
  /**
   * 'user' for a browser session, 'agent' for a PAT or OAuth token on /mcp,
   * 'webhook' for an inbound delivery acting as the webhook's creator,
   * 'integration' for an outside system's `omr_int_` credential (the W&W
   * portal) acting as its owner on `/api/v1/helpdesk` and nowhere else. The
   * distinction exists so the audit log records which it was rather than
   * flattening them into one.
   *
   * An `integration` actor exists only on the helpdesk routes (`attachActor`
   * resolves the token nowhere else), and even there `requireRadar`,
   * `requireScope`, `requireActor` and `liveActor` refuse it:
   * `requireHelpdeskRadar` is its only door (`docs/HELPDESK.md` §3.3).
   */
  kind: 'user' | 'agent' | 'webhook' | 'integration' | 'guest';
  invocation?: 'mcp';
  sessionId?: string;
  /** Set only when the browser's session cookie authenticated this request (not a bearer session). */
  viaCookie?: true;
  /**
   * Set only for a first-party app's session token (a sign-in with client `ios` or `android`) sent as a
   * bearer. Not a PAT, an OAuth grant, a `cli` session or anything on /mcp. See `isHumanSession`.
   */
  appSession?: true;
  tokenId?: string;
  /** Set when kind is 'webhook'. */
  webhookId?: string;
  /** Set when kind is 'integration'. */
  integrationId?: string;
  /**
   * What a bearer token was granted. Absent for a browser session and for a
   * webhook delivery, neither of which is scoped.
   */
  scopes?: readonly TokenScope[];
  /**
   * The strongest `RadarRole` this actor may reach, whatever their own grants
   * say. Absent means unbounded, which is identical to `'owner'` — see
   * `ceilingOf`. `services/access.ts` is the only place that applies it.
   */
  ceiling?: RadarRole;
  /**
   * The persona this connection writes as, when it has one.
   *
   * **The only source of `agent_id` on any write in this application.** No
   * request body, no MCP tool argument and no service parameter carries an agent
   * id, so authoring under an agent's name requires holding a token that carries
   * that agent — which requires being its owner. That is what makes
   * human→agent impersonation structurally impossible rather than refused.
   *
   * Absent for a browser session, unconditionally, and that is a statement
   * rather than a default: a person typing is the person.
   */
  agent?: ActorAgent;
  /**
   * Which voices this connection may use, and which one an unqualified call
   * gets. Present exactly when `agent` is.
   *
   * A grant, in the same shape as `scopes`: the human grants a range and the
   * agent exercises within it. `services/agents.ts` is the only place that
   * reads it, and a call asking for a voice outside the range is refused rather
   * than downgraded.
   */
  voice?: { granted: readonly Voice[]; default: Voice };
  /** Present for a bearer connection. See `ActorConnection`. */
  connection?: ActorConnection;
  /** The /mcp request's `User-Agent`. `omr-agent` puts its version here; `load_agent` reads it. */
  userAgent?: string;
  /**
   * Who this credential was minted for, as a clause for an error message
   * (`"Name", which has been archived` / `an agent that has since been deleted`),
   * when that agent is archived or gone. The connection still reads, but its ceiling is capped
   * at `viewer` (`auth/bearer.ts`) and every refusal says why (`access.ts`).
   */
  retiredAgent?: string;
  /**
   * The agents whose radar scope binds this connection: the one its credential was minted
   * for, plus any it loaded a session as. Only the ids travel; whether an agent is limited,
   * and to which radars, is read from the database on each question (`fenceCaps` in
   * `services/access.ts`, the only reader), so narrowing or revoking takes effect on the
   * next request. Set from the credential in `auth/bearer.ts` and only ever added to
   * (`writeAsAgent`): loading a wider agent must not shed a narrower one's limit.
   */
  radarFence?: readonly string[];
}

/**
 * The cap this actor acts under. Unscoped callers — a signed-in person in a
 * browser, a webhook acting as its creator — are capped at `'owner'`, which is
 * the top of `RADAR_ROLES` and therefore no cap at all. Writing it this way
 * means the clamp is one expression with no "is this an agent" branch in it.
 */
export function ceilingOf(actor: Actor | null | undefined): RadarRole {
  return actor?.ceiling ?? 'owner';
}

export interface AppEnv {
  Variables: {
    actor?: Actor;
    /**
     * How `actor` proved who it is: the ambient session cookie, or a credential
     * the caller had to be handed. Set by `attachActor`; `csrf.ts` exempts only the latter.
     */
    authVia?: 'cookie' | 'bearer';
    requestId: string;
  };
}

export type Ctx = Context<AppEnv>;

export class ApiError extends HTTPException {
  constructor(
    status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 415 | 422 | 429 | 500 | 502 | 503,
    public readonly code: string,
    message: string,
    public readonly fields?: Record<string, string>,
    /**
     * Response headers this error must carry. Exists for one case: RFC 6750
     * says an insufficient-scope refusal has to name the scope it wanted in
     * `WWW-Authenticate`, or a client has no way to know what to ask for next.
     */
    public readonly headers?: Record<string, string>,
    /** A 409 over a blip: the blip as it stands, so the caller can merge and retry. */
    public readonly current?: BlipDto,
  ) {
    super(status, { message });
    this.name = 'ApiError';
  }
}

export const badRequest = (message: string, fields?: Record<string, string>) =>
  new ApiError(400, 'bad_request', message, fields);
export const unauthorized = (message = 'Sign in to continue') =>
  new ApiError(401, 'unauthorized', message);
export const forbidden = (message = 'You do not have access to that') =>
  new ApiError(403, 'forbidden', message);
export const notFound = (message = 'Not found') => new ApiError(404, 'not_found', message);
export const conflict = (message: string) => new ApiError(409, 'conflict', message);
/**
 * `retryAfterSeconds` becomes a `Retry-After` header, because a refusal that
 * does not say when to try again gets retried immediately. That mattered less
 * when every caller was a page this repo also ships; it matters now that
 * clients are deployed separately and cannot be hotfixed when they misbehave.
 */
export const tooManyRequests = (message: string, retryAfterSeconds?: number) =>
  new ApiError(
    429,
    'rate_limited',
    message,
    undefined,
    retryAfterSeconds === undefined
      ? undefined
      : { 'Retry-After': String(Math.max(1, Math.ceil(retryAfterSeconds))) },
  );

/**
 * A refusal that is about the *token*, not about the person holding it.
 *
 * Distinct from `forbidden` on purpose. "You have read-only access to this
 * radar" sends an agent looking for a permission its human already has; this
 * says the connection itself was granted less than the operation needs, which is
 * a thing only a re-authorization can change. The code and the header are the
 * ones RFC 6750 3.1 defines, so a well-behaved OAuth client can act on it.
 */
export const insufficientScope = (scope: TokenScope, message: string) =>
  new ApiError(403, 'insufficient_scope', message, undefined, {
    'WWW-Authenticate': `Bearer error="insufficient_scope", scope="${scope}"`,
  });

export function errorBody(err: unknown): { status: number; body: ApiErrorDto } {
  if (err instanceof ApiError) {
    return {
      status: err.status,
      body: {
        error: {
          code: err.code,
          message: err.message,
          ...(err.fields ? { fields: err.fields } : {}),
          ...(err.current ? { current: err.current } : {}),
        },
      },
    };
  }
  if (err instanceof HTTPException && err.status < 500) {
    return { status: err.status, body: { error: { code: 'http_error', message: err.message } } };
  }
  if (isDatabaseBusy(err)) {
    return {
      status: 503,
      body: {
        error: {
          code: 'database_busy',
          message: 'The service is busy right now. Try again in a moment.',
        },
      },
    };
  }
  if (isMalformedId(err)) {
    return { status: 404, body: { error: { code: 'not_found', message: 'Not found' } } };
  }
  // A schema `.parse` that escaped a route or a service is still the caller's
  // input being refused, not a fault of ours: a 400 that says which field, as
  // `readJson` would have, rather than a 500.
  if (err instanceof ZodError) {
    return {
      status: 400,
      body: {
        error: {
          code: 'bad_request',
          message: err.issues[0]?.message ?? 'Invalid request',
          fields: zodFields(err),
        },
      },
    };
  }
  // Anything else is our fault, and its text is ours too: a Postgres message
  // quotes the SQL and its parameters, a stack names files. Opaque in every
  // environment, not only production — a test or staging response is still a
  // response somebody can read. The caller logs the error under this id.
  return {
    status: 500,
    body: {
      error: {
        code: 'internal_error',
        message: 'Something went wrong on our end.',
        id: `err_${randomUUID()}`,
      },
    },
  };
}

function zodFields(err: ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of err.issues) {
    const key = issue.path.join('.') || '_';
    fields[key] ??= issue.message;
  }
  return fields;
}

/**
 * The request schemas take `unknown` in and produce a typed value out, which is
 * spelled out here rather than left to `ZodSchema<T>`. That alias fixes the
 * input type *equal* to the output type, so any schema that coerces — a
 * `z.coerce.number()`, or a filter that accepts the comma-separated string a
 * query string can carry — silently degraded `T` to `unknown` at the call site
 * instead of failing where the mismatch was.
 */
type RequestSchema<T> = ZodType<T, ZodTypeDef, unknown>;

/**
 * Parse and validate a JSON body, converting a ZodError into a 400 with field
 * detail.
 *
 * The body must be *declared* JSON. It used to be parsed whatever the
 * `Content-Type` said, which let a cross-site HTML form — which can send
 * `text/plain` but never `application/json` — deliver a JSON body to any
 * handler here. Every first-party client already sends the header.
 */
export async function readJson<T>(c: Ctx, schema: RequestSchema<T>): Promise<T> {
  const type = (c.req.header('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (type !== 'application/json' && !/^application\/[a-z0-9.+-]+\+json$/.test(type)) {
    throw new ApiError(
      415,
      'unsupported_media_type',
      'Send the body as JSON, with Content-Type: application/json.',
    );
  }
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw badRequest('Expected a JSON body');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const fields = zodFields(parsed.error);
    throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid request', fields);
  }
  return parsed.data;
}

/** Same, for query strings. */
export function readQuery<T>(c: Ctx, schema: RequestSchema<T>): T {
  const parsed = schema.safeParse(c.req.query());
  if (!parsed.success) {
    throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid query', zodFields(parsed.error));
  }
  return parsed.data;
}

/**
 * The caller's IP, read only from the header the edge is trusted to set.
 *
 * The path here is Cloudflare → cloudflared → Traefik → this pod, and the
 * cluster has no other public ingress. Cloudflare sets `CF-Connecting-IP` on
 * every proxied request and overwrites one a client sent, and neither
 * cloudflared nor Traefik touches it, so it is the client's address.
 * `X-Forwarded-For` is not: its leftmost entry is whatever the client wrote,
 * with the proxies appending after it. This used to fall back to that entry
 * when the trusted header was missing, which made the address a caller-chosen
 * value the moment anything keyed a limit on it. Now absent means unknown.
 */
export function clientIp(c: Ctx): string | null {
  const value = c.req.header(env().TRUSTED_IP_HEADER.toLowerCase());
  if (!value) return null;
  return (value.split(',')[0] ?? '').trim() || null;
}

/**
 * The actor only when it is a live principal, and `null` otherwise.
 *
 * For the handful of routes that serve an anonymous caller and a signed-in one
 * through the same code path — a public radar's comment thread, an attachment
 * on one. They deliberately do not call `requireActor`, so before this a
 * suspended or never-approved account arrived as a fully-formed actor and was
 * authorized on its memberships. Downgrading to anonymous keeps the public path
 * working and removes the half-authenticated state entirely.
 *
 * A bearer token for such an account no longer resolves at all (`auth/bearer.ts`),
 * so this is about session cookies — which are kept attached on purpose, because
 * `requireActor` needs them to answer "your account is waiting to be approved"
 * rather than "sign in".
 */
export function liveActor(c: Ctx): Actor | null {
  const actor = c.get('actor');
  // An integration is nobody outside its own routes, public ones included.
  if (actor?.kind === 'integration' || actor?.kind === 'guest') return null;
  return actor && actor.user.state === 'active' ? actor : null;
}

export function requireActor(c: Ctx): Actor {
  const actor = c.get('actor');
  if (!actor) throw unauthorized();
  // The second fence behind path-bound resolution: an integration credential is
  // not an actor on any route that asks for one this way. The helpdesk routes
  // use `requireIntegration` instead.
  if (actor.kind === 'integration' || actor.kind === 'guest') throw unauthorized();
  if (actor.user.state === 'suspended') {
    throw forbidden('This account has been suspended.');
  }
  if (actor.user.state === 'pending') {
    throw new ApiError(403, 'awaiting_approval', 'Your account is waiting to be approved.');
  }
  return actor;
}

/**
 * A signed-in person in a browser, not a bearer token.
 *
 * Guards the endpoints where a token could otherwise escape its own ceiling:
 * minting a personal access token, revoking one, and approving an OAuth consent.
 * Every one of those *issues or destroys a credential*, so leaving them open to
 * bearer auth makes every scope decoration again — a read-only token would
 * simply `POST /api/tokens` and hand itself a full-access PAT, or register a
 * client and approve its own consent. A ceiling that can be raised by one HTTP
 * call is not a ceiling.
 *
 * Also guards `/api/admin`, for a related reason: no scope in `TOKEN_SCOPES`
 * describes approving accounts or suspending people, so no consent screen has
 * ever offered it and no agent has ever been granted it. It was reachable only
 * because `requireAdmin` asked what the *user* was and never what the connection
 * was.
 */
/**
 * The portal's integration credential, on `/api/v1/helpdesk` (§3.3). Anything
 * else — a session, a PAT, nothing — is a 401: this surface has one caller class.
 */
export function requireIntegration(c: Ctx): Actor & { integrationId: string } {
  const actor = c.get('actor');
  if (actor?.kind !== 'integration' || !actor.integrationId) {
    throw unauthorized('This route takes an integration credential (Bearer omr_int_…).');
  }
  return actor as Actor & { integrationId: string };
}

export function requireUser(c: Ctx): Actor {
  const actor = requireActor(c);
  if (actor.kind !== 'user') {
    throw forbidden('This has to be done while signed in, not over an agent connection.');
  }
  return actor;
}

export function requireAdmin(c: Ctx): Actor {
  const actor = requireUser(c);
  if (!actor.user.isAdmin) throw forbidden('Admins only');
  return actor;
}
