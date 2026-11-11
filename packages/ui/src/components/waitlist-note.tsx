/**
 * What a pending account told the waitlist form, on the admin screen.
 *
 * Marked as the form's and unverified, because it is: whoever typed the
 * address typed these too, and nothing about approving someone should read as
 * though the name or the use case had been checked.
 */
import type { AdminUserDto } from '@onmyradar/contract';
import { fullTime, relativeTime } from '../lib/format';

const USE_CASE: Record<NonNullable<NonNullable<AdminUserDto['waitlist']>['useCase']>, string> = {
  personal: 'Personal',
  team: 'Team',
  agent_builder: 'Agent builder',
};

export function WaitlistNote({ waitlist }: { waitlist: NonNullable<AdminUserDto['waitlist']> }) {
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-[color:var(--paper-dim)]">
      <span className="instrument">waitlist form · unverified</span>
      {waitlist.useCase ? (
        <span className="instrument rounded-full border border-[color:var(--line)] px-2 py-0.5 !tracking-normal text-[color:var(--paper)]">
          {USE_CASE[waitlist.useCase]}
        </span>
      ) : null}
      {waitlist.source ? <span>via {waitlist.source}</span> : null}
      <span title={fullTime(waitlist.requestedAt)}>
        requested {relativeTime(waitlist.requestedAt)}
      </span>
    </div>
  );
}
