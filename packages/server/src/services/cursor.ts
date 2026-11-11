/**
 * The page cursor codec, shared by every paginated surface.
 *
 * A cursor is base64url-encoded JSON carrying the sort keys of the last row on
 * the page. What those keys *are* differs per surface — the stream sorts on
 * `(pinned, created_at, id)`, relevance sorts on `(score, created_at, id)`, a
 * thread sorts on its root — so the payload stays the caller's business and only
 * the envelope lives here.
 *
 * It lives here rather than in each service because the rule about what counts
 * as a cursor at all had already been written down four times, in four places,
 * with two of them wrong. `listBlipsSchema` capped it at 200 characters while
 * the encoder emitted 208–238; `listCommentsSchema` capped it at 200 while the
 * threaded encoder emitted 247. Page 2 of the radar stream, the tag page, the
 * comment thread and both public routes were a 400 against their own server's
 * output — latent only because a page is 50 blips.
 *
 * The sharp half was the divergence. The REST schemas capped the cursor and the
 * MCP tools declared `z.string()` with no cap, so **an agent could page a radar
 * that a browser could not**: the same request, the same service, two answers.
 * That is precisely what one service layer behind two transports exists to make
 * impossible.
 *
 * So the decision is made once, here, on the path both transports take. A cursor
 * the contract would refuse is refused at the decode as well, whichever
 * transport carried it, and whatever that transport's own edge schema happened
 * to say. `cursorSchema` in the contract keeps the browser from being told about
 * it a round trip late; this function is what actually decides.
 */
import { cursorSchema } from '@onmyradar/contract';

/**
 * base64url rather than base64: a cursor travels in a query string, and `+` and
 * `/` need escaping there. `Buffer` emits no padding, which is why
 * `cursorSchema`'s charset has no `=` in it.
 */
export function encodeCursor(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * `null` for anything that is not a cursor — a truncated paste, a blob from a
 * different deployment, something a bored person typed. Callers turn that into a
 * 400 rather than silently restarting at page 1, because a cursor that quietly
 * means "the beginning" makes a paging loop run forever.
 *
 * Deliberately tolerant about the *fields*: a cursor issued before a sort key
 * existed is missing that key and must keep paging rather than 400, because
 * deploys are rolling and a cursor lives in a browser tab. Each caller fills its
 * own gaps. Tolerance about shape and tolerance about age are different
 * questions and only the first one is decided here.
 */
export function decodeCursor(raw: string): Record<string, unknown> | null {
  // The contract's rule, applied to both transports at the one point they share.
  // Cheap, and it is what stops a megabyte of query string reaching JSON.parse.
  if (!cursorSchema.safeParse(raw).success) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    // `JSON.parse('7')` and `JSON.parse('null')` both succeed. A cursor is an
    // object of sort keys; anything else is not one, however well it decodes.
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/*
 * The keys inside a cursor are cast in SQL — `::timestamptz`, `::uuid`,
 * `::real`, `::int` — and a cursor is unsigned, so anybody can hand one back
 * with anything in it. A value Postgres refuses to cast is a 500 and an
 * error-level log line, reachable unauthenticated through the public radar and
 * thread routes. These say "not a cursor" first, so the caller answers 400.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `timestamptz::text` in the ISO DateStyle, whatever the session's zone; or an ISO string. */
const TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-](?:0\d|1[0-5])(?::?[0-5]\d)?)?$/;
/** How Postgres renders a `real`: `0.0607927`, `12`, `1e-05`. */
const REAL = /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/i;

export function isCursorUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/** A timestamp in the shape Postgres emits, naming a moment the calendar has. */
export function isCursorTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = TIMESTAMP.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  if (year === undefined || month === undefined || day === undefined) return false;
  if (hour === undefined || minute === undefined || second === undefined) return false;
  // Built field by field, because `Date.UTC` reads years 0–99 as 1900–1999.
  const at = new Date(0);
  at.setUTCFullYear(year, month - 1, day);
  at.setUTCHours(hour, minute, second);
  return (
    year >= 1 &&
    at.getUTCFullYear() === year &&
    at.getUTCMonth() === month - 1 &&
    at.getUTCDate() === day &&
    at.getUTCHours() === hour &&
    at.getUTCMinutes() === minute &&
    at.getUTCSeconds() === second
  );
}

export function isCursorReal(value: unknown): value is string {
  return typeof value === 'string' && REAL.test(value) && Number.isFinite(Number(value));
}

export function isCursorInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && Math.abs(value) <= 2_147_483_647;
}
