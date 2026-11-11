/**
 * Admin → Overview: the instance at a glance.
 *
 * Counts, not charts. Each number is a headline with one place to act on it,
 * so the tiles that have a section link to it — "3 waiting" is a way into the
 * queue, not only a fact about it.
 */
import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { HARNESSES, HARNESS_IDS, type AdminOverviewDto, type Harness } from '@onmyradar/contract';
import { api } from '../lib/api';
import { queryKeys } from '../lib/session';
import { Section, Spinner } from '../components/primitives';
import { QueryError } from '../components/query-error';
import { useDocumentTitle } from '../lib/title';

const count = new Intl.NumberFormat();

/** A tool id's label, or the raw id for one this build does not know. */
export function harnessLabel(harness: string): string {
  return (HARNESS_IDS as readonly string[]).includes(harness)
    ? HARNESSES[harness as Harness].label
    : harness;
}

function Tile({
  label,
  value,
  detail,
  to,
  linkLabel,
}: {
  label: string;
  value: number;
  detail?: ReactNode;
  to?: '/admin/people' | '/admin/models';
  linkLabel?: string;
}) {
  return (
    <div className="panel flex min-w-0 flex-col gap-1 p-4">
      <span className="instrument">{label}</span>
      <span className="text-[26px] leading-tight font-semibold tracking-tight tabular-nums">
        {count.format(value)}
      </span>
      {detail ? (
        <span className="text-[12.5px] text-[color:var(--paper-dim)]">{detail}</span>
      ) : null}
      {to ? (
        <Link to={to} className="accent-text mt-1 inline-flex min-h-11 items-center text-[13px]">
          {linkLabel} →
        </Link>
      ) : null}
    </div>
  );
}

/**
 * Load sessions by tool, most-used first. One series, so one hue and no legend;
 * the number is always printed beside its bar, so nothing is read from length
 * alone.
 */
function SessionsByTool({ rows }: { rows: AdminOverviewDto['sessionsByHarness'] }) {
  const sorted = [...rows].sort((a, b) => b.count - a.count);
  const max = Math.max(1, ...sorted.map((row) => row.count));
  if (sorted.length === 0) {
    return (
      <p className="text-[13px] text-[color:var(--paper-faint)]">
        No agent has been loaded in the last 7 days.
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-2.5" aria-label="Load sessions in the last 7 days, by tool">
      {sorted.map((row) => (
        <li key={row.harness} className="flex flex-col gap-1">
          <div className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 truncate text-[13.5px]">{harnessLabel(row.harness)}</span>
            <span className="instrument shrink-0 tabular-nums">{count.format(row.count)}</span>
          </div>
          <div className="h-1 rounded-full bg-[color:var(--line-soft)]" aria-hidden>
            <div
              className="h-1 rounded-full bg-[color:var(--accent-from)]"
              style={{ width: `${Math.max(2, (row.count / max) * 100)}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function AdminOverviewRoute() {
  useDocumentTitle('Admin');
  const query = useQuery({
    queryKey: queryKeys.adminOverview,
    queryFn: () => api.admin.overview(),
  });

  if (query.isLoading) return <Spinner label="Loading the overview" />;
  if (query.error || !query.data) {
    return <QueryError error={query.error} resource="Overview" retry={() => query.refetch()} />;
  }
  const { users, agents, memories, models, sessionsByHarness } = query.data;
  const sessions = sessionsByHarness.reduce((sum, row) => sum + row.count, 0);

  return (
    <div className="flex flex-col gap-6">
      <Section title="People" bare>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Tile label="Active" value={users.active} to="/admin/people" linkLabel="People" />
          <Tile
            label="Waiting"
            value={users.pending}
            detail={
              users.pending > 0 ? 'Nobody gets in until you approve them.' : 'Nobody waiting.'
            }
            to="/admin/people"
            linkLabel={users.pending > 0 ? 'Review the waitlist' : 'People'}
          />
          <Tile label="Suspended" value={users.suspended} />
        </div>
      </Section>

      <Section title="Agents" bare>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Tile label="Agents" value={agents} />
          <Tile label="Memories" value={memories} />
          <Tile
            label="Models"
            value={models.total}
            detail={models.hidden > 0 ? `${count.format(models.hidden)} hidden` : 'None hidden'}
            to="/admin/models"
            linkLabel="Model catalog"
          />
        </div>
      </Section>

      <Section title={`Sessions · last 7 days · ${count.format(sessions)}`}>
        <SessionsByTool rows={sessionsByHarness} />
      </Section>
    </div>
  );
}
