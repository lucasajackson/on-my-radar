/**
 * Everything the sweep needs to look at, built through the real API.
 *
 * Through the API and not through SQL, deliberately: the suite is asserting on
 * what the app renders, so the rows it renders should have arrived the way real
 * ones do — inference and all. It also means this file cannot drift from the
 * schema without failing loudly.
 *
 * The database is rebuilt from nothing each run rather than patched, because
 * `findOrCreateUser` decides only the INITIAL account state: a collaborator who
 * once landed on the waitlist stays there however many times AUTO_APPROVE_EMAILS
 * is widened afterwards.
 */
import { PAGE_02, PAGE_03 } from '../../server/src/__fixtures__/acme-architecture.js';
import {
  RADAR_TEMPLATE_IDS,
  type RadarAccent,
  type RadarGlyph,
  type RadarTemplate,
} from '@onmyradar/contract';

export const OWNER_EMAIL = 'owner@example.test';
const MATE_EMAIL = 'mate@example.test';
/** The request the client portal files in the seed (helpdesk slice 3). */
export const PORTAL_REQUEST = 'Gallery shows old photos';

/**
 * Invitation guests live on a domain AUTO_APPROVE_EMAILS does not cover.
 *
 * `main.ts` sets `AUTO_APPROVE_EMAILS=@example.test` so the seed's own accounts
 * can sign straight in. If the invited addresses shared that domain, the
 * waitlist would never apply to them and the assertion that an ordinary user's
 * invitation lands somebody in a queue would pass without the queue existing.
 * `@outside.test` is genuinely subject to the waitlist, which is the whole point
 * of the screen being asserted on.
 */
const INVITED_BY_ADMIN = 'invited-by-admin@outside.test';
const INVITED_BY_USER = 'invited-by-user@outside.test';

interface RadarSpec {
  readonly name: string;
  readonly accent: RadarAccent;
  readonly glyph: RadarGlyph;
  readonly blips: readonly string[];
}

/**
 * One radar per template — and it is a `Record<RadarTemplate, …>` on purpose.
 *
 * Adding a template to the registry without giving it a phone screen is then a
 * TYPE ERROR, caught by `pnpm -r typecheck` in CI rather than by nobody. That is
 * the whole reason this suite imports from @onmyradar/contract instead of
 * hard-coding a list of names.
 */
const RADARS: Record<RadarTemplate, RadarSpec> = {
  stream: {
    name: 'House',
    accent: 'orchid',
    glyph: 'wrench',
    blips: [
      'Call the plumber about the upstairs radiator #home',
      'Gutter guards before the leaves come down #home',
      '# Kitchen\nMeasure the run before ordering anything else.',
    ],
  },

  kanban: {
    name: 'On My Radar',
    accent: 'ember',
    glyph: 'radar',
    blips: [
      '# Mobile UI\nThe phone view has to stop reading like a shrunken desktop. #mobile',
      'Composer opens behind the keyboard on iOS — cannot capture at all. #bug #mobile',
      '# Bearing strip\nSpread ticks evenly below a six-hour span. #design',
      'https://developer.mozilla.org/en-US/docs/Web/API/VisualViewport',
      'Radar templates each need a complete mobile view. #mobile #templates',
      'Board pager: one lane at a time under the lg breakpoint. #mobile',
    ],
  },

  microblog: {
    name: 'Ideas',
    accent: 'bubblegum',
    glyph: 'lightbulb',
    blips: [
      'A capture app that infers everything rather than asking. #idea',
      'What if a radar had its own webhook URL? #idea',
      'Point an agent at a radar and say build what is in it.',
    ],
  },

  reading: {
    name: 'Reading',
    accent: 'lagoon',
    glyph: 'book',
    blips: [
      'https://www.postgresql.org/docs/17/textsearch-controls.html',
      '# Keyset pagination\nThe cursor is total because (pinned, created_at, id) cannot tie. #postgres',
      'Immutability rules for generated columns — array_to_string is only STABLE. #postgres',
      'https://developer.mozilla.org/en-US/docs/Web/CSS/@layer — the cascade layer rule that bit us #css',
      'https://web.dev/articles/optimize-inp',
    ],
  },

  /*
   * A discussion radar is only a discussion radar once somebody has replied: the
   * layout floats the most-recently-answered thread to the top and renders its
   * replies expanded beneath it. Seeded with no replies it would render as a
   * plain list, and the phone screen would prove nothing about the layout that
   * was actually added. `seedDiscussion` below puts real replies in it.
   */
  discussion: {
    name: 'Workshop',
    accent: 'moss',
    glyph: 'coffee',
    blips: [
      '# Do we bother with a roadmap layout?\nEvery template so far earned its place by having a verb the others do not.',
      '# The phone is the real client\nMost capture happens one-handed, standing up. #mobile',
      '# Naming the drop box\nIt is the one radar nobody chose to make.',
    ],
  },

  decisions: {
    name: 'Decisions',
    accent: 'cobalt',
    glyph: 'compass',
    blips: [
      '# Chart lives in the GitOps repo\nA second copy in the app repo would silently drift.',
      '# One service layer, two transports\nREST and MCP call the same functions. #architecture',
      '# Deploy with a GitOps write-back token\nCopy what Commander does: CI commits the new image tag into infra-app-configs.',
    ],
  },

  // Its pages and ADRs need the architecture verbs (a lane, anchors), so they are
  // written after this loop; see `seed()`.
  architecture: { name: 'Architecture', accent: 'slate', glyph: 'compass', blips: [] },

  helpdesk: {
    name: 'Helpdesk · Example Site',
    accent: 'lagoon',
    glyph: 'message',
    blips: [
      '# Contact form sends twice\nTwo copies of every enquiry since Tuesday.',
      'Please swap the summer hours banner for the winter one',
      '# New staff photo\nReplace the team page photo with the attached one.',
    ],
  },
};

/**
 * A radar with nothing in it, which no other spec provides.
 *
 * The empty state is the only place the "type in the box and hit cmd + enter"
 * prose renders, so without a radar in this condition the check that guards it
 * can never fire — and a check that cannot fire is decoration. The invitations
 * run only found the original mis-scoped assertion because its seed happened to
 * leave a radar empty; this makes that an intended condition rather than luck.
 */
const EMPTY_RADAR = { name: 'Empty', accent: 'slate', glyph: 'target' } as const;

/** Radars the collaborator is invited to, and therefore the ones with unread. */
const SHARED_WITH_MATE = ['House', 'Ideas', 'Reading', 'Workshop'] as const;

/** Radars filed under the topic. Overlaps SHARED_WITH_MATE so the roll-up is non-zero. */
const IN_TOPIC = ['House', 'Reading', 'Decisions'] as const;

/** What `POST /api/radars/:id/members` answers. */
interface ShareResponse {
  share: { status: string; approved: boolean; inviteUrl: string | null };
}

export interface SeededRadar {
  readonly id: string;
  readonly name: string;
  readonly template: string;
}

/** One invitation link, and what the screen behind it is expected to say. */
export interface SeededInvite {
  readonly token: string;
  readonly email: string;
  readonly radarName: string;
  readonly inviterName: string;
}

/**
 * A deliberate needle for the search screen, and what it is supposed to find.
 *
 * Placed rather than borrowed from the fixture prose on purpose. Asserting
 * against a word that happens to appear in a seeded body today is an assertion
 * that silently changes meaning the moment somebody rewrites that body for an
 * unrelated reason — and the failure then looks like a search bug. This word
 * exists for no other purpose, so the count is a fact about the search rather
 * than about the copy.
 */
export interface SeededSearch {
  /** A word that appears in exactly `matches` blips, on one radar. */
  readonly needle: string;
  readonly matches: number;
  /** The radar those blips are on, for the `in:` assertions. */
  readonly radarName: string;
  readonly radarId: string;
  /** A radar name that cannot resolve — for the unresolved-filter assertion. */
  readonly missingRadar: string;
}

/**
 * A published radar, and the theme it was published with.
 *
 * Two of them, because the pair is the assertion: one radar carrying the
 * loudest theme in the vocabulary and one carrying none, on the same layout, so
 * "the theme is applied" and "an unthemed radar is untouched" are both checkable
 * against something rather than against nothing.
 */
export interface SeededPublic {
  readonly slug: string;
  readonly name: string;
  readonly preset: string | null;
}

export interface Seeded {
  readonly baseUrl: string;
  readonly ownerCookie: string;
  readonly radars: readonly SeededRadar[];
  readonly topicId: string;
  /** The per-account private inbox. Its dialogs offer strictly less than every other radar's. */
  readonly dropBoxId: string;
  readonly unreadTotal: number;
  /** From an admin: accepting skips the waitlist. */
  readonly adminInvite: SeededInvite;
  /** From an ordinary user: accepting joins the waitlist. */
  readonly userInvite: SeededInvite;
  readonly search: SeededSearch;
  /** Published radars, themed and not. Read signed out, like a stranger would. */
  readonly published: readonly SeededPublic[];
}

/* --------------------------------------------------------------- session --- */

interface Json {
  [key: string]: unknown;
}

class Session {
  private cookie = '';

  constructor(private readonly base: string) {}

  get sessionCookie(): string {
    return this.cookie;
  }

  async call<T = Json>(path: string, init: RequestInit = {}): Promise<T> {
    // Through `Headers`, not an object spread: spreading a Headers instance or a
    // tuple array yields nothing (or indices), silently dropping the caller's.
    const headers = new Headers({ 'content-type': 'application/json' });
    if (this.cookie) headers.set('cookie', this.cookie);
    new Headers(init.headers).forEach((value, name) => headers.set(name, value));
    const res = await fetch(this.base + path, { ...init, headers });
    for (const raw of res.headers.getSetCookie()) {
      const pair = raw.split(';')[0];
      if (pair) this.cookie = pair;
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${path}: ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : null) as T;
  }

  post<T = Json>(path: string, body: unknown): Promise<T> {
    return this.call<T>(path, { method: 'POST', body: JSON.stringify(body) });
  }

  put<T = Json>(path: string, body: unknown): Promise<T> {
    return this.call<T>(path, { method: 'PUT', body: JSON.stringify(body) });
  }

  patch<T = Json>(path: string, body: unknown): Promise<T> {
    return this.call<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
  }

  /**
   * The magic-link flow, taken at its word. With NODE_ENV !== production and no
   * RESEND_API_KEY the six-digit code comes back in the response instead of
   * being emailed, which is the documented development behaviour — not a
   * back door this suite opened.
   */
  async signIn(email: string): Promise<void> {
    const { devCode } = await this.post<{ devCode?: string }>('/api/auth/request-code', { email });
    if (!devCode) {
      throw new Error(
        `no devCode for ${email}: the server must run with NODE_ENV!=production and no RESEND_API_KEY`,
      );
    }
    await this.post('/api/auth/verify-code', { email, code: devCode });
  }
}

/* ------------------------------------------------------------------ seed --- */

interface RadarRow {
  id: string;
  name: string;
  template: string;
  isDropBox?: boolean;
  publicSlug?: string | null;
  topic?: { id: string } | null;
  commentsEnabled?: boolean;
}

interface BlipRow {
  id: string;
  title?: string | null;
  author?: { email?: string } | null;
}

export async function seed(base: string): Promise<Seeded> {
  const owner = new Session(base);

  // The collaborator has to exist and be active before a share can name them.
  const mate = new Session(base);
  await mate.signIn(MATE_EMAIL);
  /*
   * Display names, so a mention renders the thing worth asserting.
   * `displayNameFor` falls back to the local part of the address when an account
   * has no name, so an unnamed seed makes "@owner" render as "@owner" — which
   * passes a mention check while proving nothing, because the whole argument for
   * storing the resolution rather than parsing the body is that a *renamed*
   * account renders under its new name from an unchanged body.
   */
  await mate.patch('/api/auth/profile', { name: 'Mate Nakamura' });

  await owner.signIn(OWNER_EMAIL);
  await owner.patch('/api/auth/profile', { name: 'Owner Okonkwo' });
  await owner.call('/api/radars/drop-box');

  /* -- one radar per template, plus its blips ----------------------------- */

  for (const template of RADAR_TEMPLATE_IDS) {
    const spec = RADARS[template];
    const { radar } = await owner.post<{ radar: RadarRow }>('/api/radars', {
      name: spec.name,
      accent: spec.accent,
      glyph: spec.glyph,
      template,
    });
    for (const body of spec.blips) {
      await owner.post(`/api/radars/${radar.id}/blips`, { body });
    }
  }

  await owner.post('/api/radars', {
    name: EMPTY_RADAR.name,
    accent: EMPTY_RADAR.accent,
    glyph: EMPTY_RADAR.glyph,
    template: 'stream',
  });

  const all = (await owner.call<{ radars: RadarRow[] }>('/api/radars')).radars;
  const byName = (name: string): RadarRow => {
    const found = all.find((r) => r.name === name);
    if (!found) throw new Error(`seed did not create a radar called ${name}`);
    return found;
  };

  /* -- the drop box, which every account has and the phone view shows ----- */

  const dropBox = all.find((r) => r.isDropBox);
  if (!dropBox) throw new Error('no drop box on the seeded account');
  for (const body of [
    'Book the MOT #car',
    'That thing about the tunnel ingress list not having a catch-all',
    'https://onmyradar.io',
  ]) {
    await owner.post(`/api/radars/${dropBox.id}/blips`, { body });
  }

  /* -- reading list: a populated QUEUE, not a flat list ------------------- */

  const reading = byName(RADARS.reading.name);
  const readingBlips = (
    await owner.call<{ items: BlipRow[] }>(`/api/radars/${reading.id}/blips?limit=50`)
  ).items;
  if (readingBlips[0]) await owner.patch(`/api/blips/${readingBlips[0].id}`, { status: 'reading' });
  if (readingBlips[1])
    await owner.patch(`/api/blips/${readingBlips[1].id}`, { status: 'finished' });

  /* -- decision log: a real supersession chain, which is what makes it a
        LEDGER and exercises the `log` layout rather than a flat stream ----- */

  const decisions = byName(RADARS.decisions.name);
  const logBlips = (
    await owner.call<{ items: BlipRow[] }>(`/api/radars/${decisions.id}/blips?limit=50`)
  ).items;
  const byTitle = (prefix: string): BlipRow => {
    const found = logBlips.find((b) => (b.title ?? '').startsWith(prefix));
    if (!found) throw new Error(`seed did not create a decision titled ${prefix}`);
    return found;
  };

  await owner.patch(`/api/blips/${byTitle('One service layer').id}`, { status: 'accepted' });
  await owner.patch(`/api/blips/${byTitle('Chart lives').id}`, { status: 'accepted' });
  await owner.post(`/api/radars/${decisions.id}/blips`, {
    body: '# Deploy with the runner service account\nEvery other app in the estate restarts its deployment with the runner’s own in-cluster identity. Commander’s write-back is its documented exception, not the pattern.',
    status: 'accepted',
    supersedes: byTitle('Deploy with a GitOps write-back token').id,
  });

  /* -- architecture: the Acme pack's pages (wide tables included), one
        accepted amendment and one still proposed ------------------------- */

  const arch = byName(RADARS.architecture.name);
  // A last section that is simply long, so the sweep can scroll the charter far enough to
  // see whether the ledger rail stays where it is.
  const LONG_PAGE = [
    '# 05 · Operations',
    ...Array.from(
      { length: 120 },
      (_, i) =>
        `Operating note ${i + 1}. Each runbook names its owner, the signal that pages them, and the one command that makes the situation safe before anyone starts to diagnose it.`,
    ),
  ].join('\n\n');
  // A short note after the system table: it keeps the next page's title out of the strip a phone's
  // first screen ends on (under the tab bar), where the sweep's title-under-a-control check would
  // otherwise read it as colliding with the bar.
  const SYSTEM_NOTE =
    'Acme Notes sits between its workspaces and a handful of outside systems. Each is listed once, with what it owns and what Acme does with it; the sections that follow say how those pieces are built and how they are run.';
  // The charter is one document; the three pages are its sections, saved whole.
  await owner.put(`/api/radars/${arch.id}/charter`, {
    markdown: [PAGE_02, SYSTEM_NOTE, PAGE_03, LONG_PAGE].join('\n\n'),
    baseRevision: 0,
  });
  /* -- the same radar's boundaries and contracts: Billing and Sites inside the
        application, Stripe and Cloudflare outside, three seams. The accepted ADR
        below amends the Stripe contract (red), the open one amends Billing
        (amber). -------------------------------------------------------------- */

  const element = async (kind: 'boundaries' | 'contracts', input: object) =>
    (await owner.post<Record<string, { id: string }>>(`/api/radars/${arch.id}/${kind}`, input))[
      kind === 'boundaries' ? 'boundary' : 'contract'
    ]?.id ?? '';
  const billing = await element('boundaries', {
    title: 'M8 Billing',
    owns: ['billing.billing_links', 'billing.hosting_plans'],
  });
  const sites = await element('boundaries', { title: 'M1 Sites', owns: ['sites.sites'] });
  const stripe = await element('boundaries', { title: 'Stripe', external: true });
  const cloudflare = await element('boundaries', { title: 'Cloudflare', external: true });
  const stripeSeam = await element('contracts', {
    title: 'Stripe',
    version: '1.0',
    a: billing,
    b: stripe,
  });
  await element('contracts', { title: 'Site billing', version: '0.2', a: sites, b: billing });
  await element('contracts', { title: 'Cloudflare', version: '1.1', a: sites, b: cloudflare });

  const adopt = await owner.post<{ adr: { id: string } }>(`/api/radars/${arch.id}/adrs`, {
    title: 'Stripe owns payment truth only',
    rationale: 'Plans are decided in Acme; Stripe only reports payment.',
    anchors: [{ quote: 'all billing truth', with: 'payment truth only' }],
    amends: [stripeSeam],
  });
  await owner.post(`/api/blips/${adopt.adr.id}/decide`, { decision: 'accept' });
  await owner.post(`/api/radars/${arch.id}/adrs`, {
    title: 'Billing acts on its own',
    rationale: 'Open for discussion.',
    anchors: [
      { quote: 'Never acts on its own (ADR-0005)', with: 'Suspends and resumes on the clock' },
    ],
    amends: [billing],
  });

  /* -- a topic, so the radars screen has a grouped heading to roll up ----- */

  const { topic } = await owner.post<{ topic: { id: string } }>('/api/topics', {
    name: 'Foundation',
    tagline: 'Board, decisions and discussion',
    accent: 'moss',
  });
  for (const name of IN_TOPIC) {
    await owner.put(`/api/radars/${byName(name).id}/topic`, { topicId: topic.id });
  }

  /* -- unread notifications, so the badges have something to be wrong about */

  for (const name of SHARED_WITH_MATE) {
    const radar = byName(name);
    await owner.post(`/api/radars/${radar.id}/members`, { email: MATE_EMAIL, role: 'editor' });
    // Blip notifications only fan out on a radar the reader has opted up to `all`.
    await owner.put(`/api/radars/${radar.id}/notify-level`, { level: 'all' });
  }

  const fromMate: Record<string, string[]> = {
    House: ['Gutter quote came back at £340 #home', 'Boiler service is due in November'],
    Ideas: ['What if the drop box could email you a digest? #idea'],
    Reading: [
      'https://www.postgresql.org/docs/17/indexes-partial.html',
      'Worth reading on keyset pagination #postgres',
      'Another one for the pile',
    ],
  };

  for (const name of SHARED_WITH_MATE) {
    const radar = byName(name);
    for (const body of fromMate[name] ?? []) {
      await mate.post(`/api/radars/${radar.id}/blips`, { body });
    }
    // And a comment on something that was already there.
    const { items } = await mate.call<{ items: BlipRow[] }>(
      `/api/radars/${radar.id}/blips?limit=5`,
    );
    const existing = items.find((b) => b.author?.email === OWNER_EMAIL);
    // A reader takes no comments (its template says so), so the radar's own flag is the question.
    if (existing && radar.commentsEnabled !== false) {
      await mate.post(`/api/blips/${existing.id}/comments`, { body: 'Good shout — on it.' });
    }
  }

  /* -- discussion: threads with actual replies in them -------------------- */

  const workshop = byName(RADARS.discussion.name);
  const threads = (
    await owner.call<{ items: BlipRow[] }>(`/api/radars/${workshop.id}/blips?limit=50`)
  ).items;
  const replies: Record<string, string[]> = {
    'Do we bother with a roadmap layout?': [
      'The verb would be “ships in”, and nothing else has a date on it.',
      'Agreed — but that wants an occurred_at column first.',
    ],
    'The phone is the real client': [
      /*
       * Addresses the radar's owner by handle, so the phone screen exercises the
       * mention path end to end: resolved at write time against the people who
       * can read this radar, and rendered as the account's display name rather
       * than as the text that was typed. Without one in the seed, mentions have
       * a layout screen and no proof they render.
       */
      `Which is the whole argument for the composer clearing the keyboard — @${OWNER_EMAIL.split('@')[0] ?? 'owner'} agreed?`,
    ],
  };
  for (const thread of threads) {
    const bodies = replies[(thread.title ?? '').trim()];
    if (!bodies) continue;
    let parentId: string | undefined;
    for (const body of bodies) {
      const { comment } = await mate.post<{ comment: { id: string } }>(
        `/api/blips/${thread.id}/comments`,
        parentId ? { body, parentId } : { body },
      );
      // The second reply answers the first, so the one-level-deep thread shape
      // is what the phone screen is actually looking at.
      parentId ??= comment.id;
    }
  }

  /* -- helpdesk: one thread in all three visibilities ---------------------- */

  /*
   * An internal note, a released reply and a collaborator's draft waiting for
   * the owner's review (docs/HELPDESK.md §7). The collaborator is an editor,
   * like Andrea on a real helpdesk, so her "reply to client" lands pending and
   * the owner's screen carries the release bar the flow drives.
   */
  const helpdesk = byName(RADARS.helpdesk.name);
  await owner.post(`/api/radars/${helpdesk.id}/members`, { email: MATE_EMAIL, role: 'editor' });
  const requests = (
    await owner.call<{ items: BlipRow[] }>(`/api/radars/${helpdesk.id}/blips?limit=50`)
  ).items;
  const request = requests.find((b) => (b.title ?? '').startsWith('Contact form sends twice'));
  if (!request) throw new Error('seed did not create the helpdesk request');
  await owner.post(`/api/blips/${request.id}/comments`, {
    body: 'Their form plugin double-submits on slow connections. Internal only.',
  });
  await owner.post(`/api/blips/${request.id}/comments`, {
    body: 'Thanks — we can see the duplicates and are on it.',
    visibility: 'client',
  });
  await mate.post(`/api/blips/${request.id}/comments`, {
    body: 'Fixed: the form now disables its button after the first click. Could you send one test enquiry to confirm?',
    visibility: 'client',
  });

  /* -- helpdesk slice 3: the client portal ------------------------------- */

  /*
   * A portal connected and enrolled by the owner in a browser session, then a
   * request filed and answered through the real portal surface with the real
   * `omr_int_` token — not inserted — so the card's requester facet and the
   * ball-in-court clock are what the API actually produced. The owner's reply
   * goes out as written and the request sits in "Waiting on client", which is
   * the state the clock exists for.
   */
  const { integration } = await owner.post<{ integration: { id: string; token?: string } }>(
    '/api/integrations',
    { name: 'W&W portal' },
  );
  await owner.post(`/api/integrations/${integration.id}/radars`, {
    radarId: helpdesk.id,
    externalRef: 'site-phone',
  });
  const portal = await fetch(`${base}/api/v1/helpdesk/radars/${helpdesk.id}/requests`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${integration.token ?? ''}`,
      'content-type': 'application/json',
      'x-omr-requester-scope': 'acct-phone',
    },
    body: JSON.stringify({
      title: PORTAL_REQUEST,
      body: 'The gallery on the About page shows the old photos on my phone.',
      requester: {
        ref: 'cust-phone',
        accountRef: 'acct-phone',
        name: 'Pat Client',
        email: 'pat@client.example',
      },
    }),
  });
  if (portal.status !== 201)
    throw new Error(`portal request: ${portal.status} ${await portal.text()}`);
  const { request: portalRequest } = (await portal.json()) as { request: { id: string } };
  await owner.post(`/api/blips/${portalRequest.id}/comments`, {
    body: 'Could you tell us which phone and browser?',
    visibility: 'client',
  });
  await owner.patch(`/api/blips/${portalRequest.id}`, { status: 'waiting-on-client' });

  /* -- two invitations, which are two different promises ------------------ */

  /*
   * The link comes back from the share itself. The token is an HMAC over an
   * invitation row id and the server is the only thing that can mint one;
   * assembling it here would be asserting against a second implementation of
   * the thing under test.
   */
  const tokenFrom = (res: ShareResponse, who: string): string => {
    if (res.share.status !== 'invited' || !res.share.inviteUrl) {
      throw new Error(`sharing with ${who} did not produce an invitation link`);
    }
    return res.share.inviteUrl.split('/invite/')[1] ?? '';
  };

  // OWNER_EMAIL is in ADMIN_EMAILS, so this invitation skips the waitlist.
  const house = byName(RADARS.stream.name);
  const adminShare = await owner.post<ShareResponse>(`/api/radars/${house.id}/members`, {
    email: INVITED_BY_ADMIN,
    role: 'editor',
  });

  // The collaborator is an ordinary account, so theirs does not.
  const { radar: mateRadar } = await mate.post<{ radar: RadarRow }>('/api/radars', {
    name: 'Allotment',
    accent: 'moss',
    glyph: 'leaf',
    template: 'stream',
  });
  await mate.post(`/api/radars/${mateRadar.id}/blips`, { body: 'Order seed potatoes #garden' });
  const userShare = await mate.post<ShareResponse>(`/api/radars/${mateRadar.id}/members`, {
    email: INVITED_BY_USER,
    role: 'viewer',
  });

  const adminInvite: SeededInvite = {
    token: tokenFrom(adminShare, INVITED_BY_ADMIN),
    email: INVITED_BY_ADMIN,
    radarName: house.name,
    inviterName: 'Owner Okonkwo',
  };
  const userInvite: SeededInvite = {
    token: tokenFrom(userShare, INVITED_BY_USER),
    email: INVITED_BY_USER,
    radarName: 'Allotment',
    inviterName: 'Mate Nakamura',
  };

  /* -- two published microblogs, one loudly themed and one not ------------ */

  /*
   * The public microblog is the surface the product owner actually pointed at, and it is the
   * only screen in the product a stranger loads. Both are seeded because the
   * assertion that matters is a *comparison*: Geocities is the loudest theme in
   * the vocabulary, so if a byline stays legible under it, it stays legible.
   * Without the unthemed twin, "the theme is applied" could pass on a page where
   * nothing was applied to anything.
   */
  const published: SeededPublic[] = [];
  for (const [name, preset] of [
    ['Old Web', 'geocities'],
    ['Notes', null],
  ] as const) {
    const { radar } = await owner.post<{ radar: RadarRow }>('/api/radars', {
      name,
      accent: 'bubblegum',
      glyph: 'lightbulb',
      template: 'microblog',
      ...(preset ? { theme: { preset } } : {}),
    });
    for (const body of [
      'Hello world.',
      'A capture app that infers everything rather than asking. #idea',
    ]) {
      await owner.post(`/api/radars/${radar.id}/blips`, { body });
    }
    const put = await owner.put<{ radar: RadarRow }>(`/api/radars/${radar.id}/visibility`, {
      visibility: 'public',
    });
    if (!put.radar.publicSlug) throw new Error(`seed did not publish ${name}`);
    published.push({ slug: put.radar.publicSlug, name, preset });
  }

  const counts = await owner.call<{ total: number }>('/api/notifications/counts?box=needs_you');
  if (counts.total <= 0) {
    throw new Error('seed produced no unread notifications — the badge checks would prove nothing');
  }

  /* -- the search needle -------------------------------------------------- */

  const search: SeededSearch = {
    needle: 'pelmet',
    matches: 2,
    radarName: house.name,
    radarId: house.id,
    missingRadar: 'norsuchradar',
  };
  await owner.post(`/api/radars/${house.id}/blips`, {
    body: `# The ${search.needle}\nMeasure it before ordering the blind.`,
  });
  await owner.post(`/api/radars/${house.id}/blips`, {
    body: `Ask about a ${search.needle} for the back room too.`,
  });

  // The whole search block downstream is an assertion about this number, so a
  // fixture that silently stopped producing it would make every one of those
  // checks pass by finding nothing. Same rule as the notification count above.
  const found = await owner.call<{ items: unknown[]; unresolved: boolean }>(
    `/api/search?q=${encodeURIComponent(search.needle)}`,
  );
  if (found.items.length !== search.matches) {
    throw new Error(
      `seed expected ${search.matches} blips matching "${search.needle}", found ${found.items.length} — the search checks would prove nothing`,
    );
  }
  const missing = await owner.call<{ unresolved: boolean }>(
    `/api/search?q=${encodeURIComponent(`in:${search.missingRadar}`)}`,
  );
  if (!missing.unresolved) {
    throw new Error(
      `"${search.missingRadar}" resolved to a real radar — the unresolved-filter check would prove nothing`,
    );
  }

  const seededRadars = (await owner.call<{ radars: RadarRow[] }>('/api/radars')).radars.map(
    (r) => ({
      id: r.id,
      name: r.name,
      template: r.template,
    }),
  );

  return {
    baseUrl: base,
    ownerCookie: owner.sessionCookie,
    radars: seededRadars,
    topicId: topic.id,
    dropBoxId: dropBox.id,
    unreadTotal: counts.total,
    adminInvite,
    userInvite,
    search,
    published,
  };
}
