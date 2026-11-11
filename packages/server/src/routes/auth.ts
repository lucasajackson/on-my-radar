/** Sign-in: magic-link codes over email, plus OIDC SSO. */
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import {
  isBearerClient,
  LOGIN_CODE,
  normalizeEmail,
  requestCodeSchema,
  safeNextPath,
  updateProfileSchema,
  verifyCodeSchema,
  type UserDto,
} from '@onmyradar/contract';
import {
  claimInvites,
  ensureDefaultWorkspace,
  findOrCreateUser,
  findUserByEmail,
  touchLastSeen,
  type UserRow,
} from '../auth/accounts.js';
import { issueLoginCode, RateLimitedError, verifyLoginCode } from '../auth/codes.js';
import { randomToken, safeEqual, signFor } from '../auth/crypto.js';
import {
  buildAuthorizationRequest,
  exchangeCode,
  getEndpoints,
  OidcError,
  type OidcProfile,
} from '../auth/oidc.js';
import {
  clearSessionCookie,
  createSession,
  listSessions,
  revokeSession,
  revokeSessionFor,
  setSessionCookie,
} from '../auth/session.js';
import { getDb, schema } from '../db/client.js';
import { env, mailConfigured, oidcConfigured } from '../env.js';
import {
  ApiError,
  badRequest,
  clientIp,
  forbidden,
  notFound,
  readJson,
  tooManyRequests,
  type Ctx,
  unauthorized,
  type AppEnv,
} from '../http.js';
import { logger } from '../logger.js';
import { loginCodeMessage, sendMail } from '../services/mail.js';
import { networkOf } from '../services/public-request.js';
import { assertHumanDecision } from '../services/access.js';
import { recordAudit } from '../services/audit.js';
import { and, eq } from 'drizzle-orm';

export const authRoutes = new Hono<AppEnv>();

const OIDC_COOKIE = 'omr_oidc';

export function userDto(user: UserRow): UserDto {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl,
    state: user.state,
    isAdmin: user.isAdmin,
    theme: user.theme,
    createdAt: user.createdAt.toISOString(),
  };
}

/**
 * Only same-origin relative paths may be used as a post-login destination, and
 * never an auth path — see `safeNextPath`, which the SPA applies too. Both sides
 * must agree here: a target one accepts and the other does not is how a redirect
 * loop starts.
 */
function safeNext(next: string | undefined): string {
  return safeNextPath(next) ?? '/';
}

/** What the login screen needs to render itself. */
authRoutes.get('/config', async (c) => {
  const e = env();
  const endpoints = oidcConfigured(e) ? await getEndpoints() : null;
  return c.json({
    email: { enabled: true, delivers: mailConfigured(e) },
    oidc: { enabled: Boolean(endpoints), name: e.OIDC_PROVIDER_NAME },
  });
});

authRoutes.get('/session', (c) => {
  const actor = c.get('actor');
  if (!actor) return c.json({ user: null });
  void touchLastSeen(actor.user.id);
  return c.json({ user: userDto(actor.user) });
});

/*
 * The login challenge: a code signs in only the browser that asked for it.
 *
 * Without it, sign-in was open to login CSRF. An attacker requests a code for
 * their own address, then a page of theirs makes the victim's browser post
 * `{email, code}` to verify-code; the answer is a `Set-Cookie` for the
 * attacker's account, and everything the victim captures afterwards is filed
 * where the attacker can read it. The cross-site check in `csrf.ts` and the
 * JSON requirement in `readJson` each stop that page; this stops the attack
 * even if a browser sends neither header, because the victim's browser never
 * received the attacker's challenge.
 *
 * Stateless: the cookie names a random nonce, signed together with the address
 * it was issued for, in its own HMAC domain. Only the browser flow checks it —
 * a native client is handed a token in the body, never a cookie, so there is
 * nothing for another site to plant.
 */
const LOGIN_CHALLENGE_COOKIE = 'omr_login';

function challengeSignature(email: string, nonce: string): string {
  return signFor('login-challenge', `${normalizeEmail(email)}\n${nonce}`);
}

function setLoginChallenge(c: Ctx, email: string): void {
  const nonce = randomToken(16);
  setCookie(c, LOGIN_CHALLENGE_COOKIE, `${nonce}.${challengeSignature(email, nonce)}`, {
    httpOnly: true,
    secure: env().PUBLIC_URL.startsWith('https://'),
    sameSite: 'Lax',
    path: '/',
    maxAge: LOGIN_CODE.ttlSeconds,
  });
}

function hasLoginChallenge(c: Ctx, email: string): boolean {
  const raw = getCookie(c, LOGIN_CHALLENGE_COOKIE);
  const dot = raw?.indexOf('.') ?? -1;
  if (!raw || dot <= 0) return false;
  return safeEqual(raw.slice(dot + 1), challengeSignature(email, raw.slice(0, dot)));
}

/**
 * Always answers the same way whether or not the address has an account: the
 * response must not become an oracle for which addresses are registered.
 */
authRoutes.post('/request-code', async (c) => {
  const input = await readJson(c, requestCodeSchema);
  const ip = clientIp(c);

  let issued: { code: string; expiresAt: Date };
  try {
    issued = await issueLoginCode(input.email, ip, ip ? networkOf(ip) : null);
  } catch (err) {
    if (err instanceof RateLimitedError) {
      throw tooManyRequests(
        err.scope === 'network'
          ? 'Too many sign-in codes have been requested from your network. Try again later.'
          : 'Too many codes requested for that address. Try again in a few minutes.',
        err.retryAfterSeconds,
      );
    }
    throw err;
  }

  const message = loginCodeMessage(input.email, issued.code);
  try {
    await sendMail(message);
  } catch (err) {
    logger.error({ err }, 'sending login code failed');
    throw new ApiError(502, 'mail_failed', 'We could not send the code. Try again in a moment.');
  }

  setLoginChallenge(c, input.email);
  return c.json({
    status: 'sent',
    expiresAt: issued.expiresAt.toISOString(),
    // A dev instance with no mail provider would otherwise be unusable.
    ...(env().NODE_ENV !== 'production' && !mailConfigured(env()) ? { devCode: issued.code } : {}),
  });
});

authRoutes.post('/verify-code', async (c) => {
  const input = await readJson(c, verifyCodeSchema);
  const browser = !(input.client && isBearerClient(input.client));
  // Checked before the code, so a verification from the wrong browser burns
  // none of the address's five attempts and says nothing about the code.
  if (browser && !hasLoginChallenge(c, input.email)) {
    throw new ApiError(
      401,
      'login_challenge_missing',
      'Enter the code in the same browser you requested it from. Request a new code here if you need to.',
    );
  }
  const verifyIp = clientIp(c);
  let result;
  try {
    result = await verifyLoginCode(input.email, input.code, verifyIp ? networkOf(verifyIp) : null);
  } catch (err) {
    if (err instanceof RateLimitedError) {
      throw tooManyRequests(
        err.scope === 'network'
          ? 'Too many sign-in attempts from your network. Try again later.'
          : 'Too many incorrect codes for this address. Try again later.',
        err.retryAfterSeconds,
      );
    }
    throw err;
  }

  if (!result.ok) {
    const message =
      result.reason === 'too_many_attempts'
        ? 'Too many incorrect attempts. Request a new code.'
        : result.reason === 'not_found'
          ? 'That code has expired. Request a new one.'
          : 'That code is not right.';
    throw unauthorized(message);
  }

  const existed = await findUserByEmail(input.email);
  const { user, created } = await findOrCreateUser(input.email);

  if (created) {
    await recordAudit(null, 'user.signup', 'user', user.id, { via: 'email' });
  }
  await afterSignIn(user, created && !existed);

  const session = await createSession(user, {
    userAgent: c.req.header('user-agent') ?? null,
    ip: clientIp(c),
    ...(input.client ? { client: input.client } : {}),
    ...(input.label ? { label: input.label } : {}),
  });

  // A browser gets a cookie and never sees the token. Any other client gets the
  // token and never gets a cookie: handing a native or cross-origin client a
  // `Set-Cookie` it cannot store, alongside a token it can, would leave two
  // credentials for one session and no way to tell which one signed a request.
  if (!browser) {
    return c.json({
      user: userDto(user),
      next: safeNext(input.next),
      session: { token: session.token, expiresAt: session.expiresAt.toISOString() },
    });
  }

  // Spent: cleared before the session is set, so the session's `Set-Cookie`
  // is the last one a simple client reads.
  deleteCookie(c, LOGIN_CHALLENGE_COOKIE, { path: '/' });
  setSessionCookie(c, session.token);
  return c.json({ user: userDto(user), next: safeNext(input.next) });
});

/**
 * The devices signed in as you, and a way to sign one out.
 *
 * The web has never had this either; it becomes necessary rather than merely
 * nice the moment a credential lives somewhere a person cannot clear by
 * quitting the browser.
 */
authRoutes.get('/sessions', async (c) => {
  const actor = c.get('actor');
  if (!actor) throw unauthorized();
  assertHumanDecision(actor, 'Account settings and signed-in devices must be managed by you.');
  const sessions = await listSessions(actor.user.id);
  return c.json({
    sessions: sessions.map((s) => ({
      id: s.id,
      client: s.client,
      label: s.label,
      userAgent: s.userAgent,
      createdAt: s.createdAt.toISOString(),
      lastUsedAt: s.lastUsedAt.toISOString(),
      expiresAt: s.expiresAt.toISOString(),
      current: s.id === actor.sessionId,
    })),
  });
});

authRoutes.delete('/sessions/:id', async (c) => {
  const actor = c.get('actor');
  if (!actor) throw unauthorized();
  assertHumanDecision(actor, 'Account settings and signed-in devices must be managed by you.');
  const id = c.req.param('id');
  const removed = await revokeSessionFor(actor.user.id, id);
  if (!removed) throw notFound('Session not found');
  // Signing out the session you are using should also drop its cookie, so the
  // browser does not keep presenting a credential the server has forgotten.
  if (id === actor.sessionId) clearSessionCookie(c);
  return c.body(null, 204);
});

/** Work every successful sign-in does, regardless of which method was used. */
async function afterSignIn(user: UserRow, isNew: boolean): Promise<void> {
  await claimInvites(user);
  if (user.state === 'active') await ensureDefaultWorkspace(user);
  if (!isNew) void touchLastSeen(user.id);
}

authRoutes.post('/logout', async (c) => {
  const actor = c.get('actor');
  if (actor?.sessionId) await revokeSession(actor.sessionId);
  clearSessionCookie(c);
  return c.json({ ok: true });
});

authRoutes.patch('/profile', async (c) => {
  const actor = c.get('actor');
  if (!actor) throw unauthorized();
  assertHumanDecision(actor, 'Account settings and signed-in devices must be managed by you.');
  // Waitlisted people may set their name and theme in the waiting room; a
  // suspended account can still sign in (to be told it is suspended) but
  // changes nothing, its own profile included.
  if (actor.user.state === 'suspended') throw forbidden('This account has been suspended.');
  const input = await readJson(c, updateProfileSchema);
  const [updated] = await getDb()
    .update(schema.users)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.theme !== undefined ? { theme: input.theme } : {}),
      updatedAt: new Date(),
    })
    .where(eq(schema.users.id, actor.user.id))
    .returning();
  return c.json({ user: userDto(updated ?? actor.user) });
});

/* ---------------------------------- OIDC --------------------------------- */

interface OidcStateCookie {
  state: string;
  verifier: string;
  nonce: string;
  next: string;
  sig: string;
}

function sealOidcState(state: string, verifier: string, nonce: string, next: string): string {
  const sig = signFor('oidc-state', `${state}.${verifier}.${nonce}.${next}`);
  return Buffer.from(JSON.stringify({ state, verifier, nonce, next, sig }), 'utf8').toString(
    'base64url',
  );
}

function openOidcState(raw: string): OidcStateCookie | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as OidcStateCookie;
    if (!parsed.state || !parsed.verifier || !parsed.nonce || typeof parsed.sig !== 'string')
      return null;
    // The cookie is httpOnly, but signing it means a leaked or forged cookie
    // still cannot substitute an attacker's verifier for the user's.
    const expected = signFor(
      'oidc-state',
      `${parsed.state}.${parsed.verifier}.${parsed.nonce}.${parsed.next}`,
    );
    if (!safeEqual(parsed.sig, expected)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Who an SSO sign-in is. The identity (issuer, subject) is the key; the email
 * is only ever a way to *attach* a first identity to an account that has none,
 * and only when the IdP vouched for the address. Anything else that would end
 * with the SSO subject controlling an account it was not already linked to is
 * refused rather than resolved quietly.
 */
async function resolveOidcUser(
  profile: OidcProfile,
): Promise<{ user: UserRow; created: boolean } | { refusal: string }> {
  const db = getDb();
  const extras = { name: profile.name, avatarUrl: profile.avatarUrl };
  const sameIssuer = and(
    eq(schema.identities.provider, 'oidc'),
    eq(schema.identities.issuer, profile.issuer),
  );

  let [linked] = await db
    .select({ id: schema.identities.id, userId: schema.identities.userId })
    .from(schema.identities)
    .where(and(sameIssuer, eq(schema.identities.subject, profile.subject)))
    .limit(1);
  if (!linked && profile.legacySubject) {
    // A row written before ID tokens were verified is keyed by what userinfo
    // called the person. Find it, and re-key it to the token's subject so the
    // next sign-in is by the verified one. Never used to create an identity.
    [linked] = await db
      .select({ id: schema.identities.id, userId: schema.identities.userId })
      .from(schema.identities)
      .where(and(sameIssuer, eq(schema.identities.subject, profile.legacySubject)))
      .limit(1);
    if (linked) {
      try {
        await db
          .update(schema.identities)
          .set({ subject: profile.subject })
          .where(eq(schema.identities.id, linked.id));
      } catch (err) {
        // A concurrent sign-in re-keyed it first (unique violation); the row is
        // still the same person's, so this sign-in proceeds.
        logger.debug({ err }, 'oidc legacy identity re-key lost a race');
      }
    }
  }
  if (linked) {
    const [owner] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, linked.userId))
      .limit(1);
    if (owner) return findOrCreateUser(owner.email, extras);
  }

  const existing = await findUserByEmail(normalizeEmail(profile.email));
  if (existing) {
    const [other] = await db
      .select({ id: schema.identities.id })
      .from(schema.identities)
      .where(and(sameIssuer, eq(schema.identities.userId, existing.id)))
      .limit(1);
    if (other) {
      logger.warn(
        { userId: existing.id },
        'oidc sign-in refused: email belongs to another subject',
      );
      return {
        refusal:
          'That email address is already linked to a different SSO account, so this sign-in was refused.',
      };
    }
  }
  // `OIDC_TRUST_IDP_EMAIL` is the operator vouching for the address when the IdP
  // does not (some providers send no email_verified). It decides only this first
  // link/create, and the takeover refusal above has already run.
  if (!profile.emailVerified && !env().OIDC_TRUST_IDP_EMAIL) {
    logger.warn({ existing: Boolean(existing) }, 'oidc sign-in refused: email not verified');
    return {
      refusal:
        'Your SSO provider has not verified this email address, so we cannot sign you in with it. Sign in with an emailed code instead.',
    };
  }

  const result = await findOrCreateUser(profile.email, extras);
  await db
    .insert(schema.identities)
    .values({
      userId: result.user.id,
      provider: 'oidc',
      issuer: profile.issuer,
      subject: profile.subject,
    })
    .onConflictDoNothing();
  // A concurrent sign-in may have attached this subject elsewhere first.
  const [attached] = await db
    .select({ userId: schema.identities.userId })
    .from(schema.identities)
    .where(and(sameIssuer, eq(schema.identities.subject, profile.subject)))
    .limit(1);
  if (attached?.userId !== result.user.id) {
    return {
      refusal: 'That SSO account is linked to a different user, so this sign-in was refused.',
    };
  }
  return result;
}

authRoutes.get('/oidc/start', async (c) => {
  const request = await buildAuthorizationRequest();
  if (!request) throw badRequest('SSO is not configured on this server');

  const next = safeNext(c.req.query('next'));
  setCookie(
    c,
    OIDC_COOKIE,
    sealOidcState(request.state, request.codeVerifier, request.nonce, next),
    {
      httpOnly: true,
      secure: env().PUBLIC_URL.startsWith('https://'),
      sameSite: 'Lax',
      path: '/',
      maxAge: 10 * 60,
    },
  );
  return c.redirect(request.url);
});

authRoutes.get('/oidc/callback', async (c) => {
  const sealed = getCookie(c, OIDC_COOKIE);
  deleteCookie(c, OIDC_COOKIE, { path: '/' });

  const fail = (reason: string) => c.redirect(`/login?error=${encodeURIComponent(reason)}`);

  const providerError = c.req.query('error');
  if (providerError) return fail(c.req.query('error_description') ?? providerError);

  const stored = sealed ? openOidcState(sealed) : null;
  if (!stored) return fail('Your sign-in attempt expired. Try again.');

  const returnedState = c.req.query('state');
  const code = c.req.query('code');
  if (!code || !returnedState || !safeEqual(returnedState, stored.state)) {
    return fail('That sign-in response could not be verified. Try again.');
  }

  let profile;
  try {
    profile = await exchangeCode(code, stored.verifier, stored.nonce);
  } catch (err) {
    logger.warn({ err }, 'oidc code exchange failed');
    return fail(err instanceof OidcError ? err.message : 'SSO sign-in failed. Try again.');
  }

  const resolved = await resolveOidcUser(profile);
  if ('refusal' in resolved) return fail(resolved.refusal);
  const { user, created } = resolved;

  if (created) {
    await recordAudit(null, 'user.signup', 'user', user.id, { via: 'oidc' });
  }
  await afterSignIn(user, created);

  const { token } = await createSession(user, {
    userAgent: c.req.header('user-agent') ?? null,
    ip: clientIp(c),
  });
  setSessionCookie(c, token);
  return c.redirect(stored.next || '/');
});
