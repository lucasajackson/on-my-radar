/**
 * How the charter's links to boundaries and contracts read (plan e715ea20, S5): the list every
 * `read_architecture` and `trace` carries, and the state each element shows for it. Pure: the
 * rows come from the caller's snapshot, so a read is one consistent picture.
 */
import {
  blockAt,
  type CharterLinkDto,
  type ElementCharterDto,
  type TextProjection,
} from '@onmyradar/contract';
import type { schema } from '../db/client.js';

type AnchorRow = typeof schema.charterAnchors.$inferSelect;

/** The first words of a passage, for a list. */
export const EXCERPT_LENGTH = 120;

export const excerptOf = (quote: string): string => {
  const flat = quote.replace(/\s+/g, ' ').trim();
  return flat.length > EXCERPT_LENGTH ? `${flat.slice(0, EXCERPT_LENGTH - 1)}…` : flat;
};

/**
 * Every link that still means something (a dismissed one is an unlinked passage, history only),
 * in the order of the text, an orphan, which has no place, last. `elements` names the boundaries
 * and contracts of the radar; a link whose element is not in it (not read) is left out. An
 * anchored link says where it is in the head's text (`start`, `end`).
 */
export function buildLinks(
  rows: readonly AnchorRow[],
  elements: ReadonlyMap<string, { title: string | null; lane: string | null }>,
  projection: Pick<TextProjection, 'blocks'> | null,
): CharterLinkDto[] {
  return rows
    .filter((r) => r.kind === 'link' && r.state !== 'dismissed')
    .sort(
      (a, b) =>
        (a.posStart ?? Infinity) - (b.posStart ?? Infinity) ||
        a.createdAt.getTime() - b.createdAt.getTime() ||
        a.id.localeCompare(b.id),
    )
    .flatMap((r): CharterLinkDto[] => {
      const element = elements.get(r.subjectId);
      if (!element || (element.lane !== 'boundary' && element.lane !== 'contract')) return [];
      const section =
        r.state === 'anchored' && r.posStart !== null && projection
          ? (blockAt(projection as TextProjection, r.posStart)?.headingPath ?? null)
          : null;
      return [
        {
          id: r.id,
          element: { id: r.subjectId, title: element.title ?? '', kind: element.lane },
          state: r.state,
          excerpt: excerptOf(r.quote),
          section: section ? [...section] : null,
          resolvedVersion: r.resolvedVersion,
          ...(r.state === 'anchored' && r.posStart !== null && r.posEnd !== null
            ? { start: r.posStart, end: r.posEnd }
            : {}),
          ...(r.state === 'orphaned'
            ? {
                cause: r.orphanCause ?? 'text_changed',
                orphanedVersion: r.orphanedVersion,
              }
            : {}),
        },
      ];
    });
}

/**
 * What the charter says about each element that has links: `linked` when any of its links still
 * finds its words, `orphaned` when it has some and none does. An element with none is absent.
 */
export function elementCharter(links: readonly CharterLinkDto[]): Map<string, ElementCharterDto> {
  const out = new Map<string, ElementCharterDto>();
  for (const link of links) {
    const have = out.get(link.element.id) ?? { state: 'orphaned' as const, links: [] };
    have.links.push(link.id);
    if (link.state === 'anchored') have.state = 'linked';
    out.set(link.element.id, have);
  }
  return out;
}
