import { QueryError } from '../components/query-error';
/** Topic directory; includes empty topics so creation and management remain discoverable. */
import { useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Pencil, Users } from 'lucide-react';
import type { TopicDto } from '@onmyradar/contract';
import { accentStyle } from '../lib/theme';
import { queryKeys, useRadars, useSession, useTopics } from '../lib/session';
import { Empty, Spinner } from '../components/primitives';
import { EditTopicDialog, NewTopicDialog } from '../components/radar-dialogs';
import { useDocumentTitle } from '../lib/title';

export function TopicsRoute() {
  useDocumentTitle('Arrays');
  const { user } = useSession();
  const active = Boolean(user && user.state === 'active');
  const { data, isLoading, error, refetch } = useTopics(active);
  // Only to count what is in each topic. `TopicDto.radarCount` is the caller's
  // own readable count and is the number shown; this is just what the list
  // already has in cache, so no second request is made for it.
  const { data: radarData } = useRadars(active);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<TopicDto | null>(null);
  const navigate = useNavigate();
  const client = useQueryClient();

  const topics = (data?.topics ?? []).filter((topic) => !topic.archived);
  const radars = radarData?.radars ?? [];

  const invalidate = () => {
    void client.invalidateQueries({ queryKey: queryKeys.topics });
    void client.invalidateQueries({ queryKey: queryKeys.radars });
  };

  return (
    <div className="mx-auto flex max-w-[760px] flex-col gap-5 px-4 py-5 sm:px-6">
      <header className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-[21px] font-semibold tracking-tight">Arrays</h1>
        <button className="btn btn-accent" onClick={() => setCreating(true)}>
          <Users className="h-4 w-4" />
          New array
        </button>
      </header>

      {/*
        Said on the screen rather than left to be inferred from the shape of the
        list, and said whether or not there are any arrays — the sentence people
        need is "what is this and does it share anything", and by the time you
        have an array to look at you have already had to guess.
      */}
      <p className="text-[15px] text-[color:var(--paper-dim)]">
        Keep related radars together by project or interest. Each radar keeps its own sharing
        settings unless you turn on array sharing.
      </p>

      {isLoading ? <Spinner label="Reading your arrays" /> : null}

      {error ? <QueryError error={error} resource="Your arrays" retry={() => refetch()} /> : null}

      {!isLoading && !error && topics.length === 0 ? (
        <Empty
          title="No arrays yet"
          hint="Make one and put a few related radars in it. Nothing is shared by doing so — an array groups radars and nothing more."
          action={
            <button className="btn btn-accent" onClick={() => setCreating(true)}>
              <Users className="h-4 w-4" />
              New array
            </button>
          }
        />
      ) : null}

      {topics.length > 0 ? (
        <ul className="radar-list">
          {topics.map((topic) => {
            // What the caller can read, never what the topic holds — a topic
            // member given the grouping and no radars must not be told five
            // things exist that they cannot open. `radarCount` is already
            // computed that way server-side, so it is simply used as given.
            const held = radars.filter((radar) => radar.topicId === topic.id);
            return (
              <li key={topic.id} className="topic-row" style={accentStyle(topic.accent)}>
                <Link
                  to="/array/$topicId"
                  params={{ topicId: topic.id }}
                  className="radar-row min-w-0 flex-1"
                >
                  <span className="shrink-0 text-[color:var(--accent-from)]">
                    <Users className="h-5 w-5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-medium">{topic.name}</span>
                    <span className="instrument mt-0.5 block truncate">
                      {[
                        `${topic.radarCount} radar${topic.radarCount === 1 ? '' : 's'}`,
                        `${topic.memberCount} member${topic.memberCount === 1 ? '' : 's'}`,
                        topic.cascade ? 'shared throughout' : 'grouping only',
                        topic.tagline,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                    {/* The names, not just the number: "what is in each" is the
                        question this screen is here to answer, and a count does
                        not answer it. */}
                    {held.length > 0 ? (
                      <span className="instrument mt-0.5 block truncate text-[color:var(--paper-faint)]">
                        {held.map((radar) => radar.name).join(' · ')}
                      </span>
                    ) : null}
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-[color:var(--paper-faint)]" />
                </Link>
                {topic.access.canManage ? (
                  // Rename lives here as well as on the topic's own screen: a
                  // typo in a name is spotted while looking down the list, and
                  // making somebody open a screen to fix it is how the name
                  // stays wrong. Deleting deliberately does NOT live here — it
                  // needs the sentence about what happens to the radars, and
                  // that sentence belongs on the topic's own screen.
                  <button
                    className="btn btn-ghost shrink-0 p-2"
                    aria-label={`Rename ${topic.name}`}
                    title="Array settings"
                    onClick={() => setEditing(topic)}
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {creating ? (
        <NewTopicDialog
          onClose={() => setCreating(false)}
          onCreated={(topic) => {
            setCreating(false);
            invalidate();
            void navigate({ to: '/array/$topicId', params: { topicId: topic.id } });
          }}
        />
      ) : null}

      {editing ? (
        <EditTopicDialog
          topic={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            invalidate();
          }}
        />
      ) : null}
    </div>
  );
}
