/**
 * The due date on a card, in a search result and in the header's quick results.
 *
 * Its own module so those surfaces do not pull in the due-date dialog and the
 * select it uses: the header search is in the first paint, the dialog is not.
 */
import { Bell, CalendarClock } from 'lucide-react';
import type { BlipDto } from '@onmyradar/contract';

export function DueChip({ blip, personal = false }: { blip: BlipDto; personal?: boolean }) {
  if (!blip.dueAt) return null;
  const overdue =
    new Date(blip.dueAt).getTime() < Date.now() && !['done', 'dropped'].includes(blip.state);
  return (
    <span className={`due-chip ${overdue ? 'is-overdue' : ''}`}>
      <CalendarClock size={14} />
      <time dateTime={blip.dueAt}>
        {overdue ? 'Overdue · ' : 'Due '}
        {new Date(blip.dueAt).toLocaleString(undefined, {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        })}
      </time>
      {personal && blip.reminder ? <Bell size={13} aria-label="Personal reminder set" /> : null}
    </span>
  );
}
