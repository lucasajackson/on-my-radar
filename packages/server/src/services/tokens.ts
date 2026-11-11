/** Personal access tokens — how a local agent authenticates to /mcp. */
import { and, desc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import {
  parseScopes,
  DEFAULT_TOKEN_EXPIRY_DAYS,
  DEFAULT_TOKEN_SCOPES,
  type ApiTokenDto,
  type CreateTokenInput,
  type OAuthGrantDto,
  type Voice,
} from '@onmyradar/contract';
import { REFRESH_TOKEN_TTL_MS } from '../auth/lifetimes.js';
import { getDb, schema, type Db } from '../db/client.js';
import { hashSecret, newApiToken, tokenPrefix } from '../auth/crypto.js';
import { notFound, type Actor } from '../http.js';
import { agentDto, requireOwnLiveAgent } from './agents.js';
import { recordAudit } from './audit.js';
import { assertHumanDecision } from './access.js';

type TokenRow = typeof schema.apiTokens.$inferSelect;
type AgentRow = typeof schema.agents.$inferSelect;

function toDto(row: TokenRow, agent: AgentRow | null = null): ApiTokenDto {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    // The persona and the grant travel with the token on this screen, because
    // "which of my connections can write under my name" is exactly the question
    // an agents screen exists to answer, and it is unanswerable from a list of
    // labels and prefixes.
    agent: agent ? agentDto(agent) : null,
    voices: row.agentId ? row.voiceGrants : [],
    defaultVoice: row.agentId ? row.defaultVoice : null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listTokens(actor: Actor): Promise<ApiTokenDto[]> {
  assertHumanDecision(actor, 'Manage access tokens in Settings → Connections while signed in.');
  const rows = await getDb()
    .select({ token: schema.apiTokens, agent: schema.agents })
    .from(schema.apiTokens)
    .leftJoin(schema.agents, eq(schema.agents.id, schema.apiTokens.agentId))
    .where(and(eq(schema.apiTokens.userId, actor.user.id), isNull(schema.apiTokens.revokedAt)))
    .orderBy(desc(schema.apiTokens.createdAt));
  return rows.map((row) => toDto(row.token, row.agent));
}

/**
 * The only moment the secret exists in plaintext anywhere.
 *
 * Scope selection is a human decision. Omission preserves ordinary radar
 * defaults; operator reporting requires explicit selection.
 *
 * The **voice** grant is different and does have a control, because it is not a
 * ceiling on access at all: it decides whose name appears on what the connection
 * writes, which is a thing a person can only mean deliberately.
 */
export async function createToken(actor: Actor, input: CreateTokenInput): Promise<ApiTokenDto> {
  assertHumanDecision(actor, 'Manage access tokens in Settings → Connections while signed in.');
  const token = newApiToken();
  // Omitted means the default lifetime; only an explicit null is "never".
  const days = input.expiresInDays === undefined ? DEFAULT_TOKEN_EXPIRY_DAYS : input.expiresInDays;
  const expiresAt = days ? new Date(Date.now() + days * 86_400_000) : null;

  /*
    The persona is looked up rather than taken on trust, and it is looked up
    **scoped to the caller**.

    `requireOwnLiveAgent` answers 404 for somebody else's agent id and 409 for a
    retired one. That check is the only thing standing between "an id in a
    request body" and "a principal stamped on everything this connection ever
    writes", so it lives on the service path where both transports inherit it
    rather than in the route that happens to be the only caller today.
  */
  const agent = input.agentId ? await requireOwnLiveAgent(actor, input.agentId) : null;

  /*
    The default flips to persona — but only for tokens minted from here on.

    Own-voice is the honest default: writing under the human's name is the more
    consequential of the two and should be the one somebody chose. Every row that
    existed before 0015 kept `['principal']` from the column DEFAULT, so nothing
    live changed behaviour and no row was rewritten to say a human consented to
    something they did not.

    With no persona attached there is nothing to speak as, so the grant collapses
    to `principal` whatever was asked for. That is the bound that makes the whole
    grant coherent: a voice is downstream of whether an identity exists at all.
  */
  const voiceGrants: Voice[] = agent ? (input.voices ?? ['persona']) : ['principal'];
  const defaultVoice: Voice = voiceGrants.includes('persona') ? 'persona' : 'principal';

  const [row] = await getDb()
    .insert(schema.apiTokens)
    .values({
      userId: actor.user.id,
      name: input.name,
      scope: parseScopes((input.scopes ?? DEFAULT_TOKEN_SCOPES).join(' ')).join(' '),
      prefix: tokenPrefix(token),
      tokenHash: hashSecret(token),
      agentId: agent?.id ?? null,
      agentBound: agent !== null,
      voiceGrants,
      defaultVoice,
      expiresAt,
    })
    .returning();
  if (!row) throw new Error('token insert returned no row');

  await recordAudit(actor, 'token.create', 'api_token', row.id, {
    name: input.name,
    ...(agent ? { agentId: agent.id, voices: voiceGrants } : {}),
  });
  return { ...toDto(row, agent), token };
}

export async function revokeToken(actor: Actor, tokenId: string): Promise<void> {
  assertHumanDecision(actor, 'Manage access tokens in Settings → Connections while signed in.');
  const result = await getDb()
    .update(schema.apiTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(schema.apiTokens.id, tokenId), eq(schema.apiTokens.userId, actor.user.id)))
    .returning({ id: schema.apiTokens.id });
  if (result.length === 0) throw notFound('Token not found');
  await recordAudit(actor, 'token.revoke', 'api_token', tokenId, {});
}

/* ------------------------------ OAuth grants ------------------------------ */
/*
 * A remote client (claude.ai, LM Studio, …) holds a *grant*: every
 * `oauth_tokens` row for one (user, client) pair. Rows rotate on refresh, so the
 * grant — not any row — is the thing a person means when they say
 * "disconnect". Until this existed a grant could not be revoked at all; the
 * only levers were suspending the account or rotating SESSION_SECRET, which
 * signs everybody out. With the Agent Repo holding every agent's prompt and
 * memory, a lost device's connector is worth more, so this came first.
 */

/**
 * Serialise refresh against revocation for one grant. Both take this
 * transaction-scoped advisory lock, so a refresh that read the grant before a
 * disconnect cannot insert a live successor after it.
 */
export async function lockGrant(
  tx: Pick<Db, 'execute'>,
  userId: string,
  clientId: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`oauth-grant:${userId}:${clientId}`}))`,
  );
}

/** Grants that can still act: a live access token, or a refresh token inside its window. */
/** `http://127.0.0.1:53682/callback` → `127.0.0.1:53682`; `cursor://auth` → `cursor:`. */
function redirectHost(uri: string): string {
  try {
    const url = new URL(uri);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.host : url.protocol;
  } catch {
    return uri.slice(0, 80);
  }
}

export async function listGrants(actor: Actor): Promise<OAuthGrantDto[]> {
  assertHumanDecision(actor, 'Manage connected apps in Settings while signed in.');
  const now = new Date();
  const rows = await getDb()
    .select({
      token: schema.oauthTokens,
      clientName: schema.oauthClients.clientName,
      registeredAt: schema.oauthClients.createdAt,
      redirectUris: schema.oauthClients.redirectUris,
      agent: schema.agents,
    })
    .from(schema.oauthTokens)
    .leftJoin(schema.oauthClients, eq(schema.oauthClients.clientId, schema.oauthTokens.clientId))
    .leftJoin(schema.agents, eq(schema.agents.id, schema.oauthTokens.agentId))
    .where(
      and(
        eq(schema.oauthTokens.userId, actor.user.id),
        isNull(schema.oauthTokens.revokedAt),
        or(
          gt(schema.oauthTokens.expiresAt, now),
          and(
            sql`${schema.oauthTokens.refreshTokenHash} IS NOT NULL`,
            gt(schema.oauthTokens.createdAt, new Date(now.getTime() - REFRESH_TOKEN_TTL_MS)),
          ),
        ),
      ),
    )
    .orderBy(desc(schema.oauthTokens.createdAt));
  const byClient = new Map<string, OAuthGrantDto>();
  for (const { token, clientName, registeredAt, redirectUris, agent } of rows) {
    const seen = byClient.get(token.clientId);
    const lastUsed = token.lastUsedAt?.toISOString() ?? null;
    // A refreshable row lapses a window after it was issued; the grant lapses with its latest.
    const lapses = (
      token.refreshTokenHash
        ? new Date(token.createdAt.getTime() + REFRESH_TOKEN_TTL_MS)
        : token.expiresAt
    ).toISOString();
    if (seen) {
      if (lapses > seen.lapsesAt) seen.lapsesAt = lapses;
      if (lastUsed && (!seen.lastUsedAt || lastUsed > seen.lastUsedAt)) seen.lastUsedAt = lastUsed;
      if (token.createdAt.toISOString() < seen.createdAt)
        seen.createdAt = token.createdAt.toISOString();
      continue;
    }
    byClient.set(token.clientId, {
      clientId: token.clientId,
      clientName,
      scopes: token.scopeConsented ? parseScopes(token.scope) : [...DEFAULT_TOKEN_SCOPES],
      agent: agent ? { id: agent.id, name: agent.name, handle: agent.slug } : null,
      lastUsedAt: lastUsed,
      createdAt: token.createdAt.toISOString(),
      lapsesAt: lapses,
      registeredAt: registeredAt?.toISOString() ?? null,
      redirectHosts: [...new Set((redirectUris ?? []).map(redirectHost))],
    });
  }
  return [...byClient.values()];
}

/**
 * Disconnect a remote client: every access and refresh token of this grant
 * stops working now. Human-only and session-only, like minting — a connection
 * that could revoke grants could revoke the person's other connections.
 * Re-authorizing afterwards is a fresh consent, which is the point.
 */
export async function revokeGrant(actor: Actor, clientId: string): Promise<number> {
  assertHumanDecision(actor, 'Disconnect apps in Settings while signed in.');
  const revoked = await getDb().transaction((tx) => revokeGrantRows(tx, actor.user.id, clientId));
  if (revoked === 0) throw notFound('No connected app with that id');
  await recordAudit(actor, 'oauth.grant.revoke', 'oauth_client', null, {
    clientId,
    tokens: revoked,
  });
  return revoked;
}

/**
 * The whole of a disconnect, for one (user, client) grant: under the grant lock, burn the
 * codes not yet redeemed and revoke every token. The owner's disconnect and an admin's
 * revoke both end here, so a refresh in flight meets the same lock either way.
 */
export async function revokeGrantRows(
  tx: Pick<Db, 'execute' | 'update'>,
  userId: string,
  clientId: string,
): Promise<number> {
  await lockGrant(tx, userId, clientId);
  // A consent approved in the last few minutes whose code has not been
  // redeemed yet is part of this grant too. Left alone, it would mint a fresh
  // credential after "disconnect" returned; the token endpoint redeems under
  // the same lock, so it sees this burn.
  await tx
    .update(schema.oauthCodes)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(schema.oauthCodes.userId, userId),
        eq(schema.oauthCodes.clientId, clientId),
        isNull(schema.oauthCodes.consumedAt),
      ),
    );
  const revoked = await tx
    .update(schema.oauthTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(schema.oauthTokens.userId, userId),
        eq(schema.oauthTokens.clientId, clientId),
        isNull(schema.oauthTokens.revokedAt),
      ),
    )
    .returning({ id: schema.oauthTokens.id });
  return revoked.length;
}

/**
 * Every credential that ran one agent stops working now: its personal access tokens, its
 * connected apps' tokens and any consent not yet redeemed, and its load sessions. If the agent
 * is limited to selected radars, also every credential that has loaded it (a person's own
 * sign-in, say): that connection is how the agent ran, and it carries the agent's limit, so
 * leaving it alive after the limit's record is gone would leave it wider than it was.
 *
 * Each OAuth grant is locked first, in a fixed order, so a refresh in flight cannot mint a
 * successor after this returns (the same rule as `revokeGrantRows`) and two revocations
 * cannot deadlock. Used when an agent is deleted and when an admin revokes it.
 */
export async function revokeAgentCredentials(
  tx: Pick<Db, 'execute' | 'select' | 'update' | 'delete'>,
  agentId: string,
): Promise<{ pats: number; oauth: number; connections: number }> {
  const now = new Date();
  // The agent row, locked before anything is read: a `load_agent` recording a new carrier
  // takes the same lock, so it lands either before this reads the carriers (and is revoked) or
  // after this commits (and, for a delete, finds no agent). NO KEY UPDATE rather than UPDATE:
  // a refresh in flight holds its grant lock and inserts a token that references the agent,
  // which an UPDATE lock would make wait on us while we wait on the grant lock.
  await tx.execute(sql`SELECT id FROM agents WHERE id = ${agentId}::uuid FOR NO KEY UPDATE`);
  const fenced = await tx
    .select({
      userId: schema.connectionAgentFences.userId,
      kind: schema.connectionAgentFences.connectionKind,
      id: schema.connectionAgentFences.connectionId,
    })
    .from(schema.connectionAgentFences)
    .innerJoin(schema.agents, eq(schema.agents.id, schema.connectionAgentFences.agentId))
    .where(
      and(
        eq(schema.connectionAgentFences.agentId, agentId),
        eq(schema.agents.radarScope, 'selected'),
      ),
    );
  const fencedGrants = fenced.filter((f) => f.kind === 'oauth');
  const fencedPats = fenced.filter((f) => f.kind === 'pat');

  const pairs = new Map<string, { userId: string; clientId: string }>();
  for (const row of [
    ...(await tx
      .select({ userId: schema.oauthTokens.userId, clientId: schema.oauthTokens.clientId })
      .from(schema.oauthTokens)
      .where(eq(schema.oauthTokens.agentId, agentId))),
    ...(await tx
      .select({ userId: schema.oauthCodes.userId, clientId: schema.oauthCodes.clientId })
      .from(schema.oauthCodes)
      .where(eq(schema.oauthCodes.agentId, agentId))),
    ...fencedGrants.map((f) => ({ userId: f.userId, clientId: f.id })),
  ])
    pairs.set(`${row.userId}:${row.clientId}`, row);
  for (const key of [...pairs.keys()].sort()) {
    const pair = pairs.get(key);
    if (pair) await lockGrant(tx, pair.userId, pair.clientId);
  }
  // Codes before tokens, as `revokeGrantRows` does: a redemption either finds its code burned
  // or has already committed its token, and the token update below then catches that too.
  await tx
    .update(schema.oauthCodes)
    .set({ consumedAt: now })
    .where(and(eq(schema.oauthCodes.agentId, agentId), isNull(schema.oauthCodes.consumedAt)));
  const pats = await tx
    .update(schema.apiTokens)
    .set({ revokedAt: now })
    .where(and(eq(schema.apiTokens.agentId, agentId), isNull(schema.apiTokens.revokedAt)))
    .returning({ id: schema.apiTokens.id });
  const oauth = await tx
    .update(schema.oauthTokens)
    .set({ revokedAt: now })
    .where(and(eq(schema.oauthTokens.agentId, agentId), isNull(schema.oauthTokens.revokedAt)))
    .returning({ id: schema.oauthTokens.id });
  let connections = 0;
  for (const grant of fencedGrants)
    if ((await revokeGrantRows(tx, grant.userId, grant.id)) > 0) connections += 1;
  for (const pat of fencedPats) {
    const revoked = await tx
      .update(schema.apiTokens)
      .set({ revokedAt: now })
      .where(
        and(
          sql`${schema.apiTokens.id}::text = ${pat.id}`,
          eq(schema.apiTokens.userId, pat.userId),
          isNull(schema.apiTokens.revokedAt),
        ),
      )
      .returning({ id: schema.apiTokens.id });
    connections += revoked.length;
  }
  await tx.delete(schema.repoAgentSessions).where(eq(schema.repoAgentSessions.agentId, agentId));
  return { pats: pats.length, oauth: oauth.length, connections };
}
