/**
 * What the wide templates say about the open item, shared by every template that has a panel: the
 * name an untitled item goes by, how many replies and when, and the facts column.
 */
import type { BlipDto, RadarDto } from '@onmyradar/contract';
import { findStatus } from '@onmyradar/contract';
import { RelativeTime } from '../components/relative-time';

/** A thread with no title is named by its first line. */
export const nameOf = (blip: BlipDto) =>
  blip.title ??
  (blip.body
    .replace(/^[#>*\s-]+/, '')
    .split('\n')[0]
    ?.slice(0, 120) ||
    'Untitled');

/** "3 replies" / "no replies yet", then when the last one landed. */
export function ThreadMeta({
  blip,
  replyNoun,
  className = 'thread-meta',
}: {
  blip: BlipDto;
  replyNoun: string;
  className?: string;
}) {
  const answered = blip.lastActivityAt !== blip.createdAt;
  return (
    <div className={className}>
      <span className="instrument">
        {blip.commentCount === 0
          ? `no ${replyNoun === 'reply' ? 'replies' : `${replyNoun}s`} yet`
          : `${blip.commentCount} ${blip.commentCount === 1 ? replyNoun : 'replies'}`}
      </span>
      {answered ? (
        <span className="instrument thread-meta-when">
          last <RelativeTime iso={blip.lastActivityAt} />
        </span>
      ) : null}
    </div>
  );
}

/** What can be said about a thread without reading it. Rows with nothing to say are left out. */
export function SidePanel({
  blip,
  radar,
  loaded,
  onSelect,
}: {
  blip: BlipDto;
  radar: RadarDto;
  loaded: ReadonlySet<string>;
  onSelect: (id: string) => void;
}) {
  const lane = findStatus(radar.template, blip.status, radar.templateConfig);
  const starter = blip.voice === 'persona' && blip.agent ? blip.agent.name : blip.author?.name;
  const people = [starter ?? blip.author?.email, ...(blip.mentions ?? []).map((m) => m.name)];
  const linked = [
    blip.supersedes
      ? { id: blip.supersedes, label: `Replaces ${blip.supersedesTitle ?? 'a thread'}` }
      : null,
    blip.supersededBy
      ? { id: blip.supersededBy.id, label: `Replaced by ${blip.supersededBy.title ?? 'a thread'}` }
      : null,
  ].filter((link) => link !== null);
  const rows: [string, React.ReactNode][] = [
    ['Status', lane?.label ?? blip.state],
    ['Participants', people.filter(Boolean).join(', ')],
    ['Tags', blip.tags.map((tag) => `#${tag}`).join(' ')],
    [
      'Linked',
      linked.length
        ? linked.map((link) =>
            loaded.has(link.id) ? (
              <button key={link.id} className="disc-link" onClick={() => onSelect(link.id)}>
                {link.label}
              </button>
            ) : (
              <span key={link.id}>{link.label}</span>
            ),
          )
        : '',
    ],
  ];
  return (
    <aside className="cols-panel" aria-label="About this thread">
      {rows
        .filter(([, value]) => value !== '')
        .map(([label, value]) => (
          <div key={label}>
            <h3 className="instrument">{label}</h3>
            <p>{value}</p>
          </div>
        ))}
    </aside>
  );
}
