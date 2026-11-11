import { useRef, useState } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { CLIENT_STATUS_LABELS, SUPPORT_CATEGORIES } from '@onmyradar/contract';
import { ApiError, api } from '../lib/api';
import { useSession } from '../lib/session';
import { useDocumentTitle } from '../lib/title';
import { Mark, Spinner } from '../components/primitives';
import { QueryError } from '../components/query-error';
import { Select } from '../components/select';

const labels = {
  account: 'Account and access',
  billing: 'Billing and cancellation',
  bug: 'Report a bug',
  feature: 'Suggest a feature',
  privacy: 'Privacy, export or deletion',
};
/** Billing is retired: old requests keep their label, new ones cannot pick it. */
const NEW_CATEGORIES = SUPPORT_CATEGORIES.filter((value) => value !== 'billing');
function useOperation() {
  const last = useRef<{ text: string; id: string } | null>(null);
  return {
    reset: () => {
      last.current = null;
    },
    get: (input: unknown) => {
      const text = JSON.stringify(input);
      if (last.current?.text !== text) last.current = { text, id: crypto.randomUUID() };
      return last.current.id;
    },
  };
}
function SupportError({ error, retry }: { error: Error; retry: () => unknown }) {
  return error instanceof ApiError && error.code === 'support_unavailable' ? (
    <div role="alert" className="mt-6">
      <p>{error.message}</p>
      <button className="btn mt-3" onClick={() => void retry()}>
        Try again
      </button>
    </div>
  ) : (
    <QueryError error={error} resource="Support" retry={retry} />
  );
}
export function SupportRoute() {
  useDocumentTitle('Help');
  const { user, loading, error, refresh } = useSession();
  const { request: selected } = useSearch({ from: '/support' });
  const navigate = useNavigate();
  const client = useQueryClient();
  const [category, setCategory] = useState<(typeof SUPPORT_CATEGORIES)[number]>('account');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [reply, setReply] = useState('');
  const operation = useOperation();
  const replyOperation = useOperation();
  const signedIn = !!user && user.state !== 'suspended';
  const list = useInfiniteQuery({
    queryKey: ['support', user?.id],
    enabled: signedIn,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.support.list(pageParam),
    getNextPageParam: (page) => page.next ?? undefined,
  });
  const thread = useInfiniteQuery({
    queryKey: ['support-thread', user?.id, selected],
    enabled: signedIn && !!selected,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.support.get(selected ?? '', pageParam),
    getNextPageParam: (page) => page.next ?? undefined,
    refetchInterval: selected ? 30_000 : false,
  });
  const create = useMutation({
    mutationFn: () => {
      const input = { category, title, body };
      return api.support.create({ ...input, operationId: operation.get(input) });
    },
    onSuccess: async (result) => {
      operation.reset();
      setTitle('');
      setBody('');
      await client.invalidateQueries({ queryKey: ['support', user?.id] });
      await navigate({ to: '/support', search: { request: result.request.id } });
    },
  });
  const sendReply = useMutation({
    mutationFn: () =>
      api.support.reply(selected ?? '', {
        body: reply,
        operationId: replyOperation.get({ selected, reply }),
      }),
    onSuccess: async () => {
      replyOperation.reset();
      setReply('');
      await client.invalidateQueries({ queryKey: ['support-thread', user?.id, selected] });
      await client.invalidateQueries({ queryKey: ['support', user?.id] });
    },
  });
  if (error) return <QueryError error={error} resource="Session" retry={refresh} />;
  if (loading) return <Spinner label="Checking your account" />;
  const request = thread.data?.pages[0]?.request;
  return (
    <main className="support-surface mx-auto w-full max-w-3xl px-5 py-8 sm:px-8">
      <header className="mb-8 flex items-center justify-between gap-4">
        <span className="flex items-center gap-3">
          <Mark size={28} />
          <span className="instrument">On My Radar · Help</span>
        </span>
        <Link className="text-link" to={user?.state === 'pending' ? '/waiting' : '/'}>
          Back
        </Link>
      </header>
      <h1 className="font-serif text-3xl">Contact support</h1>
      <p className="mt-3 text-[color:var(--paper-dim)]">
        Send a private request and follow the replies here. Only you and the support team can read
        it.
      </p>
      <p className="mt-3 text-sm text-[color:var(--paper-dim)]">
        Keep passwords, API keys, payment details and private blip content out of your request. For
        a bug, include the steps and a redacted example.
      </p>
      {!signedIn ? (
        <p className="mt-8 flex flex-wrap items-center gap-3">
          <Link className="btn" to="/login" search={{ next: '/support' }}>
            Sign in to contact support
          </Link>
          <Link className="text-link" to="/help">
            Contact support without signing in
          </Link>
        </p>
      ) : (
        <>
          {list.isPending ? (
            <Spinner label="Loading support" />
          ) : list.error ? (
            <SupportError error={list.error} retry={() => void list.refetch()} />
          ) : (
            <>
              <section className="mt-8" aria-label="Your support requests">
                <h2 className="instrument mb-3">Your requests</h2>
                {list.data.pages.flatMap((page) => page.requests).length ? (
                  <ul className="space-y-2">
                    {list.data.pages
                      .flatMap((page) => page.requests)
                      .map((item) => (
                        <li key={item.id}>
                          <Link className="text-link" to="/support" search={{ request: item.id }}>
                            {item.title}
                          </Link>
                          <span className="instrument ml-3">
                            {CLIENT_STATUS_LABELS[item.status]}
                          </span>
                        </li>
                      ))}
                  </ul>
                ) : (
                  <p>No requests yet.</p>
                )}
                {list.hasNextPage ? (
                  <button
                    className="btn mt-3"
                    disabled={list.isFetchingNextPage}
                    onClick={() => void list.fetchNextPage()}
                  >
                    More requests
                  </button>
                ) : null}
              </section>
              {selected ? (
                <section className="mt-8" aria-label="Support conversation">
                  <Link className="text-link" to="/support" search={{}}>
                    New request
                  </Link>
                  {thread.isPending ? (
                    <Spinner label="Loading conversation" />
                  ) : thread.error ? (
                    <QueryError
                      error={thread.error}
                      resource="Conversation"
                      retry={() => void thread.refetch()}
                    />
                  ) : request ? (
                    <>
                      <h2 className="mt-5 font-serif text-2xl break-words">{request.title}</h2>
                      <p className="instrument mt-2">
                        {labels[request.category]} · {CLIENT_STATUS_LABELS[request.status]}
                      </p>
                      <p className="mt-3 text-sm break-all">Reference: {request.id.slice(0, 8)}</p>
                      <p className="mt-4 whitespace-pre-wrap break-words">{request.body}</p>
                      <ol className="mt-6 space-y-5">
                        {thread.data.pages
                          .flatMap((page) => page.replies)
                          .map((item) => (
                            <li key={item.id} className="border-t border-[color:var(--rule)] pt-4">
                              <p className="instrument">
                                {item.from === 'you' ? 'You' : 'Support'} ·{' '}
                                {new Date(item.createdAt).toLocaleString()}
                              </p>
                              <p className="mt-2 whitespace-pre-wrap break-words">{item.body}</p>
                            </li>
                          ))}
                      </ol>
                      {thread.hasNextPage ? (
                        <button
                          className="btn mt-3"
                          disabled={thread.isFetchingNextPage}
                          onClick={() => void thread.fetchNextPage()}
                        >
                          More replies
                        </button>
                      ) : null}
                      <form
                        className="mt-6 space-y-3"
                        onSubmit={(event) => {
                          event.preventDefault();
                          sendReply.mutate();
                        }}
                      >
                        <label className="block" htmlFor="support-reply">
                          Reply
                        </label>
                        <textarea
                          id="support-reply"
                          className="field"
                          rows={4}
                          value={reply}
                          maxLength={8000}
                          required
                          disabled={sendReply.isPending}
                          onChange={(event) => setReply(event.target.value)}
                        />
                        {sendReply.error ? <p role="alert">{sendReply.error.message}</p> : null}
                        <button className="btn" disabled={sendReply.isPending || !reply.trim()}>
                          {sendReply.isPending ? 'Sending…' : 'Send reply'}
                        </button>
                      </form>
                    </>
                  ) : null}
                </section>
              ) : (
                <form
                  className="mt-8 space-y-4"
                  onSubmit={(event) => {
                    event.preventDefault();
                    create.mutate();
                  }}
                >
                  <h2 className="font-serif text-xl">New request</h2>
                  <div>
                    <label className="mb-2 block" htmlFor="support-category">
                      What can we help with?
                    </label>
                    <Select
                      id="support-category"
                      className="w-full"
                      value={category}
                      disabled={create.isPending}
                      onValueChange={(value) => setCategory(value as typeof category)}
                      options={NEW_CATEGORIES.map((value) => ({ value, label: labels[value] }))}
                    />
                  </div>
                  <div>
                    <label className="mb-2 block" htmlFor="support-title">
                      Subject
                    </label>
                    <input
                      id="support-title"
                      className="field"
                      value={title}
                      required
                      maxLength={160}
                      disabled={create.isPending}
                      onChange={(event) => setTitle(event.target.value)}
                    />
                  </div>
                  <div>
                    <label className="mb-2 block" htmlFor="support-body">
                      Details
                    </label>
                    <textarea
                      id="support-body"
                      className="field"
                      value={body}
                      rows={6}
                      required
                      maxLength={8000}
                      disabled={create.isPending}
                      onChange={(event) => setBody(event.target.value)}
                    />
                  </div>
                  {create.error ? <p role="alert">{create.error.message}</p> : null}
                  <button
                    className="btn"
                    disabled={create.isPending || !title.trim() || !body.trim()}
                  >
                    {create.isPending ? 'Sending…' : 'Send request'}
                  </button>
                </form>
              )}
            </>
          )}
        </>
      )}
    </main>
  );
}
