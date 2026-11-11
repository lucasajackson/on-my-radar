/**
 * OAuth 2.1 authorization server for remote MCP clients.
 *
 * Scope is deliberately small: dynamic client registration (RFC 7591), the
 * authorization-code grant with mandatory PKCE, and refresh tokens. There are no
 * confidential clients — an MCP client running in somebody else's product cannot
 * keep a secret — so security rests on PKCE plus an allow-list of redirect hosts.
 *
 * Consent is a real screen in the SPA, not an auto-approval: the whole point is
 * that the user sees which client is asking before an agent gets their radars.
 *
 * ## The scope on a grant is now load-bearing
 *
 * It was not. A client could ask for `radars:read`, the string was stored, and
 * the token then acted at the full breadth of its human's access anyway, because
 * `attachActor` discarded what `resolveBearerToken` computed. Two things follow
 * from closing that:
 *
 * - **What is stored is what the server understands.** A requested scope is
 *   filtered through `parseScopes` before it is written, so an unknown entry can
 *   never end up in a grant, and a request naming nothing this server grants is
 *   refused rather than silently widened to everything.
 * - **A grant records whether its scopes were consented to.** `scope_consented`
 *   is what makes it safe to start enforcing without withdrawing access from
 *   live connections whose scope string was never displayed to anybody. It is
 *   carried forward through refresh rotation rather than re-derived, because
 *   otherwise every legacy grant would become enforced within the hour.
 *   `drizzle/0014_token_scopes.sql` carries the argument.
 */
import { Hono } from 'hono';
import { and, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  OAUTH_DEFAULT_SCOPES,
  parseScopes,
  parseVoiceGrants,
  TOKEN_SCOPES,
  VOICE_SCOPES,
  VOICE_SCOPE_LIST,
  type Voice,
} from '@onmyradar/contract';
import { REFRESH_TOKEN_TTL_MS } from '../auth/lifetimes.js';
import { hashSecret, randomToken, verifyPkce } from '../auth/crypto.js';
import { type Db, getDb, schema } from '../db/client.js';
import { env } from '../env.js';
import { badRequest, readJson, requireUser, type AppEnv } from '../http.js';
import type { Context } from 'hono';
import { logger } from '../logger.js';
import { agentDto, listAgents, requireOwnLiveAgent } from '../services/agents.js';
import { recordAudit } from '../services/audit.js';
import { lockGrant } from '../services/tokens.js';
import { textValue } from '../text-value.js';

export const oauthRoutes = new Hono<AppEnv>();
export const wellKnownRoutes = new Hono<AppEnv>();

const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
/**
 * Advertised in both discovery documents and the ceiling of what may be granted.
 * Defined in the contract package so the consent screen, the token resolver and
 * this server are reading one list rather than three that have to agree.
 */
const SCOPES = [...TOKEN_SCOPES, ...VOICE_SCOPE_LIST];

/**
 * The voice scopes a request asked for, kept apart from the access scopes.
 *
 * They travel in the same string because that is the channel OAuth gives us and
 * the consent screen already renders it — one screen, one record of what was
 * agreed to, never auto-approved. They are parsed separately because they answer
 * a different question: `radars:*` is a *ceiling on access*, `voice:*` is a grant
 * over whose name appears on writing. Folding them into `parseScopes` would put
 * a rendering decision inside `ceilingFor` and make one `min` mean two things.
 */
function grantedVoices(raw: string | undefined, hasAgent: boolean): Voice[] {
  if (!hasAgent) return [];
  return parseVoiceGrants(raw) ?? ['principal'];
}

/**
 * What a request's `scope` parameter actually grants, or null when it names
 * nothing this server understands.
 *
 * Absent means read and write, not manage: publishing and sharing is a box the person
 * ticks on the consent screen. Grants made before this are untouched — they carry their
 * scope through refresh (`issueTokens(existing.scope, …)`), so nothing live narrows.
 */
function grantedScopes(raw: string | undefined, voices: Voice[] = []): string | null {
  const voicePart = voices.map((voice) => VOICE_SCOPES[voice]);
  if (!raw) return [...OAUTH_DEFAULT_SCOPES, ...voicePart].join(' ');
  const parsed = parseScopes(raw);
  if (parsed.length === 0) return null;
  // The stored string is what the consent screen displayed, so the voices the
  // person actually ticked go in beside the access scopes rather than being
  // re-derived later from something nobody saw. `bearer.ts` reads them straight
  // back out of it.
  return [...parsed, ...voicePart].join(' ');
}

/* ---------------------------- discovery documents ------------------------ */

const protectedResource = (path: string) => (c: Context) => {
  const base = env().PUBLIC_URL;
  return c.json({
    resource: `${base}${path}`,
    authorization_servers: [base],
    scopes_supported: SCOPES,
    bearer_methods_supported: ['header'],
  });
};

wellKnownRoutes.get('/oauth-protected-resource', protectedResource('/mcp'));

const authorizationServerMetadata = () => {
  const base = env().PUBLIC_URL;
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    scopes_supported: SCOPES,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
  };
};

wellKnownRoutes.get('/oauth-authorization-server', (c) => c.json(authorizationServerMetadata()));
wellKnownRoutes.get('/openid-configuration', (c) => c.json(authorizationServerMetadata()));

/* ---------------------------- redirect allow-list ------------------------ */

/** `*.claude.ai` style patterns, plus loopback which is always permitted. */
function hostAllowed(host: string): boolean {
  const normalized = host.toLowerCase();
  if (normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '[::1]')
    return true;
  return env().MCP_ALLOWED_REDIRECT_HOSTS.some((pattern) => {
    const p = pattern.toLowerCase();
    if (p.startsWith('*.')) return normalized === p.slice(2) || normalized.endsWith(p.slice(1));
    return normalized === p;
  });
}

function assertRedirectUri(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw badRequest('redirect_uri must be an absolute URL');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
  if (url.protocol !== 'https:' && !loopback) {
    throw badRequest('redirect_uri must use https (except on loopback)');
  }
  if (!hostAllowed(url.hostname)) {
    throw badRequest(`redirect_uri host "${url.hostname}" is not allowed on this server`);
  }
  return url;
}

/* ------------------------- dynamic client registration ------------------- */

const registrationSchema = z.object({
  client_name: z.string().max(200).optional(),
  redirect_uris: z.array(z.string().url()).min(1).max(10),
  grant_types: z.array(z.string()).optional(),
  token_endpoint_auth_method: z.string().optional(),
});

oauthRoutes.post('/register', async (c) => {
  const input = await readJson(c, registrationSchema);
  for (const uri of input.redirect_uris) assertRedirectUri(uri);

  const clientId = `omr_client_${randomToken(16)}`;
  await getDb()
    .insert(schema.oauthClients)
    .values({
      clientId,
      clientName: input.client_name ?? null,
      redirectUris: input.redirect_uris,
      clientSecretHash: null,
    });

  logger.info({ clientId, name: input.client_name }, 'oauth client registered');
  return c.json(
    {
      client_id: clientId,
      client_name: input.client_name ?? null,
      redirect_uris: input.redirect_uris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      client_id_issued_at: Math.floor(Date.now() / 1000),
    },
    201,
  );
});

/* ------------------------------- authorize ------------------------------- */

const authorizeQuerySchema = z.object({
  client_id: z.string().min(1),
  redirect_uri: z.string().min(1),
  response_type: z.literal('code'),
  code_challenge: z.string().min(20).max(255),
  code_challenge_method: z.enum(['S256']).default('S256'),
  state: z.string().max(500).optional(),
  scope: z.string().max(500).optional(),
});

async function loadClient(clientId: string) {
  const rows = await getDb()
    .select()
    .from(schema.oauthClients)
    .where(eq(schema.oauthClients.clientId, clientId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Hands off to the SPA's consent screen. Errors that happen *before* the
 * redirect_uri is validated are shown on our own page — bouncing an error to an
 * unverified redirect_uri would make this an open redirector.
 */
oauthRoutes.get('/authorize', async (c) => {
  const parsed = authorizeQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    // Named by parameter: a bare "Required" on the error page tells the person
    // (and whoever they report it to) nothing about which one the client left out.
    const issue = parsed.error.issues[0];
    const message = issue
      ? `${issue.path.join('.') || 'request'}: ${issue.message}`
      : 'Invalid authorization request';
    return c.redirect(`/connect/error?message=${encodeURIComponent(message)}`);
  }
  const query = parsed.data;

  const client = await loadClient(query.client_id);
  if (!client) return c.redirect(`/connect/error?message=${encodeURIComponent('Unknown client')}`);
  if (!client.redirectUris.includes(query.redirect_uri)) {
    return c.redirect(
      `/connect/error?message=${encodeURIComponent('redirect_uri was not registered by this client')}`,
    );
  }
  assertRedirectUri(query.redirect_uri);
  // Caught here rather than at the decision, so a request nobody could approve
  // never reaches a consent screen that would be lying about what it grants.
  if (grantedScopes(query.scope) === null) {
    return c.redirect(
      `/connect/error?message=${encodeURIComponent('This client asked for scopes this server does not grant')}`,
    );
  }

  const actor = c.get('actor');
  const authorizeUrl = `/oauth/authorize?${new URLSearchParams(c.req.query()).toString()}`;
  if (!actor) return c.redirect(`/login?next=${encodeURIComponent(authorizeUrl)}`);

  // The SPA renders the consent screen from these params and posts a decision.
  return c.redirect(`/connect?${new URLSearchParams(c.req.query()).toString()}`);
});

const decisionSchema = authorizeQuerySchema.extend({
  approve: z.boolean(),
  /**
   * The persona this client will speak as, picked from the ones the signed-in
   * person already owns, and the voices it may use.
   *
   * An id, never a name — the same rule as `createTokenSchema`. Approving a
   * consent must not be able to *create* a principal as a side effect, or the
   * consent screen becomes a second, quieter naming ceremony for a client that
   * chose the name.
   */
  agentId: z.string().uuid().optional(),
  voices: z
    .array(z.enum(['persona', 'principal']))
    .min(1)
    .max(2)
    .optional(),
});

/**
 * `requireUser`, not `requireActor`. Approving a consent mints a credential, so
 * leaving it open to bearer auth would let a token that was granted `radars:read`
 * register a client and approve its own full-access grant — a ceiling that can
 * be raised by one HTTP call is not a ceiling.
 */
oauthRoutes.post('/authorize/decision', async (c) => {
  const actor = requireUser(c);
  const input = await readJson(c, decisionSchema);

  const client = await loadClient(input.client_id);
  if (!client) throw badRequest('Unknown client');
  if (!client.redirectUris.includes(input.redirect_uri))
    throw badRequest('Unregistered redirect_uri');
  const redirect = assertRedirectUri(input.redirect_uri);

  if (!input.approve) {
    redirect.searchParams.set('error', 'access_denied');
    if (input.state) redirect.searchParams.set('state', input.state);
    return c.json({ redirectTo: redirect.toString() });
  }

  // Scoped to the caller, and 404 for anybody else's agent. The whole persona
  // model rests on `agents.owner_id` bounding what a token can reach, so an id
  // arriving in a request body is checked against the signed-in person before
  // it is written into a credential — never after.
  const agent = input.agentId ? await requireOwnLiveAgent(actor, input.agentId) : null;
  const voices = grantedVoices(
    // What the *person* ticked, not what the client asked for. A client cannot
    // request a voice: it has no way to know a persona exists until somebody
    // chooses one for it on this screen.
    input.voices?.map((voice) => VOICE_SCOPES[voice]).join(' '),
    agent !== null,
  );

  // Filtered, not stored verbatim: an unknown scope must never reach a grant,
  // and the string written here is the one the consent screen just displayed.
  const scope = grantedScopes(input.scope, voices);
  if (scope === null) throw badRequest('This client asked for scopes this server does not grant');

  const code = randomToken(32);
  await getDb()
    .insert(schema.oauthCodes)
    .values({
      codeHash: hashSecret(code),
      clientId: client.clientId,
      userId: actor.user.id,
      redirectUri: input.redirect_uri,
      codeChallenge: input.code_challenge,
      codeChallengeMethod: input.code_challenge_method,
      scope,
      agentId: agent?.id ?? null,
      agentBound: agent !== null,
      expiresAt: new Date(Date.now() + AUTH_CODE_TTL_MS),
    });

  await recordAudit(actor, 'oauth.authorize', 'oauth_client', client.clientId, {
    clientName: client.clientName,
    scope,
    ...(agent ? { agentId: agent.id } : {}),
  });

  redirect.searchParams.set('code', code);
  if (input.state) redirect.searchParams.set('state', input.state);
  return c.json({ redirectTo: redirect.toString() });
});

/** Details for the consent screen — never exposes anything secret. */
oauthRoutes.get('/client/:clientId', async (c) => {
  const actor = requireUser(c);
  const client = await loadClient(c.req.param('clientId'));
  if (!client) throw badRequest('Unknown client');
  return c.json({
    clientId: client.clientId,
    clientName: client.clientName,
    redirectUris: client.redirectUris,
    createdAt: client.createdAt.toISOString(),
    // The personas this person already owns, so the consent screen can offer one
    // rather than sending them away to make it first. Never the client's choice:
    // it is named on the screen, by the human, in front of the client's name.
    agents: (await listAgents(actor)).map((agent) => agentDto(agent)),
  });
});

/* --------------------------------- token --------------------------------- */

function tokenError(
  c: Context<AppEnv>,
  code: string,
  description: string,
  status: 400 | 401 = 400,
) {
  return c.json({ error: code, error_description: description }, status);
}

oauthRoutes.post('/token', async (c) => {
  // RFC 6749 §5.1 requires both on every token response, success or error: the
  // body carries live credentials and must not be written to a shared cache.
  // Hono composes the response after this handler returns, so setting them here
  // covers every exit below rather than each one remembering.
  c.header('cache-control', 'no-store');
  c.header('pragma', 'no-cache');

  const form = await c.req.parseBody().catch(() => null);
  if (!form) return tokenError(c, 'invalid_request', 'Expected a form-encoded body');

  const field = (name: string) => textValue(form[name]);
  const grantType = field('grant_type');
  const db = getDb();

  if (grantType === 'authorization_code') {
    const code = field('code');
    const verifier = field('code_verifier');
    const clientId = field('client_id');
    const redirectUri = field('redirect_uri');
    if (!code || !verifier || !clientId) {
      return tokenError(c, 'invalid_request', 'code, code_verifier and client_id are required');
    }

    const rows = await db
      .select()
      .from(schema.oauthCodes)
      .where(
        and(
          eq(schema.oauthCodes.codeHash, hashSecret(code)),
          isNull(schema.oauthCodes.consumedAt),
          gt(schema.oauthCodes.expiresAt, new Date()),
        ),
      )
      .limit(1);

    const authCode = rows[0];
    if (!authCode) return tokenError(c, 'invalid_grant', 'That code is not valid or has expired');

    /*
     * Burn the code before anything else can go wrong: a replayed code must
     * never mint a second token, even if the checks below then fail.
     *
     * `consumed_at IS NULL` belongs in this statement rather than only in the
     * SELECT above. Two redemptions arriving together both read an unconsumed
     * row and both reach this line; keyed on `id` alone, both succeed and the
     * code mints two grants, which is the one thing the paragraph above says it
     * must never do. PKCE narrows who can reach here — an attacker needs the
     * verifier too — but single-use is a property this code claims to have, and
     * a claim enforced by timing is not enforced.
     *
     * The burn and the mint share one transaction under the grant lock, for
     * the same reason the refresh grant takes it: `revokeGrant` burns every
     * outstanding code of the grant under that lock. Without it a code approved
     * just before a disconnect could still be redeemed after it — or be burned
     * here, lose the race to the revocation, and mint a live credential after
     * "disconnect" returned. A refusal below still commits the burn.
     */
    const outcome = await db.transaction(async (tx) => {
      await lockGrant(tx, authCode.userId, authCode.clientId);
      const burned = await tx
        .update(schema.oauthCodes)
        .set({ consumedAt: new Date() })
        .where(and(eq(schema.oauthCodes.id, authCode.id), isNull(schema.oauthCodes.consumedAt)))
        .returning({ id: schema.oauthCodes.id });

      if (burned.length === 0)
        return { ok: false, error: 'That code is not valid or has expired' } as const;
      if (authCode.clientId !== clientId)
        return { ok: false, error: 'client_id mismatch' } as const;
      if (redirectUri && authCode.redirectUri !== redirectUri) {
        return { ok: false, error: 'redirect_uri mismatch' } as const;
      }
      if (!verifyPkce(verifier, authCode.codeChallenge, authCode.codeChallengeMethod)) {
        return { ok: false, error: 'PKCE verification failed' } as const;
      }

      // Consented: this code was minted by the decision endpoint above, whose
      // consent screen names every scope it is about to grant.
      return {
        ok: true,
        tokens: await issueTokens(
          tx,
          authCode.userId,
          authCode.clientId,
          authCode.scope,
          true,
          authCode.agentId,
          authCode.agentBound,
        ),
      } as const;
    });

    if (!outcome.ok) return tokenError(c, 'invalid_grant', outcome.error);
    return c.json(outcome.tokens);
  }

  if (grantType === 'refresh_token') {
    const refreshToken = field('refresh_token');
    if (!refreshToken) return tokenError(c, 'invalid_request', 'refresh_token is required');

    // Joined to `users` and filtered on state for the same reason
    // `resolveBearerToken` is: without it a suspended account's client keeps
    // rotating indefinitely. Rotation writes a fresh row with a fresh
    // `created_at`, so the 30-day window below restarts on every refresh — a
    // credential that never expires as long as something keeps calling. The
    // access token it minted would no longer authenticate, but the grant would
    // stay alive waiting for the account to be reinstated, which is not what
    // suspending somebody means.
    const rows = await db
      .select({ token: schema.oauthTokens })
      .from(schema.oauthTokens)
      .innerJoin(schema.users, eq(schema.users.id, schema.oauthTokens.userId))
      .where(
        and(
          eq(schema.oauthTokens.refreshTokenHash, hashSecret(refreshToken)),
          isNull(schema.oauthTokens.revokedAt),
          // The refresh token outlives the access token but not forever; its
          // window is measured from when the row was created.
          gt(schema.oauthTokens.createdAt, new Date(Date.now() - REFRESH_TOKEN_TTL_MS)),
          eq(schema.users.state, 'active'),
          sql`omr_account_open(${schema.users.id})`,
        ),
      )
      .limit(1);

    const existing = rows[0]?.token;
    if (!existing) {
      /*
        A refresh token that matches nothing live may be one a rotation already
        retired. Presenting it again means two parties hold the same credential:
        the client it was issued to, and whoever copied it. Which of them is which
        cannot be told, so the whole family goes (RFC 9700 §4.14.2, OAuth 2.1
        §4.3.1). The retired hash is kept on the old row for this (`0087`).
      */
      const [replayed] = await db
        .select({ token: schema.oauthTokens })
        .from(schema.oauthTokens)
        .where(
          and(
            eq(schema.oauthTokens.previousRefreshHash, hashSecret(refreshToken)),
            gt(schema.oauthTokens.createdAt, new Date(Date.now() - REFRESH_TOKEN_TTL_MS)),
          ),
        )
        .limit(1);
      if (replayed) {
        const presented = field('client_id');
        // Same inertness as the mismatch refusal below: a client that is not the
        // holder must not be able to disconnect somebody else's grant.
        if (!presented || presented === replayed.token.clientId) {
          await revokeFamilyForReuse(
            db,
            replayed.token.userId,
            replayed.token.clientId,
            replayed.token.familyId,
          );
          return tokenError(
            c,
            'invalid_grant',
            'That refresh token has already been used, so this connection was closed. Authorize the app again.',
          );
        }
      }
      return tokenError(c, 'invalid_grant', 'That refresh token is not valid');
    }

    // Bind refreshes to the issuing client. Older integrations may omit the
    // parameter; log that compatibility case, and refuse a present mismatch
    // before touching the existing grant (DESIGN §21).
    const presentedClientId = field('client_id');
    if (presentedClientId && presentedClientId !== existing.clientId) {
      logger.warn(
        {
          requestId: c.get('requestId'),
          presentedClientId,
          grantClientId: existing.clientId,
        },
        'refresh token presented by a client it was not issued to',
      );
      return tokenError(c, 'invalid_grant', 'That refresh token was issued to a different client');
    }
    if (!presentedClientId) {
      logger.info(
        { requestId: c.get('requestId'), grantClientId: existing.clientId },
        'refresh grant omitted client_id',
      );
    }

    // Rotate refresh credentials atomically; leave the preceding access token
    // valid until its own expiry. Concurrent refreshes are arbitrated by the
    // guarded UPDATE, so only one successor can commit.
    const closedGrant = Symbol('closed-account-grant');
    const reusedGrant = Symbol('reused-refresh-token');
    const minted = await db.transaction(async (tx) => {
      // Serialised against `revokeGrant` on the same (user, client). Without
      // the lock a refresh that read the grant before a disconnect could still
      // insert a successor after it, and "disconnect" would leave one live
      // credential behind — the one the client is about to use.
      await lockGrant(tx, existing.userId, existing.clientId);
      // The lookup can precede a committed closure while waiting for the grant
      // lock. Hold account admission until rotation commits, then recheck using
      // a fresh statement snapshot. Closure never takes the grant lock, so this
      // grant -> admission order does not invert its admission/session locks.
      const fence = await tx.execute(
        sql`SELECT user_id FROM account_lifecycle_fences WHERE user_id=${existing.userId}::uuid FOR SHARE`,
      );
      if (!fence.rows.length) throw new Error('Account admission fence is missing');
      const lifecycle = await tx.execute<{ open: boolean }>(
        sql`SELECT omr_account_open(${existing.userId}::uuid) AS open`,
      );
      if (lifecycle.rows[0]?.open === false) return closedGrant;
      if (lifecycle.rows[0]?.open !== true) throw new Error('Account lifecycle check failed');
      const rotated = await tx
        .update(schema.oauthTokens)
        .set({ refreshTokenHash: null, previousRefreshHash: hashSecret(refreshToken) })
        .where(
          and(
            eq(schema.oauthTokens.id, existing.id),
            eq(schema.oauthTokens.refreshTokenHash, hashSecret(refreshToken)),
            isNull(schema.oauthTokens.revokedAt),
          ),
        )
        .returning({ id: schema.oauthTokens.id });

      if (rotated.length === 0) {
        // Somebody rotated it between our lookup and the grant lock: the same
        // credential presented twice. Under the lock we already hold.
        await revokeFamilyTokens(tx, existing.userId, existing.clientId, existing.familyId);
        return reusedGrant;
      }

      // The flag is carried forward, never re-derived. A grant made before
      // scopes were enforced refreshes into another unenforced grant; otherwise
      // it would silently become enforced — and lose `radars:manage` — within
      // the hour, which is the regression `scope_consented` exists to prevent,
      // arriving by a slower route.
      // The persona is carried forward with the scope and the consent flag, for
      // the same reason and with the same consequence if it were not: a refresh
      // would silently strip the identity off a live connection, and everything
      // it wrote afterwards would arrive unattributed with nothing to say why.
      return issueTokens(
        tx,
        existing.userId,
        existing.clientId,
        existing.scope,
        existing.scopeConsented,
        existing.agentId,
        existing.agentBound,
        existing.familyId,
      );
    });

    if (minted === closedGrant) {
      return tokenError(c, 'invalid_grant', 'That refresh token is not valid');
    }
    if (minted === reusedGrant) {
      return tokenError(
        c,
        'invalid_grant',
        'That refresh token has already been used, so this connection was closed. Authorize the app again.',
      );
    }

    return c.json(minted);
  }

  return tokenError(c, 'unsupported_grant_type', `grant_type "${grantType}" is not supported`);
});

/**
 * Burn every credential of one refresh-token family, with the grant lock held.
 *
 * A family is one authorization and everything rotated out of it (`0087`: the
 * code exchange starts a family, every refresh carries it forward). Reuse of a
 * retired token says that family's lineage leaked; it says nothing about a
 * newer authorization of the same client, so those rows are left alone — and so
 * are unredeemed codes, which belong to authorizations the person just made.
 * `revokeGrant` (disconnect) is user+client on purpose: it is the person closing
 * the whole connection, and takes the same lock.
 *
 * Returns how many rows it revoked; zero means the family was already dead.
 */
async function revokeFamilyTokens(
  tx: Pick<Db, 'update'>,
  userId: string,
  clientId: string,
  familyId: string,
): Promise<number> {
  const revoked = await tx
    .update(schema.oauthTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(schema.oauthTokens.familyId, familyId),
        eq(schema.oauthTokens.userId, userId),
        eq(schema.oauthTokens.clientId, clientId),
        isNull(schema.oauthTokens.revokedAt),
      ),
    )
    .returning({ id: schema.oauthTokens.id });
  return revoked.length;
}

async function revokeFamilyForReuse(
  db: Db,
  userId: string,
  clientId: string,
  familyId: string,
): Promise<void> {
  const revoked = await db.transaction(async (tx) => {
    // The same lock as rotation, code redemption and disconnect, so the family
    // cannot gain a live successor while it is being burned.
    await lockGrant(tx, userId, clientId);
    return revokeFamilyTokens(tx, userId, clientId, familyId);
  });
  // An already-dead family is a no-op: nothing to report, nothing else touched.
  if (revoked === 0) return;
  logger.warn({ clientId, familyId, tokens: revoked }, 'refresh token reuse: family revoked');
  await recordAudit(null, 'oauth.grant.reuse_revoke', 'oauth_client', null, {
    clientId,
    userId,
    familyId,
    tokens: revoked,
  });
}

/**
 * `dbc` is whichever handle the caller is working under — both grants now mint
 * inside a transaction under the grant lock. Typed structurally rather than as
 * `Db` so a drizzle transaction satisfies it; all it may do is insert the token
 * and mark the client used.
 */
async function issueTokens(
  dbc: Pick<Db, 'insert' | 'update'>,
  userId: string,
  clientId: string,
  scope: string,
  scopeConsented: boolean,
  agentId: string | null,
  agentBound = false,
  /** Carried forward by a refresh; absent for a code exchange, which starts a new family. */
  familyId?: string,
) {
  const accessToken = randomToken(32);
  const refreshToken = randomToken(32);

  await dbc.insert(schema.oauthTokens).values({
    accessTokenHash: hashSecret(accessToken),
    refreshTokenHash: hashSecret(refreshToken),
    clientId,
    userId,
    scope,
    scopeConsented,
    agentId,
    ...(familyId ? { familyId } : {}),
    agentBound: agentId !== null || agentBound,
    expiresAt: new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000),
  });

  // What keeps a registration from being swept as idle (0035). At most one
  // write an hour per client: a refresh is hourly, and the sweep counts in
  // months, so a finer clock would be writes that decide nothing.
  await dbc
    .update(schema.oauthClients)
    .set({ lastUsedAt: new Date() })
    .where(
      and(
        eq(schema.oauthClients.clientId, clientId),
        or(
          isNull(schema.oauthClients.lastUsedAt),
          lt(schema.oauthClients.lastUsedAt, new Date(Date.now() - 60 * 60 * 1000)),
        ),
      ),
    );

  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refreshToken,
    scope,
  };
}
