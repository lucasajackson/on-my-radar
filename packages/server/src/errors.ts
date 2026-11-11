/**
 * Reading a message off something that was thrown.
 *
 * `catch (err)` is typed `unknown` — `useUnknownInCatchVariables` is on via
 * `strict` — and the codebase had settled on `(err as Error).message` to get
 * past that. The cast is a lie in two ways that both bite:
 *
 * - **A thrown string** (or number, or object literal) has no `.message`, so
 *   the expression is `undefined` and every caller silently falls back to its
 *   generic text. The actual words are discarded at the one moment somebody
 *   needs them.
 * - **A thrown `null` or `undefined`** makes `(err as Error).message` throw a
 *   `TypeError` *inside the catch block*, which escapes the handler entirely.
 *   That turns an error boundary into a hole: `mcp/server.ts`'s `guard` would
 *   stop returning a tool result at all, and `webhooks.ts` would skip
 *   `noteFailure` and leave the sender's only diagnostic reading as though the
 *   last delivery had succeeded.
 *
 * Neither is exotic. A rejected `fetch`, a library that throws a plain object,
 * `Promise.reject()` with no argument — all reachable from code this process
 * already runs.
 *
 * Kept in its own module rather than in `http.ts` so that `db/migrate.ts`, which
 * runs as a standalone `pnpm migrate` entrypoint, can use it without pulling
 * Hono in behind it.
 */

/** The message, if there genuinely is one; otherwise the caller's fallback. */
export function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message || fallback;
  if (typeof err === 'string') return err || fallback;
  // A thrown object with a string `message` — what a number of libraries do
  // instead of subclassing Error. Worth reading; never worth casting to get.
  if (typeof err === 'object' && err !== null) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  return fallback;
}

/**
 * The `name`, for the one caller that branches on it: `oidc.ts` tells a
 * `TimeoutError` apart from an unreachable host, because the two need different
 * sentences and only one of them is worth retrying.
 */
export function errorName(err: unknown): string | null {
  if (err instanceof Error) return err.name;
  if (typeof err === 'object' && err !== null) {
    const name = (err as { name?: unknown }).name;
    if (typeof name === 'string') return name;
  }
  return null;
}

/**
 * The PostgreSQL SQLSTATE behind a thrown error, if there is one.
 *
 * Drizzle wraps the driver's error in `cause`, so the code is looked for down
 * a short chain rather than on the thrown object itself.
 */
export function postgresCode(err: unknown): string | null {
  let current = err;
  for (let depth = 0; current && typeof current === 'object' && depth < 5; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * `22P02 invalid_text_representation`: a value Postgres could not read as its
 * column's type. Enums and numbers are validated before they reach SQL, so in
 * practice this is an id that is not a uuid — `/api/blips/abc`, or a hook URL
 * somebody mistyped. That is a request for something that does not exist, not
 * a fault on our side: a 404, rather than a 500 that logs at error level and,
 * outside production, echoes the query.
 */
export function isMalformedId(err: unknown): boolean {
  return postgresCode(err) === '22P02';
}

/**
 * The database gave up on a statement, or on waiting for a lock: `57014` is
 * `statement_timeout` (and a cancel), `55P03` is `lock_timeout`. Both are the database
 * being too busy for this request right now, which the caller can retry, not a fault in
 * the request, so they answer 503 with a `Retry-After` rather than an opaque 500.
 */
export function isDatabaseBusy(err: unknown): boolean {
  const code = postgresCode(err);
  // `40P01` deadlock_detected and `40001` serialization_failure: the database rolled one of two
  // writers back to let the other through. Nothing of theirs was kept, so the same request is
  // worth sending again; never the opaque 500 that says the fault is ours.
  return code === '57014' || code === '55P03' || isTransactionConflict(err);
}

/** `40P01` (deadlock) or `40001` (serialization failure): the transaction was rolled back whole. */
export function isTransactionConflict(err: unknown): boolean {
  const code = postgresCode(err);
  return code === '40P01' || code === '40001';
}

/**
 * Runs one whole transaction (the function opens it, so nothing it did survives a failure) and,
 * when the database rolled it back as a deadlock or serialization victim, runs it once more. A
 * second conflict is thrown as it is and answers 503 with `Retry-After` (`isDatabaseBusy`).
 */
export async function retryOnConflict<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!isTransactionConflict(error)) throw error;
    return run();
  }
}

/**
 * A value that cannot be missing, checked rather than asserted.
 *
 * For an INSERT … RETURNING row, the one DTO hydrated from one input, or a
 * test's "this is here". `row!` tells the compiler to stop asking and, when the
 * row is not there after all, lets the next line die on "Cannot read properties
 * of undefined", which names neither what was missing nor why it was expected.
 * This fails at the point the expectation broke, with a sentence.
 */
export function must<T>(value: T, what = 'a value'): NonNullable<T> {
  if (value === null || value === undefined) {
    throw new Error(`Expected ${what}, got ${String(value)}`);
  }
  return value;
}
