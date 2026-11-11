import { getEmailDetail } from '../services/email-reader.js';
/**
 * Anonymous access to radars that have been made public.
 *
 * Public reads go through their own routes rather than reusing the private ones
 * with a null actor, for two reasons: the public identifier is the unguessable
 * `public_slug` (never the uuid), and the responses are deliberately narrower —
 * member emails and author addresses never appear on a public page.
 */
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { listBlipsSchema, listCommentsSchema, accentFor, type BlipDto } from '@onmyradar/contract';
import { getDb, schema } from '../db/client.js';
import { notFound, readQuery, type AppEnv } from '../http.js';
import { getRadarAccess, neverPublic } from '../services/access.js';
import { listBlips, liveExpr } from '../services/blips.js';
import { listComments } from '../services/comments.js';
import { getRadarDto } from '../services/radars.js';
import { narrowBlip } from '../services/redaction.js';
import { createDownloadUrl } from '../services/storage.js';

export const publicRoutes = new Hono<AppEnv>();

/**
 * What to strip is decided in `services/redaction.ts`, from the access rather
 * than from which route was called.
 *
 * These wrappers used to *be* the definition, which made the narrowing a
 * property of this file: the private routes and the MCP tools accept a
 * `public_slug` as an identifier too, and answered the same radar unredacted.
 * What is left here is the one genuinely route-shaped part — rewriting
 * attachment hrefs onto the public identity, because the private attachment
 * route requires membership.
 */
function redactBlip(blip: BlipDto, publicSlug: string): BlipDto {
  return {
    ...narrowBlip(blip),
    attachments: blip.attachments.map((a) => ({
      ...a,
      href: `/api/public/radars/${publicSlug}/attachments/${a.id}`,
    })),
  };
}

async function requirePublicRadar(publicSlug: string) {
  const access = await getRadarAccess(publicSlug, null);
  if (!access || !access.viaPublicLink) throw notFound('This radar is not public');
  // Belt and braces. `setVisibility` refuses to publish a smart radar and a
  // CHECK constraint refuses to store one — but a smart radar resolves against
  // the *caller's* readable radars, and an anonymous caller has none, so if one
  // ever did reach here it must not be served at all rather than served empty.
  if (access.radar.kind === 'smart') throw notFound('This radar is not public');
  // The same belt for a helpdesk, whose comments include internal notes about
  // a client: never served on the public surface, even if a row slipped past
  // the 0042 constraint and the refusals in front of it.
  // A former helpdesk counts: it still holds what it gathered.
  if (neverPublic(access.radar)) throw notFound('This radar is not public');
  return access;
}

publicRoutes.get('/radars/:slug', async (c) => {
  const access = await requirePublicRadar(c.req.param('slug'));
  // Already narrowed inside `getRadarDto`, which decides it from the access.
  return c.json({ radar: await getRadarDto(access) });
});

publicRoutes.get('/radars/:slug/blips', async (c) => {
  const slug = c.req.param('slug');
  const access = await requirePublicRadar(slug);
  const query = readQuery(c, listBlipsSchema);
  // Fifth argument is the template, so a public reading list reads as a queue
  // and a public decision log leads with what is in force — the same order the
  // owner sees. A public page that silently re-sorted itself would be a
  // different radar wearing the same name.
  //
  // `includeArchived` is refused here rather than honoured, and it is the one
  // argument this route overrides. It is on `listBlipsSchema` because the same
  // schema validates the private route and the MCP tool, so a stranger could
  // otherwise append it to the URL and read thirty abandoned cards off a board
  // whose owner published a page showing twelve. No public surface would ever
  // ask for it — there is no seam and no search on a published page — so the
  // flag would exist only for somebody who guessed at it. A published radar
  // shows its live work, which is the same narrowing this route already applies
  // to author addresses and member counts.
  const page = await listBlips(
    [access.radar.id],
    { ...query, includeArchived: false },
    null,
    null,
    access.radar,
  );
  return c.json({ items: page.items.map((b) => redactBlip(b, slug)), nextCursor: page.nextCursor });
});

/**
 * The thread on a public blip, read-only.
 *
 * A conversation that is invisible on the page it belongs to reads as missing
 * rather than as private, so it is served — but through the public identity,
 * narrowed by `narrowComment`: no author addresses, and `canDelete` forced
 * false because a stranger can never act on one. The write routes have no
 * public counterpart at all; `requireParticipation` refuses a caller with no
 * membership, which is the same rule stated twice on purpose.
 */
publicRoutes.get('/radars/:slug/blips/:blipId/comments', async (c) => {
  const slug = c.req.param('slug');
  const access = await requirePublicRadar(slug);
  const rows = await getDb()
    .select({ id: schema.blips.id })
    .from(schema.blips)
    .where(
      and(
        eq(schema.blips.id, c.req.param('blipId')),
        // Scoping by radar is what stops a public slug being used to read the
        // thread on a blip that lives on a different, private radar.
        eq(schema.blips.radarId, access.radar.id),
        // A published radar shows its live work: the blip list narrows to
        // `liveExpr`, and the thread under a blip that list no longer shows
        // must not stay readable by id.
        liveExpr,
      ),
    )
    .limit(1);
  if (!rows[0]) throw notFound('Blip not found');

  const query = readQuery(c, listCommentsSchema);
  // The **slug**, not the radar id. A public link grants access only when it is
  // the identifier that was used, so re-resolving this radar by its uuid inside
  // `listComments` would yield no access and 404 the thread on every published
  // blip. `listComments` cross-checks that the slug resolves to the blip's own
  // radar, so handing it down cannot widen anything.
  // Already narrowed inside `listComments`, which decides it from the access.
  const page = await listComments(null, rows[0].id, query, slug);
  return c.json({ items: page.items, nextCursor: page.nextCursor });
});

publicRoutes.get('/radars/:slug/attachments/:attachmentId', async (c) => {
  const access = await requirePublicRadar(c.req.param('slug'));
  const rows = await getDb()
    .select({ attachment: schema.attachments })
    .from(schema.attachments)
    .innerJoin(schema.blips, eq(schema.blips.id, schema.attachments.blipId))
    .where(
      and(
        eq(schema.attachments.id, c.req.param('attachmentId')),
        // Scoping by radar is what stops a public slug being used to fetch an
        // attachment that lives on a different, private radar.
        eq(schema.attachments.radarId, access.radar.id),
        liveExpr,
      ),
    )
    .limit(1);

  const attachment = rows[0]?.attachment;
  if (!attachment) throw notFound('Attachment not found');

  const url = await createDownloadUrl(
    attachment.objectKey,
    attachment.filename,
    attachment.contentType,
    c.req.query('download') === '1' ? 'attachment' : 'inline',
  );
  return c.redirect(url, 302);
});

/* --------------------------------- card ---------------------------------- */

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) =>
    ch === '&'
      ? '&amp;'
      : ch === '<'
        ? '&lt;'
        : ch === '>'
          ? '&gt;'
          : ch === '"'
            ? '&quot;'
            : '&apos;',
  );
}

/** Rough wrap for the SVG card; SVG has no text flow of its own. */
function wrap(text: string, perLine: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (current.length + word.length + 1 > perLine) {
      lines.push(current);
      current = word;
      if (lines.length === maxLines) break;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current && lines.length < maxLines) lines.push(current);
  return lines;
}

/**
 * A share card for the radar, in the radar's own accent. Served as SVG: it is
 * used in-app and by any consumer that renders SVG. The page does not advertise
 * it as `og:image` because the major social platforms will not rasterise SVG —
 * see docs/DESIGN.md, "Known limitations".
 */
publicRoutes.get('/radars/:slug/card.svg', async (c) => {
  const access = await requirePublicRadar(c.req.param('slug'));
  const radar = access.radar;
  const accent = accentFor(radar.accent);

  const titleLines = wrap(radar.name, 26, 2);
  const taglineLines = wrap(radar.tagline ?? radar.description ?? '', 46, 2);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="${escapeXml(radar.name)}">
  <rect width="1200" height="630" fill="#000000"/>
  <rect width="1200" height="630" fill="${accent.from}" opacity="0.12"/>
  ${[220, 320, 420, 520].map((r) => `<circle cx="980" cy="315" r="${r}" fill="none" stroke="${accent.from}" stroke-opacity="0.16"/>`).join('\n  ')}
  <circle cx="980" cy="315" r="14" fill="${accent.from}"/>
  <circle cx="1120" cy="200" r="8" fill="${accent.from}" opacity="0.8"/>
  <circle cx="880" cy="470" r="10" fill="${accent.from}" opacity="0.6"/>
  <text x="80" y="120" font-family="ui-sans-serif,system-ui,Segoe UI,Roboto,sans-serif" font-size="22" letter-spacing="6" fill="#b5b5b5">ON MY RADAR</text>
  ${titleLines
    .map(
      (line, i) =>
        `<text x="80" y="${250 + i * 78}" font-family="ui-sans-serif,system-ui,Segoe UI,Roboto,sans-serif" font-size="68" font-weight="700" fill="#f4f7ff">${escapeXml(line)}</text>`,
    )
    .join('\n  ')}
  ${taglineLines
    .map(
      (line, i) =>
        `<text x="80" y="${290 + titleLines.length * 78 + i * 38}" font-family="ui-sans-serif,system-ui,Segoe UI,Roboto,sans-serif" font-size="28" fill="#a9b6d8">${escapeXml(line)}</text>`,
    )
    .join('\n  ')}
  <rect x="80" y="520" width="180" height="6" rx="3" fill="${accent.from}"/>
</svg>`;

  c.header('content-type', 'image/svg+xml; charset=utf-8');
  // Not `public`: the card renders the radar's name and tagline, and a radar can
  // be unpublished or renamed at any moment. A shared cache holding it for five
  // minutes keeps serving what the owner has just withdrawn.
  c.header('cache-control', 'private, max-age=60');
  return c.body(svg);
});

publicRoutes.get('/radars/:slug/blips/:id/email', async (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json({
    email: await getEmailDetail(
      c.req.param('id'),
      null,
      c.req.param('slug'),
      c.req.query('images') === '1',
    ),
  });
});
