/**
 * The Activity tab: one timeline, newest first, grouped by day — sessions,
 * prompt versions, brief changes, memory changes, sharing. It is what replaced review
 * (docs/AGENT_REPO.md §V2.2): visibility instead of a gate. Nothing here waits
 * for anybody; it only says what happened, where, and who cosigned it.
 */
import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { ActivityItemDto, BriefOp, MemoryOp } from '@onmyradar/contract';
import { api } from '../lib/api';
import { queryKeys } from '../lib/session';
import { Spinner } from './primitives';
import { QueryError } from './query-error';
import { HarnessChip, Segmented, useWho } from './repo-common';
import { useAgentPage } from './repo-context';

type Filter = 'all' | 'prompt' | 'briefs' | 'memory' | 'sessions' | 'sharing';

const FILTERS: ReadonlyArray<{ value: Filter; label: string }> = [
  { value: 'all', label: 'Everything' },
  { value: 'prompt', label: 'Prompt' },
  { value: 'briefs', label: 'Briefs' },
  { value: 'memory', label: 'Memory' },
  { value: 'sessions', label: 'Sessions' },
  { value: 'sharing', label: 'Sharing' },
];

const MARK: Record<MemoryOp, { sign: string; tone: string; label: string }> = {
  create: { sign: '+', tone: 'is-add', label: 'added' },
  update: { sign: '~', tone: 'is-change', label: 'changed' },
  append: { sign: '~', tone: 'is-change', label: 'added to' },
  forget: { sign: '−', tone: 'is-remove', label: 'deleted' },
  restore: { sign: '+', tone: 'is-add', label: 'restored' },
};

const BRIEF_MARK: Record<BriefOp, { sign: string; tone: string; label: string }> = {
  create: { sign: '+', tone: 'is-add', label: 'added' },
  update: { sign: '~', tone: 'is-change', label: 'changed' },
  rename: { sign: '~', tone: 'is-change', label: 'renamed' },
  delete: { sign: '−', tone: 'is-remove', label: 'deleted' },
};

function dayOf(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
  });
}

const timeOf = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

export function ActivityTab() {
  const { agent } = useAgentPage();
  const [filter, setFilter] = useState<Filter>('all');
  const pages = useInfiniteQuery({
    queryKey: queryKeys.repoAgentPart(agent.id, 'activity', filter),
    queryFn: ({ pageParam }) =>
      api.agentRepo.activity(agent.id, {
        kind: filter,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    initialPageParam: '',
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const items = pages.data?.pages.flatMap((page) => page.items) ?? [];
  const days: Array<{ day: string; items: ActivityItemDto[] }> = [];
  for (const item of items) {
    const day = dayOf(item.at);
    const last = days.at(-1);
    if (last?.day === day) last.items.push(item);
    else days.push({ day, items: [item] });
  }

  return (
    <div className="activity-tab">
      <Segmented label="Show" value={filter} onChange={setFilter} options={FILTERS} />
      {pages.isLoading ? <Spinner label="Reading its activity" /> : null}
      {pages.error ? (
        <QueryError error={pages.error} resource="Activity" retry={() => pages.refetch()} />
      ) : null}
      {!pages.isLoading && !pages.error && items.length === 0 ? (
        <p className="note py-8">
          {filter === 'all'
            ? 'Nothing yet. Use the agent in a tool — its sessions, and what it writes, appear here.'
            : 'Nothing of this kind yet.'}
        </p>
      ) : null}
      {days.map(({ day, items: dayItems }) => (
        <section key={day} className="activity-day" aria-label={day}>
          <h3 className="instrument">{day}</h3>
          <ol className="activity-list">
            {dayItems.map((item, index) => (
              <li key={`${item.at}-${index}`} className="activity-item">
                <time dateTime={item.at}>{timeOf(item.at)}</time>
                <ActivityLine item={item} />
              </li>
            ))}
          </ol>
        </section>
      ))}
      {pages.hasNextPage ? (
        <button
          className="btn mt-3"
          disabled={pages.isFetchingNextPage}
          onClick={() => void pages.fetchNextPage()}
        >
          Earlier
        </button>
      ) : null}
    </div>
  );
}

function Cosigner({ item }: { item: ActivityItemDto }) {
  const who = useWho();
  if (!item.cosigner) return null;
  const name = who(item.cosigner);
  return item.byAgent ? (
    <>
      {' · '}
      <span className="cosign">
        cosigned by <span className="human">{name}</span>
      </span>
    </>
  ) : (
    <>
      {' · by '}
      <span className="human">{name}</span>
    </>
  );
}

function ActivityLine({ item }: { item: ActivityItemDto }) {
  const { agent } = useAgentPage();
  const where = [item.clientLabel, item.workspace].filter(Boolean).join(' · ');
  const changes =
    item.memoryChanges.length > 0 ? (
      <span className="activity-changes">
        {item.memoryChanges.map((change, index) => {
          const mark = MARK[change.op];
          return (
            <span key={`${change.name}-${index}`} className={`activity-change ${mark.tone}`}>
              <span aria-hidden="true">{mark.sign} </span>
              <span className="sr-only">{mark.label} </span>
              {agent.access.memory === 'none' || change.op === 'forget' ? (
                change.name
              ) : (
                <Link
                  to="/repo/$agentId/memory"
                  params={{ agentId: agent.id }}
                  search={{ m: change.name }}
                >
                  {change.name}
                </Link>
              )}
            </span>
          );
        })}
      </span>
    ) : null;

  switch (item.kind) {
    case 'session':
      return (
        <div className="activity-text">
          <strong>
            <HarnessChip {...item} />
          </strong>
          {where ? <span className="text-[color:var(--paper-dim)]"> · {where}</span> : null} ·
          session
          <Cosigner item={item} />
          {item.summary ? ` · ${item.summary}` : ''}
          {changes}
        </div>
      );
    case 'prompt':
      return (
        <div className="activity-text">
          {item.proposal ? (
            <>
              Prompt change <strong>proposed</strong>
            </>
          ) : (
            <>
              Prompt <strong>v{item.version ?? '?'}</strong>
            </>
          )}
          {item.byAgent ? (
            <>
              {' '}
              · {item.proposal ? 'by' : item.editor ? 'edited by' : 'by'}{' '}
              {item.editor ?? 'the agent'}
              {item.harness ? (
                <>
                  {' '}
                  in <HarnessChip {...item} />
                </>
              ) : null}
            </>
          ) : null}
          {item.proposal ? (
            <>
              {' '}
              ·{' '}
              {item.proposal === 'pending'
                ? 'waiting for the owner'
                : item.proposal === 'accepted'
                  ? `accepted as v${item.version ?? '?'}`
                  : 'rejected'}
            </>
          ) : null}
          <Cosigner item={item} />
          {item.note ? (
            <span className="text-[color:var(--paper-dim)]"> · “{item.note}”</span>
          ) : null}
          {item.version ? (
            <>
              {' · '}
              <Link
                className="accent-text"
                to="/repo/$agentId"
                params={{ agentId: agent.id }}
                search={{ history: item.version }}
              >
                View diff
              </Link>
            </>
          ) : item.proposal === 'pending' ? (
            <>
              {' · '}
              <Link className="accent-text" to="/repo/$agentId" params={{ agentId: agent.id }}>
                Review
              </Link>
            </>
          ) : null}
        </div>
      );
    case 'brief': {
      const brief = item.brief;
      if (!brief) return <div className="activity-text">{item.summary}</div>;
      const mark = BRIEF_MARK[brief.op];
      const name =
        brief.op === 'delete' ? (
          <strong>{brief.name}</strong>
        ) : (
          <Link
            to="/repo/$agentId/briefs"
            params={{ agentId: agent.id }}
            search={{ b: brief.name }}
          >
            <strong>{brief.name}</strong>
          </Link>
        );
      return (
        <div className="activity-text">
          <span className={`activity-change ${mark.tone}`}>
            <span aria-hidden="true">{mark.sign} </span>
          </span>
          Brief {name}{' '}
          {brief.op === 'rename' ? (
            <>
              renamed from <strong>{brief.previousName}</strong>
            </>
          ) : brief.op === 'update' ? (
            <>r{item.version ?? '?'}</>
          ) : (
            mark.label
          )}
          {item.byAgent ? (
            <>
              {' '}
              · by the agent
              {item.harness ? (
                <>
                  {' '}
                  in <HarnessChip {...item} />
                </>
              ) : null}
            </>
          ) : null}
          <Cosigner item={item} />
          {item.note ? (
            <span className="text-[color:var(--paper-dim)]"> · “{item.note}”</span>
          ) : null}
          {brief.op === 'update' && item.version ? (
            <>
              {' · '}
              <Link
                className="accent-text"
                to="/repo/$agentId/briefs"
                params={{ agentId: agent.id }}
                search={{ b: brief.name, history: item.version }}
              >
                View diff
              </Link>
            </>
          ) : null}
        </div>
      );
    }
    case 'memory':
      return (
        <div className="activity-text">
          {item.summary || 'Memory'}
          {item.byAgent && item.harness ? (
            <>
              {' '}
              · by the agent in <HarnessChip {...item} />
            </>
          ) : null}
          <Cosigner item={item} />
          {changes}
        </div>
      );
    case 'share':
    case 'transfer':
      return <div className="activity-text">{item.summary}</div>;
  }
}
