/**
 * A slug field someone is typing into.
 *
 * `repoSlugFrom` is the final form: it trims hyphens off both ends, which is
 * right for a slug and wrong for a keystroke. Running it on every change made
 * `pr-review` impossible to type — the hyphen vanished the moment it was
 * pressed, so the field read `prreview`. A draft keeps one trailing hyphen,
 * because it is the start of the next word; `repoSlugFrom(draft)` is what gets
 * sent.
 */
import { AGENT_REPO } from '@onmyradar/contract';

export function slugDraft(value: string, max: number = AGENT_REPO.slugLength): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, max);
}
