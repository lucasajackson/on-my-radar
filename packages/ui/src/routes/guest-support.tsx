import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import {
  CLIENT_STATUS_LABELS,
  SUPPORT_CATEGORIES,
  type GuestSupportCredentialsDto,
  type GuestSupportThreadDto,
} from '@onmyradar/contract';
import { guestSupportApi } from '../lib/guest-support';
import { useDocumentTitle } from '../lib/title';
import { Mark } from '../components/primitives';
import { Select } from '../components/select';

const STORAGE = 'omr-guest-support';
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const labels = {
  account: 'Account and access',
  billing: 'Billing and cancellation',
  bug: 'Report a bug',
  feature: 'Suggest a feature',
  privacy: 'Privacy, export or deletion',
};
/** Billing is retired: old requests keep their label, new ones cannot pick it. */
const NEW_CATEGORIES = SUPPORT_CATEGORIES.filter((value) => value !== 'billing');
function initial(): Partial<GuestSupportCredentialsDto> {
  // Fragment never travels in an HTTP request, referrer or server access log.
  const fragment = window.location.hash.slice(1);

  if (TOKEN.test(fragment)) return { token: fragment };
  try {
    const stored: unknown = JSON.parse(sessionStorage.getItem(STORAGE) ?? 'null');
    if (
      stored &&
      typeof stored === 'object' &&
      'token' in stored &&
      typeof stored.token === 'string' &&
      TOKEN.test(stored.token)
    )
      return {
        token: stored.token,
        ...('recoveryCode' in stored &&
        typeof stored.recoveryCode === 'string' &&
        TOKEN.test(stored.recoveryCode)
          ? { recoveryCode: stored.recoveryCode }
          : {}),
        ...('expiresAt' in stored && typeof stored.expiresAt === 'string'
          ? { expiresAt: stored.expiresAt }
          : {}),
      };
  } catch {
    /* Storage can be unavailable; the saved private link still works. */
  }
  return {};
}
export function GuestSupportRoute() {
  useDocumentTitle('Help without signing in');
  const [credentials, setCredentials] = useState(initial);
  const [data, setData] = useState<GuestSupportThreadDto | null>(null);
  const [category, setCategory] = useState<(typeof SUPPORT_CATEGORIES)[number]>('account');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [email, setEmail] = useState('');
  const [reply, setReply] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const operation = useRef<{ text: string; id: string } | null>(null);
  function operationId(input: unknown) {
    const text = JSON.stringify(input);
    if (operation.current?.text !== text) operation.current = { text, id: crypto.randomUUID() };
    return operation.current.id;
  }
  // A generation identifies the mounted conversation, not just its token. A
  // second visit to the same token must not revive work from its earlier visit.
  const context = useRef({ mounted: false, generation: 0, serial: 0 });
  const initialCredentials = useRef(credentials);
  const switchConversation = useCallback(
    (value: Partial<GuestSupportCredentialsDto>, preserveDraft = false, preserveBusy = false) => {
      context.current.generation++;
      context.current.serial++;
      setCredentials(value);
      setData(null);
      setError('');
      setMessage('');
      setReply('');
      setRecoveryCode('');
      if (!preserveBusy) setBusy(false);
      if (!preserveDraft) {
        operation.current = null;
        setTitle('');
        setBody('');
        setEmail('');
      }
      if (window.location.hash) window.history.replaceState(null, '', window.location.pathname);
      try {
        if (value.token) sessionStorage.setItem(STORAGE, JSON.stringify(value));
        else sessionStorage.removeItem(STORAGE);
      } catch {
        /* User has the private link on screen. */
      }
    },
    [],
  );
  async function run(
    action: (scope: {
      current: () => boolean;
      adopt: (value: Partial<GuestSupportCredentialsDto>, preserveDraft?: boolean) => void;
    }) => Promise<void>,
  ) {
    if (!context.current.mounted) return;
    let generation = context.current.generation;
    let serial = ++context.current.serial;
    const current = () =>
      context.current.mounted &&
      context.current.generation === generation &&
      context.current.serial === serial;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await action({
        current,
        adopt(value, preserveDraft = false) {
          if (!current()) return;
          switchConversation(value, preserveDraft, true);
          generation = context.current.generation;
          serial = context.current.serial;
        },
      });
    } catch (e) {
      if (current())
        setError(
          e instanceof Error
            ? e.message
            : 'Support could not confirm this operation. Keep your text and try again.',
        );
    } finally {
      if (current()) setBusy(false);
    }
  }
  const token = credentials.token;
  useEffect(() => {
    const lifecycle = context.current;
    lifecycle.mounted = true;
    function open(value: Partial<GuestSupportCredentialsDto>) {
      switchConversation(value);
      if (!value.token) return;
      const { generation, serial } = context.current;
      const current = () =>
        context.current.mounted &&
        context.current.generation === generation &&
        context.current.serial === serial;
      void guestSupportApi
        .get(value.token)
        .then((result) => {
          if (current()) setData(result);
        })
        .catch((e: unknown) => {
          if (current()) setError(e instanceof Error ? e.message : 'Could not load support.');
        });
    }
    function consumeChangedLink() {
      const next = window.location.hash.slice(1);
      if (TOKEN.test(next)) open({ token: next });
    }
    open(initialCredentials.current);
    window.addEventListener('hashchange', consumeChangedLink);
    return () => {
      lifecycle.mounted = false;
      lifecycle.generation++;
      lifecycle.serial++;
      window.removeEventListener('hashchange', consumeChangedLink);
    };
  }, [switchConversation]);
  const thread = data?.thread;
  const link = token ? `${window.location.origin}/help#${token}` : '';
  return (
    <main className="support-surface mx-auto w-full max-w-3xl px-5 py-8 sm:px-8">
      <header className="mb-8 flex items-center justify-between gap-4">
        <span className="flex items-center gap-3">
          <Mark size={28} />
          <span className="instrument">On My Radar · Help</span>
        </span>
        <Link className="text-link" to="/login">
          Sign in
        </Link>
      </header>
      <h1 className="font-serif text-3xl">Help without signing in</h1>
      <p className="mt-3">
        Send a private support request even if you cannot access your account or email. Return here
        to check replies; we do not send email from this form.
      </p>
      <p className="mt-3 text-sm text-[color:var(--paper-dim)]">
        Keep passwords, sign-in codes, API keys, card numbers and private blip content out. An email
        address or conversation link does not prove account ownership. Account changes, cancellation
        and data requests require separate identity verification by support. No response deadline is
        promised.
      </p>
      {error ? (
        <p role="alert" className="mt-5 text-[color:var(--danger)]">
          {error}
        </p>
      ) : null}
      {message ? (
        <p role="status" className="mt-5">
          {message}
        </p>
      ) : null}
      {token ? (
        <section className="panel mt-6 p-4" aria-label="Private support receipt">
          <h2 className="instrument">
            {data || credentials.recoveryCode
              ? 'Save your private conversation link'
              : 'Saved conversation link'}
          </h2>
          <p className="mt-2 text-sm">
            Anyone with this link can read and reply to this one request. Keep it private. This
            browser remembers it only for this session; save the link before closing it.
          </p>
          <label className="mt-3 block">
            <span className="instrument">Private link</span>
            <input
              className="field mt-1 w-full"
              readOnly
              value={link}
              onFocus={(e) => e.currentTarget.select()}
            />
          </label>
          {credentials.recoveryCode ? (
            <label className="mt-3 block">
              <span className="instrument">Recovery code — save separately</span>
              <input
                className="field mt-1 w-full"
                readOnly
                value={credentials.recoveryCode}
                onFocus={(e) => e.currentTarget.select()}
              />
            </label>
          ) : null}
          <p className="mt-3 text-sm">
            Expires{' '}
            {data?.expiresAt || credentials.expiresAt
              ? new Date(data?.expiresAt ?? credentials.expiresAt ?? '').toLocaleString()
              : '30 days after it was created'}
            . A saved recovery code replaces a lost link and invalidates the previous link. Neither
            works after expiry or revocation.
          </p>
          <div className="support-receipt-actions mt-3">
            <button
              className="btn"
              disabled={busy}
              onClick={() =>
                void run(async (scope) => {
                  const result = await guestSupportApi.get(token);
                  if (scope.current()) setData(result);
                })
              }
            >
              Refresh conversation
            </button>
            <button
              className="btn btn-ghost"
              disabled={busy}
              onClick={() =>
                void run(async (scope) => {
                  await guestSupportApi.revoke(token);
                  if (!scope.current()) return;
                  scope.adopt({});
                  setMessage(
                    'The conversation link and recovery code were revoked. This does not delete the support record or change an account.',
                  );
                })
              }
            >
              Revoke this link
            </button>
          </div>
        </section>
      ) : null}
      {thread ? (
        <section className="mt-8" aria-label="Support conversation">
          <h2 className="font-serif text-xl">{thread.request.title}</h2>
          <p className="instrument mt-2">
            Reference {thread.request.id.slice(0, 8)} ·{' '}
            {CLIENT_STATUS_LABELS[thread.request.status]}
          </p>
          <p className="mt-4 whitespace-pre-wrap break-words">{thread.request.body}</p>
          <ol className="mt-5 space-y-4">
            {thread.replies.map((item) => (
              <li key={item.id} className="panel p-4">
                <p className="instrument">
                  {item.from === 'you' ? 'You' : 'Support'} ·{' '}
                  {new Date(item.createdAt).toLocaleString()}
                </p>
                <p className="mt-2 whitespace-pre-wrap break-words">{item.body}</p>
              </li>
            ))}
          </ol>
          {thread.next ? (
            <button
              className="btn mt-4"
              disabled={busy}
              onClick={() =>
                void run(async (scope) => {
                  if (!token) return;
                  const next = await guestSupportApi.get(token, thread.next ?? undefined);
                  if (scope.current() && next.thread)
                    setData({
                      ...next,
                      thread: {
                        ...next.thread,
                        replies: [...thread.replies, ...next.thread.replies],
                      },
                    });
                })
              }
            >
              Load more replies
            </button>
          ) : null}
          <form
            className="mt-6 flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async (scope) => {
                if (!token) return;
                const input = { body: reply };
                const result = await guestSupportApi.reply(token, {
                  ...input,
                  operationId: operationId(input),
                });
                if (!scope.current()) return;
                setData(result);
                operation.current = null;
                setReply('');
              });
            }}
          >
            <label>
              <span className="instrument">Your reply</span>
              <textarea
                className="field mt-2 min-h-32 w-full"
                required
                maxLength={8000}
                value={reply}
                onChange={(e) => setReply(e.target.value)}
              />
            </label>
            <button className="btn btn-accent self-start" disabled={busy || !reply.trim()}>
              Send reply
            </button>
          </form>
        </section>
      ) : !token || data !== null ? (
        <form
          className="mt-8 flex flex-col gap-4"
          aria-label="New signed-out support request"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async (scope) => {
              const input = {
                category,
                title,
                body,
                ...(email.trim() ? { email: email.trim() } : {}),
              };
              const id = operationId(input);
              let current = credentials;
              if (!current.token) {
                const started = await guestSupportApi.start();
                if (!scope.current()) return;
                current = started;
                scope.adopt(started, true);
                setData({ thread: null, expiresAt: started.expiresAt });
              }
              if (!current.token)
                throw new Error('Support could not create a private conversation.');
              const result = await guestSupportApi.create(current.token, {
                ...input,
                operationId: id,
              });
              if (!scope.current()) return;
              setData(result);
              operation.current = null;
              setTitle('');
              setBody('');
              setEmail('');
              setMessage(
                'Your request reached the private support queue. Save the link and check here for replies.',
              );
            });
          }}
        >
          <label>
            <span className="instrument">Topic</span>
            <Select
              className="mt-2 w-full"
              aria-label="Topic"
              value={category}
              onValueChange={(value) => setCategory(value as typeof category)}
              options={NEW_CATEGORIES.map((item) => ({ value: item, label: labels[item] }))}
            />
          </label>
          <label>
            <span className="instrument">Short summary</span>
            <input
              className="field mt-2 w-full"
              required
              maxLength={160}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label>
            <span className="instrument">What happened?</span>
            <textarea
              className="field mt-2 min-h-40 w-full"
              required
              maxLength={8000}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </label>
          <label>
            <span className="instrument">Email involved (optional, unverified)</span>
            <input
              className="field mt-2 w-full"
              type="email"
              maxLength={254}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <button
            className="btn btn-accent self-start"
            disabled={busy || !title.trim() || !body.trim()}
          >
            Send support request
          </button>
        </form>
      ) : !error ? (
        <p className="mt-6" role="status">
          Loading the saved conversation. If it does not load, refresh or use the recovery options
          below.
        </p>
      ) : null}
      <section
        className="mt-10 border-t border-[color:var(--line)] pt-5"
        aria-label="Recover a support conversation"
      >
        <h2 className="font-serif text-xl">Lost your conversation link?</h2>
        <p className="mt-3 text-sm">
          Use a saved recovery code. If both are lost or expired, start another request and include
          your old reference if you have it. Support can correlate it privately, but must verify
          identity separately before sharing an earlier conversation or making account changes.
        </p>
        <form
          className="mt-4 flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            const savedCode = recoveryCode.trim();
            // Forget the previous conversation before recovery starts, even if
            // recovery fails. A delayed old read/reply cannot repopulate it.
            switchConversation({});
            setRecoveryCode(savedCode);
            void run(async (scope) => {
              const result = await guestSupportApi.recover(savedCode);
              if (!scope.current()) return;
              scope.adopt({ ...result, recoveryCode: savedCode });
              const recovered = await guestSupportApi.get(result.token);
              if (!scope.current()) return;
              setData(recovered);
              setMessage(
                'Recovered. Save the new private link; the previous link no longer works.',
              );
            });
          }}
        >
          <label>
            <span className="instrument">Saved recovery code</span>
            <input
              className="field mt-2 w-full"
              required
              autoComplete="off"
              value={recoveryCode}
              onChange={(e) => setRecoveryCode(e.target.value)}
            />
          </label>
          <button className="btn self-start" disabled={busy || !TOKEN.test(recoveryCode.trim())}>
            Recover conversation
          </button>
        </form>
        {token ? (
          <button
            className="btn btn-ghost mt-4"
            disabled={busy}
            onClick={() => {
              switchConversation({});
            }}
          >
            Start another request
          </button>
        ) : null}
      </section>
    </main>
  );
}
