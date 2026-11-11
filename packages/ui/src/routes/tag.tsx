import { Select } from '../components/select';
import { QueryError } from '../components/query-error';
/**
 * A tag, across every radar.
 *
 * This is what a hashtag is *for*. You write `#bug` in three different radars
 * because that is how the thought arrived; this page is where those three
 * finally sit next to each other. It is also the doorway to a smart radar: once
 * you are looking at a tag and it turns out to be a real subject rather than a
 * passing label, you save the view rather than re-running the search.
 */
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Hash, Target } from 'lucide-react';
import { normalizeTag } from '@onmyradar/contract';
import { ApiError, api } from '../lib/api';
import { queryKeys, useRadars } from '../lib/session';
import { BlipCard } from '../components/blips';
import { Empty, Modal, RadarGlyph, Spinner, notify } from '../components/primitives';
import { accentStyle } from '../lib/theme';
import { useDocumentTitle } from '../lib/title';

export function TagRoute() {
  const { tag: raw } = useParams({ from: '/_app/t/$tag' });
  const tag = normalizeTag(raw);
  useDocumentTitle(`#${tag}`);
  const [saving, setSaving] = useState(false);

  const { data: radarData } = useRadars();
  const radars = useMemo(() => radarData?.radars ?? [], [radarData]);

  const blipsQuery = useInfiniteQuery({
    queryKey: queryKeys.tagBlips(tag),
    initialPageParam: undefined as string | undefined,
    // The cross-radar search endpoint already scopes to what the caller can
    // read, so there is nothing to filter here.
    queryFn: ({ pageParam }) => api.blips.search({ tag, cursor: pageParam }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: tag.length > 0,
  });

  const tagsQuery = useQuery({ queryKey: queryKeys.allTags, queryFn: () => api.blips.tags() });

  const blips = useMemo(
    () => blipsQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [blipsQuery.data],
  );

  // Which radars this tag actually spans — the fact that makes the page worth
  // having, so it is stated rather than left to be inferred from the cards.
  const spread = useMemo(() => {
    const ids = new Set(blips.map((b) => b.radarId));
    return radars.filter((r) => ids.has(r.id));
  }, [blips, radars]);

  const related = useMemo(() => {
    const counts = new Map<string, number>();
    for (const blip of blips) {
      for (const other of blip.tags) {
        if (other !== tag) counts.set(other, (counts.get(other) ?? 0) + 1);
      }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  }, [blips, tag]);

  const total = tagsQuery.data?.tags.find((t) => t.tag === tag)?.count ?? blips.length;

  if (!tag) {
    return <Empty title="That is not a tag" hint="Tags are written as #word inside a blip." />;
  }

  return (
    <div className="mx-auto flex max-w-[760px] flex-col gap-4 px-4 py-5 sm:px-6">
      <header className="flex flex-wrap items-start gap-3">
        <span className="mt-0.5 text-[color:var(--accent-from)]">
          <Hash className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[19px] leading-tight font-semibold tracking-tight">
            #{tag}
          </h1>
          <p className="instrument mt-1">
            {total} {total === 1 ? 'blip' : 'blips'}
            {spread.length > 0
              ? ` · across ${spread.length} ${spread.length === 1 ? 'radar' : 'radars'}`
              : ''}
          </p>
        </div>
        <button className="btn btn-accent" onClick={() => setSaving(true)}>
          <Target className="h-4 w-4" />
          Create smart radar
        </button>
      </header>

      {spread.length > 0 ? (
        <div className="scroll-area -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-0.5">
          {spread.map((radar) => (
            <span
              key={radar.id}
              className="flex shrink-0 items-center gap-1.5 rounded-full border border-[color:var(--line)] px-2.5 py-1 text-[12.5px] text-[color:var(--paper-dim)]"
              style={accentStyle(radar.accent)}
            >
              <span className="text-[color:var(--accent-from)]">
                <RadarGlyph glyph={radar.glyph} className="h-3.5 w-3.5" />
              </span>
              {radar.name}
            </span>
          ))}
        </div>
      ) : null}

      {related.length > 0 ? (
        <p className="instrument">
          often with{' '}
          {related.map(([other], index) => (
            <span key={other}>
              {index > 0 ? ' · ' : ''}
              <Link className="tag-link" to="/t/$tag" params={{ tag: other }}>
                #{other}
              </Link>
            </span>
          ))}
        </p>
      ) : null}

      {blipsQuery.isLoading ? (
        <Spinner label="Gathering" />
      ) : blipsQuery.error ? (
        <QueryError error={blipsQuery.error} resource="Blips" retry={() => blipsQuery.refetch()} />
      ) : blips.length === 0 ? (
        <Empty
          title={`Nothing tagged #${tag}`}
          hint="Write #tags inside a blip and they land here — from every radar at once."
        />
      ) : (
        <div className="divide-y divide-[color:var(--line-soft)]">
          {blips.map((blip) => {
            const radar = radars.find((r) => r.id === blip.radarId);
            return (
              // Each card wears its own radar's accent, so a mixed list still
              // reads as coming from somewhere.
              <div key={blip.id} style={accentStyle(radar?.accent)}>
                <BlipCard
                  blip={blip}
                  readOnly={!(radar?.access.canWrite ?? false)}
                  onChanged={() => void blipsQuery.refetch()}
                  {...(radar ? { template: radar } : {})}
                  commentsEnabled={radar?.commentsEnabled ?? true}
                  reactionsEnabled={radar?.reactionsEnabled ?? true}
                />
              </div>
            );
          })}
          {blipsQuery.hasNextPage ? (
            <div className="flex justify-center py-4">
              <button className="btn" onClick={() => void blipsQuery.fetchNextPage()}>
                Load more
              </button>
            </div>
          ) : null}
        </div>
      )}

      {saving ? (
        <SmartRadarDialog
          tag={tag}
          related={related.map(([t]) => t)}
          onClose={() => setSaving(false)}
        />
      ) : null}
    </div>
  );
}

/* ----------------------------- create a smart radar ---------------------------- */

function SmartRadarDialog({
  tag,
  related,
  onClose,
}: {
  tag: string;
  related: string[];
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const [name, setName] = useState(`#${tag}`);
  const [tags, setTags] = useState<string[]>([tag]);
  const [match, setMatch] = useState<'any' | 'all'>('any');
  const [busy, setBusy] = useState(false);

  const create = async () => {
    // Enter reached here without the button's guards, so a double Enter made two
    // radars and an Enter with every tag deselected sent a filter with none.
    if (busy || !name.trim() || tags.length === 0) return;
    setBusy(true);
    try {
      const { radar } = await api.radars.createSmart({
        name: name.trim(),
        filter: { tags, match },
      });
      await client.invalidateQueries({ queryKey: queryKeys.radars });
      notify('Smart radar created');
      onClose();
      void navigate({ to: '/radar/$radarId', params: { radarId: radar.id } });
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not create that radar', 'error');
      setBusy(false);
    }
  };

  const toggle = (value: string) =>
    setTags((current) =>
      current.includes(value) ? current.filter((t) => t !== value) : [...current, value],
    );

  return (
    <Modal
      title="New smart radar"
      description="A radar that holds no blips of its own — it gathers whatever carries these tags, from every radar you can read."
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-accent"
            disabled={busy || !name.trim() || tags.length === 0}
            onClick={() => void create()}
          >
            <Target className="h-4 w-4" />
            Create
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="instrument">Name</span>
          <input
            className="field"
            value={name}
            autoFocus
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) void create();
            }}
          />
        </label>

        <div className="flex flex-col gap-2">
          <span className="instrument">Tags it gathers</span>
          <div className="flex flex-wrap gap-1.5">
            {[tag, ...related].map((value) => (
              <button
                key={value}
                aria-pressed={tags.includes(value)}
                onClick={() => toggle(value)}
                className="rounded-full border px-2.5 py-1 text-[12.5px] transition-colors"
                style={{
                  borderColor: tags.includes(value) ? 'transparent' : 'var(--line)',
                  background: tags.includes(value) ? 'var(--accent-fill)' : 'var(--ink-800)',
                  color: tags.includes(value)
                    ? 'color-mix(in srgb, var(--accent-ink) 85%, black)'
                    : 'var(--paper-dim)',
                }}
              >
                #{value}
              </button>
            ))}
          </div>
        </div>

        {tags.length > 1 ? (
          <label className="flex flex-col gap-1.5">
            <span className="instrument">Match</span>
            <Select
              className="field"
              value={match}
              onValueChange={(value) => setMatch(value === 'all' ? 'all' : 'any')}
              options={[
                { value: 'any', label: 'Any of these tags' },
                { value: 'all', label: 'Every one of these tags' },
              ]}
            />
          </label>
        ) : null}

        <p className="text-[12.5px] leading-relaxed text-[color:var(--paper-dim)]">
          You cannot capture into a smart radar or publish one — it is a view of your own radars, so
          it shows each person only what they could already read.
        </p>
      </div>
    </Modal>
  );
}
