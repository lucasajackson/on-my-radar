import type {
  ArchitectureAdrDto,
  ArchitectureBoundaryDto,
  ArchitectureContractDto,
  ArchitectureDto,
  AnchorActionResult,
  CharterDiffDto,
  CharterLinkDto,
  CharterVersionsDto,
  RestoreCharterResult,
  WriteCharterResult,
} from '@onmyradar/contract';
import type {
  SupportRequestDto,
  SupportThreadDto,
  SupportRequestInput,
  SupportReplyInput,
  AgentSessionInventoryDto,
  BriefBindingRequest,
  BriefIndexEntryDto,
  CheckoutDto,
  ImportAgentInput,
  MemoryRevisionDto,
  OAuthGrantDto,
  CreateSubscriptionInput,
  SubscriptionDto,
  SubscriptionDeliveryDto,
} from '@onmyradar/contract';
/**
 * Typed fetch wrapper.
 *
 * Every response body is shaped by @onmyradar/contract, so this file only has to
 * deal with transport concerns: JSON encoding, the credentials cookie, and
 * turning the API's error envelope into a throwable the UI can render.
 */
import type {
  AdminAgentPageDto,
  AdminTokenDto,
  AdminTokenPageDto,
  AdminUserDto,
  AgentDto,
  ApiErrorDto,
  ApiTokenDto,
  McpAvailabilityDto,
  CreateIntegrationInput,
  CreateTokenInput,
  EnrolRadarInput,
  IntegrationDeliveriesDto,
  IntegrationDto,
  RotateIntegrationInput,
  BlipDto,
  CommentDto,
  DashboardQueryResultDto,
  FeedDto,
  FeedLookback,
  EmailCaptureIdentityDto,
  EmailDetailDto,
  RadarEmailCaptureDto,
  InvitePreviewDto,
  MemberDto,
  NotificationKind,
  NotificationBox,
  NotificationCountsDto,
  DecisionRequestDto,
  NotificationPageDto,
  NotificationSettingsDto,
  PageDto,
  RadarAgentDto,
  RadarDto,
  RadarNotifyLevel,
  SearchPersonDto,
  SearchResultDto,
  SmartFilter,
  TopicDto,
  TopicMemberDto,
  UserDto,
  Voice,
  WebhookDto,
  CreateBlipRequest,
  CreateRadarRequest,
  CreateRepoAgentRequest,
  CreateTopicRequest,
  CreateWebhookRequest,
  RememberRequest,
  UpdateBlipRequest,
  UpdateDashboardRequest,
  UpdateRadarRequest,
  SetAgentRadarsInput,
  UpdateRepoAgentRequest,
  UpdateBriefRequest,
  ActivityPageDto,
  AdminOverviewDto,
  AgentShareDto,
  ModelCatalogEntryDto,
  ModelCatalogEntryRequest,
  ProfileKey,
  SetProfileRequest,
  ShareAgentRequest,
  UpdateModelCatalogEntryRequest,
  UpdateShareRequest,
  UpdateTopicRequest,
  UpdateWebhookRequest,
} from '@onmyradar/contract';
import { apiUrl } from './config.js';
import { guards } from './response-guards';

/** `Retry-After` in whole seconds (the form this API sends), or undefined. */
function retryAfterOf(response: Response): number | undefined {
  const seconds = Number(response.headers.get('Retry-After'));
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly fields?: Record<string, string>,
    /** How long the server asked us to wait (`Retry-After`), when it did. */
    public readonly retryAfterSeconds?: number,
    /** On a 409 `stale_revision`: the blip as it stands now. */
    public readonly current?: BlipDto,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** The account exists but an admin has not let it in yet. */
  get isAwaitingApproval(): boolean {
    return this.code === 'awaiting_approval';
  }
}

/**
 * One path segment, encoded. Ids and slugs arrive from the URL a person followed
 * (`/radar/$radarId`, `/r/$slug`, `/repo/$agentId`), so a crafted link like
 * `/radar/..%2F..%2Fadmin%2Fusers` decoded to a path that walked out of its
 * resource and sent a same-origin GET somewhere else in the API.
 */
const seg = (value: string): string => encodeURIComponent(value);

/*
  No bearer branch. `setAuthToken` was never called: the SPA is same-origin and
  the session cookie does the work, and the native apps carry their own client.
  A credential slot nobody fills is only somewhere a token could one day be left
  where script can read it.
*/
/**
 * The error envelope, read field by field.
 *
 * It was cast to `ApiErrorDto` and then defended with optional chains the type
 * said were unnecessary — both halves of the same lie. A 502 from a proxy, or a
 * body with the wrong shape, is exactly what this path handles, so nothing about
 * the payload is assumed.
 */
function errorEnvelope(payload: unknown): Partial<ApiErrorDto['error']> {
  if (typeof payload !== 'object' || payload === null || !('error' in payload)) return {};
  const error: unknown = payload.error;
  if (typeof error !== 'object' || error === null) return {};
  const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
  const message =
    'message' in error && typeof error.message === 'string' ? error.message : undefined;
  const fields =
    'fields' in error && typeof error.fields === 'object' && error.fields !== null
      ? Object.fromEntries(
          Object.entries(error.fields).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        )
      : undefined;
  // Only a blip the editor can compare and resend from: a wrong shape here is a silent overwrite.
  const current =
    'current' in error &&
    typeof error.current === 'object' &&
    error.current !== null &&
    'revision' in error.current &&
    typeof error.current.revision === 'number' &&
    'body' in error.current &&
    typeof error.current.body === 'string'
      ? (error.current as BlipDto)
      : undefined;
  return {
    ...(code !== undefined ? { code } : {}),
    ...(message !== undefined ? { message } : {}),
    ...(fields !== undefined ? { fields } : {}),
    ...(current !== undefined ? { current } : {}),
  };
}

async function request<T>(path: string, init: Omit<RequestInit, 'headers'> = {}): Promise<T> {
  const response = await fetch(apiUrl(path), {
    ...init,
    // Harmless and correct in both modes: a cross-origin request will not carry
    // the cookie anyway, because the API never allows credentialed CORS.
    credentials: 'same-origin',
    // Built here and nowhere else. It used to spread a caller's `HeadersInit`
    // into an object literal, which is only right for one of its three shapes —
    // a `Headers` instance spreads to nothing and a tuple array to `{0: …}`.
    headers: init.body
      ? { accept: 'application/json', 'content-type': 'application/json' }
      : { accept: 'application/json' },
  });

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    // Proxies can return an HTML error page. Keep the HTTP status useful to
    // callers without exposing that page or a JSON parser error to the user.
    if (response.ok) {
      throw new ApiError(
        response.status,
        'invalid_response',
        'The server returned an invalid response. Please try again.',
      );
    }
  }

  if (!response.ok) {
    const envelope = errorEnvelope(payload);
    throw new ApiError(
      response.status,
      envelope.code ?? 'http_error',
      envelope.message ?? `Request failed (${response.status}). Please try again.`,
      envelope.fields,
      retryAfterOf(response),
      envelope.current,
    );
  }
  return payload as T;
}

/*
  Trust at the transport boundary. `request<T>` believes the body is a T: the
  types are shared with the server through the contract, and a wrong shape in
  something displayed renders wrong until a reload. Responses whose fields the
  SPA sends back (revisions, prompt versions, cursors) go through `checked`
  instead, because a wrong shape there is a silent overwrite, not a wrong
  pixel. `lib/response-guards.ts` says which fields and why.
*/
async function checked<T>(
  response: Promise<unknown>,
  guard: (body: unknown) => body is T,
): Promise<T> {
  const body = await response;
  if (guard(body)) return body;
  throw new ApiError(
    0,
    'unexpected_response',
    'The server sent something this page does not recognise, so nothing was saved. Reload and try again.',
  );
}

const get = <T>(path: string) => request<T>(path);
const post = <T>(path: string, body?: unknown) =>
  request<T>(path, {
    method: 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const patch = <T>(path: string, body: unknown) =>
  request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
const put = <T>(path: string, body: unknown) =>
  request<T>(path, { method: 'PUT', body: JSON.stringify(body) });
const del = <T = void>(path: string) => request<T>(path, { method: 'DELETE' });

/**
 * The consent decision, mirroring the server's `decisionSchema` (which lives in
 * `routes/oauth.ts`, not the contract). Typed so a misspelt OAuth field fails to
 * compile rather than failing consent at runtime.
 */
export interface OAuthDecisionInput {
  client_id: string;
  redirect_uri: string;
  response_type: 'code';
  code_challenge: string;
  code_challenge_method: string;
  state?: string | undefined;
  scope?: string | undefined;
  approve: boolean;
  agentId?: string;
  voices?: Voice[];
}

export interface AuthConfig {
  email: { enabled: boolean; delivers: boolean };
  oidc: { enabled: boolean; name: string };
  /** Absent from a server older than self-host sign-in. */
  password?: { enabled: boolean };
  singleUser?: boolean;
}

/**
 * Query-string parameters. `undefined` is written out on purpose: a caller
 * forwards a filter that may be unset, and `queryString` leaves an undefined
 * field out of the URL — absent and undefined mean the same thing here.
 */
export type BlipQuery = {
  updatedSince?: string | undefined;
  sort?: 'updated' | undefined;
  q?: string | undefined;
  tag?: string | undefined;
  state?: string | undefined;
  kind?: string | undefined;
  /** The radar template's own lane. */
  status?: string | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
};

export interface Facets {
  tags: Array<{ tag: string; count: number }>;
  states: Record<string, number>;
  /** What each lane holds now. Live only, like every other count on this object. */
  statuses: Record<string, number>;
  /**
   * What has aged out of each lane. The other half of `12 · 34 archived`, and
   * the reason it is served rather than inferred: the client cannot know what it
   * was not sent.
   */
  archivedStatuses: Record<string, number>;
}

/** Scalars only: an object here would be sent as "[object Object]". */
function queryString(
  query: Readonly<Record<string, string | number | boolean | null | undefined>>,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : '';
}

/** The search box and page cursor of an admin inventory, as a query string. */
function inventoryQuery(query: { q?: string; cursor?: string }): string {
  const qs = new URLSearchParams();
  if (query.q?.trim()) qs.set('q', query.q.trim());
  if (query.cursor) qs.set('cursor', query.cursor);
  const text = qs.toString();
  return text ? `?${text}` : '';
}

/** A passage to tie to a boundary or contract: the words, and the element (or a new one to make with it). */
export interface LinkCharterInput {
  quote: string;
  prefix?: string | undefined;
  suffix?: string | undefined;
  element:
    | string
    | { kind: 'boundary'; title: string }
    | { kind: 'contract'; title: string; a: string; b: string };
  idempotencyKey?: string;
}

/** The passage that was tied, and the element it points at (`created` when the same call made it). */
export interface LinkCharterResult {
  link: CharterLinkDto;
  element: { id: string; title: string; kind: 'boundary' | 'contract'; created: boolean };
}

/** New words for an anchor; `prefix` and `suffix` pick them when the charter holds them twice. */
export interface ReanchorInput {
  quote: string;
  prefix?: string | undefined;
  suffix?: string | undefined;
  idempotencyKey?: string;
}

export const api = {
  /** Anchors: the charter passages an ADR amends or a boundary or contract is linked to. */
  anchors: {
    reanchor: (id: string, input: ReanchorInput) =>
      post<AnchorActionResult>(`/api/anchors/${seg(id)}/reanchor`, input),
    /** Lets an orphaned amendment go (the ADR stands free), or unlinks a link. */
    dismiss: (id: string, input: { idempotencyKey?: string } = {}) =>
      post<AnchorActionResult>(`/api/anchors/${seg(id)}/dismiss`, input),
  },
  guestSupportStaff: {
    revoke: (id: string) =>
      request<{ revoked: true }>(`/api/guest-support/requests/${seg(id)}/revoke`, {
        method: 'POST',
        body: '{}',
      }),
  },
  support: {
    list: (after?: string) =>
      request<{ requests: SupportRequestDto[]; next: string | null }>(
        `/api/support${after ? `?after=${after}` : ''}`,
      ),
    get: (id: string, after?: string) =>
      request<SupportThreadDto>(`/api/support/${id}${after ? `?after=${after}` : ''}`),
    create: (input: SupportRequestInput) =>
      request<{ request: SupportRequestDto }>('/api/support', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    reply: (id: string, input: SupportReplyInput) =>
      request<SupportThreadDto>(`/api/support/${id}/replies`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
  },
  subscriptions: {
    list: (radarId: string) =>
      request<{ subscriptions: SubscriptionDto[] }>(`/api/radars/${seg(radarId)}/subscriptions`),
    create: (radarId: string, input: CreateSubscriptionInput) =>
      request<{ subscription: SubscriptionDto }>(`/api/radars/${seg(radarId)}/subscriptions`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    update: (radarId: string, id: string, enabled: boolean) =>
      request<{ subscription: SubscriptionDto }>(
        `/api/radars/${seg(radarId)}/subscriptions/${seg(id)}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ enabled }),
        },
      ),
    remove: (radarId: string, id: string) =>
      request<undefined>(`/api/radars/${seg(radarId)}/subscriptions/${seg(id)}`, {
        method: 'DELETE',
      }),
    rotate: (radarId: string, id: string) =>
      request<{ subscription: SubscriptionDto }>(
        `/api/radars/${seg(radarId)}/subscriptions/${seg(id)}/rotate`,
        {
          method: 'POST',
        },
      ),
    test: (radarId: string, id: string) =>
      request<{ queued: boolean }>(`/api/radars/${seg(radarId)}/subscriptions/${seg(id)}/test`, {
        method: 'POST',
      }),
    deliveries: (radarId: string, id: string) =>
      request<{ deliveries: SubscriptionDeliveryDto[] }>(
        `/api/radars/${seg(radarId)}/subscriptions/${seg(id)}/deliveries`,
      ),
  },
  auth: {
    config: () => get<AuthConfig>('/api/auth/config'),
    session: () => get<{ user: UserDto | null }>('/api/auth/session'),
    requestCode: (email: string) =>
      post<{ status: string; expiresAt: string; devCode?: string }>('/api/auth/request-code', {
        email,
      }),
    verifyCode: (email: string, code: string, next?: string) =>
      post<{ user: UserDto; next: string }>('/api/auth/verify-code', { email, code, next }),
    passwordLogin: (email: string, password: string, next?: string) =>
      post<{ user: UserDto; next: string }>('/api/auth/password/login', { email, password, next }),
    resetPassword: (email: string, code: string, password: string, next?: string) =>
      post<{ user: UserDto; next: string }>('/api/auth/password/reset', {
        email,
        code,
        password,
        next,
      }),
    setPassword: (input: { password: string; currentPassword?: string; code?: string }) =>
      put<{ ok: true }>('/api/auth/password', input),
    logout: () => post<{ ok: true }>('/api/auth/logout'),
    updateProfile: (input: { name?: string | null; theme?: 'system' | 'light' | 'dark' }) =>
      patch<{ user: UserDto }>('/api/auth/profile', input),
  },

  /**
   * Resolving an invitation link. Deliberately unauthenticated on both sides —
   * the person holding the link is exactly the person who has no session yet.
   */
  invites: {
    resolve: (token: string) =>
      get<{ invite: InvitePreviewDto }>(`/api/invites/${encodeURIComponent(token)}`),
  },

  radars: {
    list: (includeArchived = false) =>
      get<{ radars: RadarDto[] }>(`/api/radars${includeArchived ? '?archived=true' : ''}`),
    get: (id: string) => get<{ radar: RadarDto }>(`/api/radars/${seg(id)}`),
    create: (input: CreateRadarRequest) => post<{ radar: RadarDto }>('/api/radars', input),
    createSmart: (input: { name: string; filter: SmartFilter } & Record<string, unknown>) =>
      post<{ radar: RadarDto }>('/api/radars/smart', input),
    /** Created on first ask; safe to call whenever the drop box is needed. */
    dropBox: () => get<{ radar: RadarDto }>('/api/radars/drop-box'),
    update: (id: string, input: UpdateRadarRequest) =>
      patch<{ radar: RadarDto }>(`/api/radars/${seg(id)}`, input),
    remove: (id: string) => del(`/api/radars/${seg(id)}`),
    setVisibility: (id: string, visibility: 'private' | 'public', allowIndex?: boolean) =>
      put<{ radar: RadarDto }>(`/api/radars/${seg(id)}/visibility`, { visibility, allowIndex }),
    rotateLink: (id: string) => post<{ radar: RadarDto }>(`/api/radars/${seg(id)}/rotate-link`),
    members: (id: string) =>
      // Two lists, deliberately: people hold grants and can be shared with;
      // agents are a computed overlay on their owners' and can only be addressed.
      get<{ members: MemberDto[]; agents: RadarAgentDto[] }>(`/api/radars/${seg(id)}/members`),
    share: (id: string, email: string, role: string) =>
      post<{
        share: { status: string; email: string; approved: boolean; inviteUrl: string | null };
      }>(`/api/radars/${seg(id)}/members`, { email, role }),
    removeMember: (id: string, userId: string) =>
      del(`/api/radars/${seg(id)}/members/${seg(userId)}`),
    revokeInvite: (id: string, email: string) =>
      del(`/api/radars/${seg(id)}/invites?email=${encodeURIComponent(email)}`),
    facets: (id: string) => get<Facets>(`/api/radars/${seg(id)}/facets`),
    /** How loud this radar is for *you*. Read access is enough — it is your attention. */
    setNotifyLevel: (id: string, level: RadarNotifyLevel) =>
      put<{ radarId: string; level: RadarNotifyLevel }>(`/api/radars/${seg(id)}/notify-level`, {
        level,
      }),
    webhooks: (id: string) => get<{ webhooks: WebhookDto[] }>(`/api/radars/${seg(id)}/webhooks`),
    /** The only response that ever contains the ingest URL with its token. */
    createWebhook: (id: string, input: CreateWebhookRequest) =>
      post<{ webhook: WebhookDto }>(`/api/radars/${seg(id)}/webhooks`, input),
    blips: (id: string, query: BlipQuery = {}) =>
      get<PageDto<BlipDto>>(`/api/radars/${seg(id)}/blips${queryString(query)}`),
    createBlip: (id: string, input: CreateBlipRequest) =>
      post<{ blip: BlipDto }>(`/api/radars/${seg(id)}/blips`, input),
    /**
     * Charter and ADR index. `source` keeps the markers so the page can draw both views; `written`
     * is the charter's stored text exactly, which is what the editor opens on and saves back.
     */
    architecture: (id: string, edit?: string, view: 'source' | 'written' = 'source') =>
      get<ArchitectureDto>(
        `/api/radars/${seg(id)}/architecture?view=${view}${edit ? `&edit=${encodeURIComponent(edit)}` : ''}`,
      ),
    /** The charter as it was at a sealed version (members only: a public reader gets 404). */
    architectureAt: (id: string, version: number, anchor?: string) =>
      get<ArchitectureDto>(
        `/api/radars/${seg(id)}/architecture?view=source&version=${version}${anchor ? `&anchor=${encodeURIComponent(anchor)}` : ''}`,
      ),
    /** Sealed versions, newest first; `before` is the `nextCursor` of the page already read. */
    charterVersions: (id: string, before?: number) =>
      get<CharterVersionsDto>(
        `/api/radars/${seg(id)}/charter/versions${before ? `?before=${before}` : ''}`,
      ),
    /** Struck and inserted ranges between two versions (`head` is the text as it is now). */
    charterDiff: (id: string, from: number | 'head', to: number | 'head') =>
      get<CharterDiffDto>(`/api/radars/${seg(id)}/charter/diff?from=${from}&to=${to}`),
    /** Put a version's text back as a new version; nothing in history changes. */
    restoreCharter: (id: string, version: number, baseRevision: number) =>
      post<RestoreCharterResult>(`/api/radars/${seg(id)}/charter/versions/${version}/restore`, {
        baseRevision,
      }),
    proposeAdr: (
      id: string,
      input: {
        title: string;
        rationale: string;
        anchors: Array<{
          quote: string;
          with: string;
          /** The words around the quote, to tell it from a twin elsewhere in the charter. */
          prefix?: string;
          suffix?: string;
        }>;
        supersedes?: string;
      },
    ) => post<{ adr: ArchitectureAdrDto }>(`/api/radars/${seg(id)}/adrs`, input),
    /**
     * Replace the whole charter. `baseRevision` is the revision the text was read at: a save from
     * an older one is a 409 `stale`. Never refused for an anchor; what it orphaned comes back.
     */
    writeCharter: (
      id: string,
      input: { markdown: string; baseRevision: number; note?: string; checkpoint?: boolean },
    ) => put<WriteCharterResult>(`/api/radars/${seg(id)}/charter`, input),
    /** Ties a passage of the charter to a boundary or contract (made in the same call, if new). */
    linkCharter: (id: string, input: LinkCharterInput) =>
      post<LinkCharterResult>(`/api/radars/${seg(id)}/charter/links`, input),
    upsertBoundary: (
      id: string,
      input: {
        id?: string;
        title: string;
        external: boolean;
        owns: string[];
        body?: string;
        expectedUpdatedAt?: string;
      },
    ) =>
      post<{ boundary: ArchitectureBoundaryDto; created: boolean }>(
        `/api/radars/${seg(id)}/boundaries`,
        input,
      ),
    upsertContract: (
      id: string,
      input: {
        id?: string;
        title: string;
        version?: string;
        body?: string;
        a: string;
        b: string;
        expectedUpdatedAt?: string;
      },
    ) =>
      post<{ contract: ArchitectureContractDto; created: boolean }>(
        `/api/radars/${seg(id)}/contracts`,
        input,
      ),
    uploadTicket: (id: string, input: { filename: string; contentType: string; size: number }) =>
      post<{
        ticket: { key: string; url: string; method: string; headers: Record<string, string> };
      }>(`/api/radars/${seg(id)}/uploads`, input),
    /** Move a radar into a topic, or out of every topic with `null`. */
    setTopic: (id: string, topicId: string | null) =>
      put<{ radarId: string; topicId: string | null }>(`/api/radars/${seg(id)}/topic`, { topicId }),
  },

  topics: {
    list: (includeArchived = false) =>
      get<{ topics: TopicDto[] }>(`/api/topics${includeArchived ? '?archived=true' : ''}`),
    /** The topic plus the radars in it **the caller can read** — never the rest. */
    get: (id: string) => get<{ topic: TopicDto; radars: RadarDto[] }>(`/api/topics/${seg(id)}`),
    create: (input: CreateTopicRequest) => post<{ topic: TopicDto }>('/api/topics', input),
    update: (id: string, input: UpdateTopicRequest) =>
      patch<{ topic: TopicDto }>(`/api/topics/${seg(id)}`, input),
    remove: (id: string) => del<{ radarsFreed: number }>(`/api/topics/${seg(id)}`),
    /**
     * Its own call, not a field on `update`. Flipping this converts every topic
     * membership into access to every radar in the topic — the widest access
     * change in the app — so it never rides along in a patch.
     */
    setCascade: (id: string, cascade: boolean) =>
      put<{ topic: TopicDto }>(`/api/topics/${seg(id)}/cascade`, { cascade }),
    members: (id: string) => get<{ members: TopicMemberDto[] }>(`/api/topics/${seg(id)}/members`),
    share: (id: string, email: string, role: string) =>
      post<{ status: string; email: string; role: string; radarsGranted: number }>(
        `/api/topics/${seg(id)}/members`,
        { email, role },
      ),
    removeMember: (id: string, userId: string) =>
      del(`/api/topics/${seg(id)}/members/${seg(userId)}`),
    revokeInvite: (id: string, email: string) =>
      del(`/api/topics/${seg(id)}/invites?email=${encodeURIComponent(email)}`),
  },

  webhooks: {
    update: (id: string, input: UpdateWebhookRequest) =>
      patch<{ webhook: WebhookDto }>(`/api/webhooks/${seg(id)}`, input),
    rotate: (id: string) => post<{ webhook: WebhookDto }>(`/api/webhooks/${seg(id)}/rotate`),
    remove: (id: string) => del(`/api/webhooks/${seg(id)}`),
  },

  /**
   * Universal search uses the shared grammar for words and filters. An optional
   * exact radar scope also supports smart radars without rewriting the query.
   * Preview callers limit the page and cancel requests as the draft changes.
   */
  search: {
    run: (
      q: string,
      cursor?: string,
      options: {
        radarId?: string | undefined;
        preferRadarId?: string | undefined;
        limit?: number | undefined;
        signal?: AbortSignal | undefined;
      } = {},
    ) =>
      request<SearchResultDto>(
        `/api/search${queryString({ q, cursor, radarId: options.radarId, preferRadarId: options.preferRadarId, limit: options.limit })}`,
        options.signal ? { signal: options.signal } : {},
      ),
    /** What `in:`, `topic:` and `from:` may legally complete to, plus the corpus size. */
    suggest: () =>
      get<{
        radars: Array<{ id: string; name: string; slug: string }>;
        people: SearchPersonDto[];
        topics: Array<{ id: string; name: string; slug: string }>;
        corpus: { radars: number; blips: number };
      }>('/api/search/suggest'),
  },

  blips: {
    get: (id: string) => get<{ blip: BlipDto }>(`/api/blips/${seg(id)}`),
    decide: (id: string, decision: 'accept' | 'reject' | 'repeal') =>
      post<{ filed: string[] }>(`/api/blips/${seg(id)}/decide`, { decision }),
    reminder: (id: string) =>
      get<{ reminder: BlipDto['reminder'] }>(`/api/blips/${seg(id)}/reminder`),
    setReminder: (id: string, leadMinutes: 0 | 60 | 1440) =>
      put<{ reminder: BlipDto['reminder'] }>(`/api/blips/${seg(id)}/reminder`, { leadMinutes }),
    removeReminder: (id: string) => del(`/api/blips/${seg(id)}/reminder`),

    email: (id: string, images = false) =>
      get<{ email: EmailDetailDto }>(`/api/blips/${seg(id)}/email${images ? '?images=1' : ''}`),
    search: (query: BlipQuery) => get<PageDto<BlipDto>>(`/api/blips${queryString(query)}`),
    tags: () => get<{ tags: Array<{ tag: string; count: number }> }>('/api/blips/tags'),
    update: (id: string, input: UpdateBlipRequest) =>
      patch<{ blip: BlipDto }>(`/api/blips/${seg(id)}`, input),
    remove: (id: string) => del(`/api/blips/${seg(id)}`),
    comments: (id: string, cursor?: string) =>
      get<PageDto<CommentDto>>(
        `/api/blips/${seg(id)}/comments${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
      ),
    comment: (
      id: string,
      body: string,
      parentId?: string,
      /** Only ever sent as `client`, and only from a helpdesk's composer. */
      visibility?: 'internal' | 'client',
    ) =>
      post<{ comment: CommentDto }>(`/api/blips/${seg(id)}/comments`, {
        body,
        ...(parentId ? { parentId } : {}),
        ...(visibility === 'client' ? { visibility } : {}),
      }),
    /** One idempotent toggle; the response carries the blip's whole tally back. */
    react: (id: string, reaction: string) =>
      post<{ blipId: string; reacted: boolean; reactions: BlipDto['reactions'] }>(
        `/api/blips/${seg(id)}/reactions`,
        { reaction },
      ),
  },

  decisions: {
    list: (blipId: string) =>
      get<{ requests: DecisionRequestDto[] }>(`/api/blips/${seg(blipId)}/decisions`),
    answer: (blipId: string, requestId: string, answer: string) =>
      post<{ request: DecisionRequestDto }>(
        `/api/blips/${seg(blipId)}/decisions/${seg(requestId)}/answer`,
        { answer },
      ),
  },

  comments: {
    update: (id: string, body: string) =>
      patch<{ comment: CommentDto }>(`/api/comments/${seg(id)}`, { body }),
    remove: (id: string) => del(`/api/comments/${seg(id)}`),
    /** Release a pending reply to the client: the hash of exactly what was read. */
    release: (id: string, bodySha256: string) =>
      post<{ comment: CommentDto }>(`/api/comments/${seg(id)}/release`, { bodySha256 }),
  },

  notifications: {
    list: (
      query: {
        unreadOnly?: boolean | undefined;
        radarId?: string | undefined;
        box?: NotificationBox | undefined;
        cursor?: string | undefined;
        limit?: number | undefined;
      } = {},
    ) => get<NotificationPageDto>(`/api/notifications${queryString(query)}`),
    /** Everything the shell's badges need, in one call. Polled. */
    counts: (box?: NotificationBox) =>
      get<NotificationCountsDto>(`/api/notifications/counts${queryString({ box })}`),
    markRead: (input: { ids?: string[]; radarId?: string; all?: true; read?: boolean }) =>
      post<{ updated: number }>('/api/notifications/read', input),
    /** Seen is not read: this stops the ping, the badge keeps its count. */
    markSeen: () => post<{ updated: number }>('/api/notifications/seen'),
    /**
     * `endpoint` is this browser's own push subscription, if it has one — the
     * server cannot tell which device it is talking to any other way.
     */
    settings: async (endpoint?: string) => {
      const hash = endpoint
        ? Array.from(
            new Uint8Array(
              await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint)),
            ),
            (byte) => byte.toString(16).padStart(2, '0'),
          ).join('')
        : null;
      return get<NotificationSettingsDto>(
        `/api/notifications/settings${hash ? `?endpointHash=${hash}` : ''}`,
      );
    },
    updateSettings: (input: {
      emailEnabled?: boolean;
      pushEnabled?: boolean;
      previewEnabled?: boolean;
      kindPreferences?: Partial<Record<NotificationKind, { email?: boolean; push?: boolean }>>;
    }) => patch<NotificationSettingsDto>('/api/notifications/settings', input),
    subscribePush: (subscription: unknown, label?: string, rebindExisting?: boolean) =>
      post<{ id: string }>('/api/notifications/push', {
        ...(subscription as object),
        label,
        ...(rebindExisting ? { rebindExisting: true } : {}),
      }),
    removeDevice: (id: string) => del(`/api/notifications/push/${seg(id)}`),
    unsubscribePush: (endpoint: string) =>
      post<undefined>('/api/notifications/push/unsubscribe', { endpoint }),
  },

  emailCapture: {
    identity: () => get<EmailCaptureIdentityDto>('/api/email-capture'),
    claim: (username: string) => put<EmailCaptureIdentityDto>('/api/email-capture', { username }),
    radar: (radarId: string) =>
      get<RadarEmailCaptureDto>(`/api/radars/${seg(radarId)}/email-capture`),
    updateRadar: (radarId: string, input: { enabled: boolean; allowedSenders: string[] }) =>
      put<RadarEmailCaptureDto>(`/api/radars/${seg(radarId)}/email-capture`, input),
  },

  feeds: {
    list: (radarId: string) => get<{ feeds: FeedDto[] }>(`/api/radars/${seg(radarId)}/feeds`),
    create: (radarId: string, input: { url: string; lookback: FeedLookback }) =>
      post<{ feed: FeedDto }>(`/api/radars/${seg(radarId)}/feeds`, input),
    update: (
      radarId: string,
      feedId: string,
      input: { enabled?: boolean; lookback?: FeedLookback },
    ) => patch<{ feed: FeedDto }>(`/api/radars/${seg(radarId)}/feeds/${seg(feedId)}`, input),
    remove: (radarId: string, feedId: string) =>
      del(`/api/radars/${seg(radarId)}/feeds/${seg(feedId)}`),
  },

  dashboards: {
    list: () => checked(get<unknown>('/api/dashboards'), guards.dashboards),
    preview: (
      query: string,
      limit = 12,
      options: {
        display?: 'list' | 'count' | 'lanes' | 'activity';
        groupByRadar?: boolean;
        activityDays?: 7 | 30 | 90;
      } = {},
    ) => post<DashboardQueryResultDto>('/api/dashboards/preview', { query, limit, ...options }),
    results: (dashboardId: string, widgetId: string) =>
      get<DashboardQueryResultDto>(
        `/api/dashboards/${seg(dashboardId)}/widgets/${seg(widgetId)}/results`,
      ),
    create: (name: string) => checked(post<unknown>('/api/dashboards', { name }), guards.dashboard),
    update: (id: string, input: UpdateDashboardRequest) =>
      checked(patch<unknown>(`/api/dashboards/${seg(id)}`, input), guards.dashboard),
    remove: (id: string) => del(`/api/dashboards/${seg(id)}`),
  },

  tokens: {
    list: () =>
      get<{ tokens: ApiTokenDto[]; agents: AgentDto[]; mcp: McpAvailabilityDto }>('/api/tokens'),
    create: (input: CreateTokenInput) => post<{ token: ApiTokenDto }>('/api/tokens', input),
    revoke: (id: string) => del(`/api/tokens/${seg(id)}`),
    /** Connected remote apps (OAuth grants) — and disconnecting one. */
    grants: () => get<{ grants: OAuthGrantDto[] }>('/api/tokens/grants'),
    revokeGrant: (clientId: string) =>
      del<{ revoked: number }>(`/api/tokens/grants/${encodeURIComponent(clientId)}`),
  },

  /** Client-portal integration credentials (docs/HELPDESK.md §3.4). */
  integrations: {
    list: () => get<{ integrations: IntegrationDto[] }>('/api/integrations'),
    create: (input: CreateIntegrationInput) =>
      post<{ integration: IntegrationDto }>('/api/integrations', input),
    rotate: (id: string, input: RotateIntegrationInput) =>
      post<{ integration: IntegrationDto }>(`/api/integrations/${seg(id)}/rotate`, input),
    revokePrevious: (id: string) =>
      post<{ integration: IntegrationDto }>(`/api/integrations/${seg(id)}/revoke-previous`, {}),
    revoke: (id: string) =>
      post<{ integration: IntegrationDto }>(`/api/integrations/${seg(id)}/revoke`, {}),
    enrol: (id: string, input: EnrolRadarInput) =>
      post<{ integration: IntegrationDto }>(`/api/integrations/${seg(id)}/radars`, input),
    unenrol: (id: string, radarId: string) =>
      del<{ integration: IntegrationDto }>(`/api/integrations/${seg(id)}/radars/${seg(radarId)}`),
    /** Events to the portal (§5.4): where they are pushed, and the controls on it. */
    setDelivery: (id: string, url: string | null) =>
      put<{ integration: IntegrationDto }>(`/api/integrations/${seg(id)}/delivery`, { url }),
    rotateDeliverySecret: (id: string) =>
      post<{ integration: IntegrationDto }>(
        `/api/integrations/${seg(id)}/delivery/rotate-secret`,
        {},
      ),
    pauseDelivery: (id: string) =>
      post<{ integration: IntegrationDto }>(`/api/integrations/${seg(id)}/delivery/pause`, {}),
    resumeDelivery: (id: string) =>
      post<{ integration: IntegrationDto }>(`/api/integrations/${seg(id)}/delivery/resume`, {}),
    testDelivery: (id: string) =>
      post<{ integration: IntegrationDto }>(`/api/integrations/${seg(id)}/delivery/test`, {}),
    deliveries: (id: string) =>
      get<IntegrationDeliveriesDto>(`/api/integrations/${seg(id)}/deliveries`),
  },

  /** The Agent Repo — every call is the same service the MCP tools use. */
  agentRepo: {
    list: (query: { view?: 'mine' | 'shared' | 'archived' } = {}) =>
      checked(get<unknown>(`/api/repo-agents${queryString(query)}`), guards.agents),
    get: (id: string) => checked(get<unknown>(`/api/repo-agents/${seg(id)}`), guards.agent),
    /** Whether a handle is free for a new agent of yours. */
    handleAvailable: (handle: string) =>
      get<{ available: boolean; suggestion: string }>(
        `/api/repo-agents/handles/${encodeURIComponent(handle)}`,
      ),
    create: (input: CreateRepoAgentRequest) =>
      checked(post<unknown>('/api/repo-agents', input), guards.agent),
    import: (input: ImportAgentInput) =>
      checked(post<unknown>('/api/repo-agents/import', input), guards.agent),
    update: (id: string, input: UpdateRepoAgentRequest) =>
      checked(patch<unknown>(`/api/repo-agents/${seg(id)}`, input), guards.agent),
    remove: (id: string) => del(`/api/repo-agents/${seg(id)}`),
    setArchived: (id: string, archived: boolean) =>
      checked(put<unknown>(`/api/repo-agents/${seg(id)}/archived`, { archived }), guards.agent),
    /** Agents can't change the prompt while locked; people with edit access still can. */
    setLocked: (id: string, locked: boolean) =>
      checked(put<unknown>(`/api/repo-agents/${seg(id)}/lock`, { locked }), guards.agent),
    /** Whether other agents' prompt edits go live (ADR-0031). The owner's decision, never an agent's. */
    setAgentEditsLive: (id: string, live: boolean) =>
      checked(put<unknown>(`/api/repo-agents/${seg(id)}/agent-edits`, { live }), guards.agent),
    /** Which radars the agent may reach. The owner's decision, never an agent's. */
    setRadars: (id: string, input: SetAgentRadarsInput) =>
      checked(put<unknown>(`/api/repo-agents/${seg(id)}/radars`, input), guards.agent),
    duplicate: (id: string) =>
      checked(post<unknown>(`/api/repo-agents/${seg(id)}/duplicate`), guards.agent),

    /* prompt */
    /** One page of prompt history, newest first, metadata only. */
    prompts: (id: string, query: { cursor?: string; limit?: number } = {}) =>
      checked(
        get<unknown>(`/api/repo-agents/${seg(id)}/prompts${queryString(query)}`),
        guards.prompts,
      ),
    prompt: (id: string, version: number | 'live' = 'live') =>
      checked(get<unknown>(`/api/repo-agents/${seg(id)}/prompts/${version}`), guards.prompt),
    savePrompt: (id: string, input: { body: string; basedOn: number; note?: string }) =>
      checked(post<unknown>(`/api/repo-agents/${seg(id)}/prompts`, input), guards.prompt),

    /** Prompt changes held for the owner (ADR-0029). Accepting or rejecting is a signed-in act. */
    promptProposals: (id: string) =>
      checked(get<unknown>(`/api/repo-agents/${seg(id)}/prompt-proposals`), guards.proposals),
    acceptPromptProposal: (id: string, proposalId: string) =>
      checked(
        post<unknown>(`/api/repo-agents/${seg(id)}/prompt-proposals/${seg(proposalId)}/accept`, {}),
        guards.prompt,
      ),
    rejectPromptProposal: (id: string, proposalId: string) =>
      post<unknown>(`/api/repo-agents/${seg(id)}/prompt-proposals/${seg(proposalId)}/reject`, {}),

    /* tool profiles */
    profiles: (id: string) =>
      checked(get<unknown>(`/api/repo-agents/${seg(id)}/profiles`), guards.profiles),
    /** Create or replace one tool's profile. `harness` is a tool id or `default`. */
    setProfile: (id: string, harness: ProfileKey, input: SetProfileRequest) =>
      checked(
        put<unknown>(`/api/repo-agents/${seg(id)}/profiles/${seg(harness)}`, input),
        guards.profile,
      ),
    removeProfile: (id: string, harness: ProfileKey) =>
      del(`/api/repo-agents/${seg(id)}/profiles/${seg(harness)}`),

    /* briefs */
    /** The briefs this person runs, without bodies. */
    briefs: (id: string) =>
      checked(get<unknown>(`/api/repo-agents/${seg(id)}/briefs`), guards.briefs),
    /** One brief: the revision this person runs, or another by number. */
    brief: (id: string, name: string, revision?: number) =>
      checked(
        get<unknown>(
          `/api/repo-agents/${seg(id)}/briefs/${seg(name)}${queryString(revision ? { revision } : {})}`,
        ),
        guards.brief,
      ),
    /** Create (no expectedRevision) or update one brief. */
    saveBrief: (id: string, name: string, input: UpdateBriefRequest) =>
      checked(
        put<unknown>(`/api/repo-agents/${seg(id)}/briefs/${seg(name)}`, input),
        guards.briefSaved,
      ),
    /** One brief's revisions, newest first, without bodies. */
    briefRevisions: (id: string, name: string, query: { cursor?: string } = {}) =>
      checked(
        get<unknown>(
          `/api/repo-agents/${seg(id)}/briefs/${seg(name)}/revisions${queryString(query)}`,
        ),
        guards.briefRevisions,
      ),
    renameBrief: (id: string, name: string, newName: string) =>
      post<{ brief: BriefIndexEntryDto }>(
        `/api/repo-agents/${seg(id)}/briefs/${seg(name)}/rename`,
        { newName },
      ),
    /** Irreversible: the brief and every revision of it, for everyone. */
    deleteBrief: (id: string, name: string) =>
      del(`/api/repo-agents/${seg(id)}/briefs/${seg(name)}`),
    /** Bind a brief to a path in a GitLab project, or change where it is bound. Owner, admin. */
    bindBrief: (id: string, name: string, input: BriefBindingRequest) =>
      checked(
        put<unknown>(`/api/repo-agents/${seg(id)}/briefs/${seg(name)}/binding`, input),
        guards.briefBinding,
      ),
    /** Stop checking and mirroring a brief. Nothing in the repository changes. */
    unbindBrief: (id: string, name: string) =>
      del(`/api/repo-agents/${seg(id)}/briefs/${seg(name)}/binding`),

    /* memory */
    memories: (id: string, query: Record<string, string> = {}) => {
      const qs = new URLSearchParams(query).toString();
      return checked(
        get<unknown>(`/api/repo-agents/${seg(id)}/memories${qs ? `?${qs}` : ''}`),
        guards.memoryPage,
      );
    },
    remember: (id: string, input: RememberRequest) =>
      checked(post<unknown>(`/api/repo-agents/${seg(id)}/memories`, input), guards.remembered),
    forget: (id: string, memoryId: string, reason: string) =>
      checked(
        post<unknown>(`/api/repo-agents/${seg(id)}/memories/forget`, { id: memoryId, reason }),
        guards.memory,
      ),
    restore: (id: string, memoryId: string) =>
      checked(
        post<unknown>(`/api/repo-agents/${seg(id)}/memories/${seg(memoryId)}/restore`),
        guards.memory,
      ),
    pin: (id: string, memoryId: string, pinned: boolean) =>
      checked(
        put<unknown>(`/api/repo-agents/${seg(id)}/memories/${seg(memoryId)}/pin`, { pinned }),
        guards.memory,
      ),
    revisions: (id: string, memoryId: string) =>
      get<{ revisions: MemoryRevisionDto[] }>(
        `/api/repo-agents/${seg(id)}/memories/${seg(memoryId)}/revisions`,
      ),
    promote: (id: string, memoryId: string, radarId: string) =>
      post<{ blip: { id: string } }>(
        `/api/repo-agents/${seg(id)}/memories/${seg(memoryId)}/promote`,
        { radarId },
      ),

    /* activity, sessions, checkout, export */
    activity: (id: string, query: { kind?: string; cursor?: string } = {}) =>
      get<ActivityPageDto>(`/api/repo-agents/${seg(id)}/activity${queryString(query)}`),
    sessions: (id: string) => get<AgentSessionInventoryDto>(`/api/repo-agents/${seg(id)}/sessions`),
    checkout: (
      id: string,
      query: { harness: string; mode?: string; applyProjectSettings?: boolean; snapshot?: boolean },
    ) =>
      get<{ checkout: CheckoutDto }>(`/api/repo-agents/${seg(id)}/checkout${queryString(query)}`),
    export: (id: string) => get<{ agent: ImportAgentInput }>(`/api/repo-agents/${seg(id)}/export`),

    /* sharing */
    shares: (id: string) => get<{ shares: AgentShareDto[] }>(`/api/repo-agents/${seg(id)}/shares`),
    share: (id: string, input: ShareAgentRequest) =>
      post<{ share: AgentShareDto }>(`/api/repo-agents/${seg(id)}/shares`, input),
    updateShare: (
      id: string,
      subjectType: 'user' | 'topic',
      subjectId: string,
      input: UpdateShareRequest,
    ) =>
      patch<{ share: AgentShareDto }>(
        `/api/repo-agents/${seg(id)}/shares/${subjectType}/${seg(subjectId)}`,
        input,
      ),
    unshare: (id: string, subjectType: 'user' | 'topic', subjectId: string) =>
      del(`/api/repo-agents/${seg(id)}/shares/${subjectType}/${seg(subjectId)}`),
    /** A recipient accepts a share: pins the version they read. */
    accept: (id: string) =>
      checked(post<unknown>(`/api/repo-agents/${seg(id)}/accept`), guards.agent),
    /** A recipient leaves a shared agent. */
    leave: (id: string) => del(`/api/repo-agents/${seg(id)}/accept`),
    /** A recipient moves their pin to the live version. */
    takeUpdate: (id: string) =>
      checked(post<unknown>(`/api/repo-agents/${seg(id)}/update`), guards.agent),
    setFollow: (id: string, follow: boolean) =>
      checked(put<unknown>(`/api/repo-agents/${seg(id)}/follow`, { follow }), guards.agent),

    /* ownership */
    offerTransfer: (id: string, email: string) =>
      checked(post<unknown>(`/api/repo-agents/${seg(id)}/transfer`, { email }), guards.agent),
    cancelTransfer: (id: string) =>
      checked(del<unknown>(`/api/repo-agents/${seg(id)}/transfer`), guards.agent),
    acceptTransfer: (id: string) =>
      checked(post<unknown>(`/api/repo-agents/${seg(id)}/transfer/accept`), guards.agent),
    declineTransfer: (id: string) => post(`/api/repo-agents/${seg(id)}/transfer/decline`),

    /* identity: machines and apps that write as this agent */
    connections: (id: string) =>
      get<{ tokens: ApiTokenDto[]; grants: OAuthGrantDto[]; mcp: { url: string } }>(
        `/api/repo-agents/${seg(id)}/connections`,
      ),
    /** Mint a token that writes as this agent (session-only; shown once). */
    mintToken: (id: string, name: string, expiresInDays?: number | null) =>
      post<{ token: ApiTokenDto }>(`/api/repo-agents/${seg(id)}/connections`, {
        name,
        ...(expiresInDays !== undefined ? { expiresInDays } : {}),
      }),
  },

  /** Model lists per tool, kept current by an admin. */
  models: {
    list: (harness?: string) =>
      get<{ models: ModelCatalogEntryDto[] }>(`/api/models${queryString({ harness })}`),
  },

  admin: {
    users: (state?: string) =>
      get<{ users: AdminUserDto[]; counts: Record<string, number> }>(
        `/api/admin/users${state ? `?state=${encodeURIComponent(state)}` : ''}`,
      ),
    act: (id: string, action: 'approve' | 'suspend' | 'reinstate') =>
      post<{ user: { id: string; state: string } }>(`/api/admin/users/${seg(id)}`, { action }),
    /** Every model in the catalog, hidden and deprecated included. */
    models: () => get<{ models: ModelCatalogEntryDto[] }>('/api/admin/models'),
    createModel: (input: ModelCatalogEntryRequest) =>
      post<{ model: ModelCatalogEntryDto }>('/api/admin/models', input),
    updateModel: (id: string, input: UpdateModelCatalogEntryRequest) =>
      patch<{ model: ModelCatalogEntryDto }>(`/api/admin/models/${seg(id)}`, input),
    removeModel: (id: string) => del(`/api/admin/models/${seg(id)}`),
    /** Numbers for the admin dashboard's overview. */
    overview: () => get<AdminOverviewDto>('/api/admin/overview'),
    /** Agents and their credentials, metadata only; revoking is the admin's act. */
    agents: (query: { q?: string; cursor?: string } = {}) =>
      get<AdminAgentPageDto>(`/api/admin/agents${inventoryQuery(query)}`),
    tokens: (query: { q?: string; cursor?: string } = {}) =>
      get<AdminTokenPageDto>(`/api/admin/tokens${inventoryQuery(query)}`),
    revokeAgent: (id: string) => post<undefined>(`/api/admin/agents/${seg(id)}/revoke`, {}),
    revokeToken: (token: AdminTokenDto) =>
      post<undefined>(
        token.kind === 'pat'
          ? `/api/admin/tokens/pat/${seg(token.id)}/revoke`
          : `/api/admin/tokens/oauth/${seg(token.owner.id)}/${seg(token.id)}/revoke`,
        {},
      ),
  },

  publicRadars: {
    email: (slug: string, id: string, images = false) =>
      get<{ email: EmailDetailDto }>(
        `/api/public/radars/${seg(slug)}/blips/${seg(id)}/email${images ? '?images=1' : ''}`,
      ),
    get: (slug: string) => get<{ radar: RadarDto }>(`/api/public/radars/${seg(slug)}`),
    blips: (slug: string, query: BlipQuery = {}) =>
      get<PageDto<BlipDto>>(`/api/public/radars/${seg(slug)}/blips${queryString(query)}`),
    comments: (slug: string, blipId: string, cursor?: string) =>
      get<PageDto<CommentDto>>(
        `/api/public/radars/${seg(slug)}/blips/${seg(blipId)}/comments${
          cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''
        }`,
      ),
  },

  oauth: {
    client: (clientId: string) =>
      get<{
        clientId: string;
        clientName: string | null;
        redirectUris: string[];
        /** The personas this person owns, so the screen can offer one. */
        agents: AgentDto[];
      }>(`/oauth/client/${encodeURIComponent(clientId)}`),
    decide: (input: OAuthDecisionInput) =>
      post<{ redirectTo: string }>('/oauth/authorize/decision', input),
  },
};

/**
 * An image's real pixel dimensions, measured in the browser before it is sent.
 *
 * The column has always existed and the server has always stored what it was
 * given — but nothing ever measured, so every attachment landed with
 * `width: null`, and a card with no aspect ratio to honour had no choice but to
 * crop to a fixed box. That is the whole reason a portrait photo lost its
 * subject. Measuring here is the fix; it costs one decode that the browser is
 * about to do anyway when it renders the preview.
 *
 * Never throws: a file that cannot be decoded is still a perfectly good
 * attachment, it just goes back to being sized by the fallback.
 */
async function imageSize(file: File): Promise<{ width: number; height: number } | null> {
  if (!file.type.startsWith('image/')) return null;
  const url = URL.createObjectURL(file);
  try {
    const size = await new Promise<{ width: number; height: number } | null>((resolve) => {
      const image = new Image();
      image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
      image.onerror = () => resolve(null);
      image.src = url;
    });
    // A zero here would be a lie the renderer would divide by.
    return size && size.width > 0 && size.height > 0 ? size : null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export interface UploadedFile {
  key: string;
  filename: string;
  contentType: string;
  size: number;
  width?: number;
  height?: number;
}

/**
 * Uploads go straight to object storage with a presigned URL — the bytes never
 * touch the app server, so a large file costs the pod nothing.
 */
export async function uploadFile(radarId: string, file: File): Promise<UploadedFile> {
  // Measured before the PUT rather than after, so a slow upload does not delay
  // the dimensions the composer wants for its own preview.
  const [dimensions, { ticket }] = await Promise.all([
    imageSize(file),
    api.radars.uploadTicket(radarId, {
      filename: file.name,
      contentType: file.type || 'application/octet-stream',
      size: file.size,
    }),
  ]);

  /*
    A PUT the storage refuses and a PUT the browser never sends look nothing
    alike from here. A missing CORS policy on the bucket fails the preflight, and
    fetch rejects with a bare TypeError — no status, no body. That used to fall
    through to the composer's generic "Upload failed", which is exactly how every
    browser upload was broken for weeks after the move to R2 without anything
    saying where. Named separately so the chip says which side stopped it.
  */
  let response: Response;
  try {
    response = await fetch(ticket.url, {
      method: 'PUT',
      headers: ticket.headers,
      body: file,
    });
  } catch {
    // Short on purpose: it is shown in the attachment chip, beside the name.
    throw new ApiError(0, 'storage_unreachable', 'Storage unreachable');
  }
  if (!response.ok) {
    throw new ApiError(
      response.status,
      'upload_failed',
      `Storage refused it (${String(response.status)})`,
    );
  }

  return {
    key: ticket.key,
    filename: file.name,
    contentType: file.type || 'application/octet-stream',
    size: file.size,
    ...(dimensions ?? {}),
  };
}
