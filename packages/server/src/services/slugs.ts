/** Let the unique index arbitrate competing creates/renames; retry only its conflict. */
import { randomBytes } from 'node:crypto';
import { slugify } from '@onmyradar/contract';
import { conflict } from '../http.js';

type SlugConstraint = 'radars_owner_slug_key' | 'topics_owner_slug_key';

/**
 * Whether `error` is a unique violation of exactly `constraint`. Drizzle wraps
 * the PostgreSQL error in `cause`, so the chain is walked; any other constraint
 * — or any other error — is not hidden.
 */
export function isUniqueViolation(error: unknown, constraint: string): boolean {
  for (
    let current = error, depth = 0;
    current && typeof current === 'object' && depth < 5;
    depth += 1
  ) {
    const detail = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (detail.code === '23505' && detail.constraint === constraint) return true;
    current = detail.cause;
  }
  return false;
}

export async function withUniqueSlug<T>(
  name: string,
  constraint: SlugConstraint,
  write: (slug: string) => Promise<T>,
): Promise<T> {
  const base = slugify(name);
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const slug =
      attempt === 0
        ? base
        : attempt < 50
          ? `${base}-${attempt + 1}`
          : `${base}-${randomBytes(6).toString('hex')}`;
    try {
      return await write(slug);
    } catch (err) {
      if (!isUniqueViolation(err, constraint)) throw err;
    }
  }
  throw conflict('Could not allocate a unique address. Try again.');
}
