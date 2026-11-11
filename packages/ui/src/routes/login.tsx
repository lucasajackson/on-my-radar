/**
 * Sign in, and the same screen wearing an invitation.
 *
 * One field to start: an email address. There is no separate "sign up" — the
 * same form creates the account, and the waitlist is explained after you have
 * proved the address is yours rather than before, so nobody types a code for
 * nothing.
 *
 * An invitation does not get a screen of its own. Somebody who clicked a link in
 * an email has already decided; putting an "accept" button in front of the form
 * would be one more click before anything happens, on the one flow where the
 * person has the least patience and the least idea what this application is.
 * `/invite/$token` therefore renders *this* screen with the invitation stated
 * above it and the address already filled in — the invitation is context for the
 * sign-in, not a step before it.
 *
 * The token is not what admits anybody. It fills in a form and names a radar;
 * the only way past this screen is still a code delivered to the invited
 * address. See `services/invites.ts`.
 */
import { useEffect, useState } from 'react';
import { Link, useSearch } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, KeyRound, Loader2, Mail } from 'lucide-react';
import { PASSWORD, safeNextPath, type InvitePreviewDto } from '@onmyradar/contract';
import { ApiError, api } from '../lib/api';
import { queryKeys, useSession } from '../lib/session';
import { Mark, notify } from '../components/primitives';
import { AboutLink } from '../components/about-link';
import { useDocumentTitle } from '../lib/title';
import './auth-screen.css';
import { useDarkScreen } from '../lib/theme';

/**
 * The invitation, stated as an instrument readout above the form.
 *
 * It says three things and stops: who is handing over what, at which role, and
 * what happens to your account when you accept. That last line is the one that
 * earns its place — signup is waitlisted, and finding that out *after* typing a
 * code, having been sent a personal invitation, is the kind of surprise that
 * reads as the product being broken.
 */
function InvitationCard({ invite }: { invite: InvitePreviewDto }) {
  return (
    <div className="panel mt-6 p-4">
      <div className="instrument">
        {invite.invitedBy} invited you · {invite.kind}
      </div>
      <p className="mt-2 text-[19px] leading-snug" style={{ fontFamily: 'var(--font-serif)' }}>
        {invite.name}
      </p>
      <p className="mt-2 text-[13px] text-[color:var(--paper-dim)]">
        {invite.role === 'editor'
          ? 'You will be able to read it and capture into it.'
          : 'You will be able to read it.'}{' '}
        {invite.hasAccount
          ? 'Sign in and it will be there.'
          : invite.skipsWaitlist
            ? 'Signing in with this address creates your account and takes you straight in.'
            : 'Signing in with this address creates your account. New accounts join a waitlist, and this will be waiting for you the moment you are approved.'}
      </p>
    </div>
  );
}

/**
 * Leaves the login screen with a real browser navigation.
 *
 * `next` is not always an SPA route: the MCP connect flow bounces through
 * `/login?next=/oauth/authorize?...`, and `/oauth/authorize` is served by the
 * API, not the router. A client-side navigate cannot match it, so the router
 * fell through to the dashboard and the OAuth handshake was silently dropped —
 * which looked to the user like signing in and simply landing on the app, with
 * no consent screen and nothing returned to the client.
 */
function leaveLogin(destination: string): void {
  window.location.assign(destination);
}

export function LoginRoute({
  invite = null,
  inviteError = null,
}: {
  /** Set when this screen was reached through `/invite/$token`. */
  invite?: InvitePreviewDto | null;
  /** A link that no longer resolves. Said plainly, then got out of the way. */
  inviteError?: string | null;
} = {}) {
  /*
    Loose, not `from: '/login'`: this screen is also rendered inside
    `/invite/$token`, where a strict read of another route's search throws. So
    each field is narrowed here instead of being cast to the shape it hopes for.
  */
  const loose = useSearch({ strict: false });
  const search = {
    next: typeof loose['next'] === 'string' ? loose['next'] : undefined,
    error: typeof loose['error'] === 'string' ? loose['error'] : undefined,
  };
  const { user, refresh } = useSession();
  useDarkScreen();
  useDocumentTitle(invite ? `Invitation to ${invite.name}` : 'Sign in');
  const [stage, setStage] = useState<'email' | 'code'>('email');
  // Pre-filled from the invitation, but not locked: an invitation is addressed
  // to a mailbox, and a person who reads that mailbox under a different address
  // must still be able to sign in — they simply get their own account, and the
  // invitation stays where it was addressed.
  const [email, setEmail] = useState(invite?.email ?? '');
  const [code, setCode] = useState('');
  // Password sign-in, where the instance has it on: the default, with the emailed code as the other way in.
  const [method, setMethod] = useState<'password' | 'code'>('password');
  const [password, setPassword] = useState('');
  const [resetting, setResetting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(search.error ?? null);
  const [devCode, setDevCode] = useState<string | null>(null);
  /*
    The code was requested in another browser. The server binds a code to the
    browser that asked for it (a signed challenge cookie), so it is refused
    here before it is even compared — and the way on is one click: a new code
    for the same address, requested from this browser.
  */
  const [elsewhere, setElsewhere] = useState(false);

  const { data: config } = useQuery({
    queryKey: queryKeys.authConfig,
    queryFn: () => api.auth.config(),
  });

  /**
   * Where to land afterwards. The invitation's own target wins over `?next`,
   * because arriving at the radar somebody just handed you is the entire point
   * of having followed the link.
   */
  const destination = safeNextPath(invite?.next) ?? safeNextPath(search.next) ?? '/';

  useEffect(() => {
    if (!user) return;
    leaveLogin(user.state === 'active' ? destination : '/waiting');
  }, [destination, user]);

  const requestCode = async () => {
    setBusy(true);
    setError(null);
    setElsewhere(false);
    setCode('');
    try {
      const result = await api.auth.requestCode(email.trim());
      setDevCode(result.devCode ?? null);
      setStage('code');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send a code');
    } finally {
      setBusy(false);
    }
  };

  const finish = async (result: { user: { state: string }; next: string }) => {
    await refresh();
    notify('Signed in');
    leaveLogin(result.user.state === 'active' ? result.next : '/waiting');
  };

  const verify = async () => {
    setBusy(true);
    setError(null);
    try {
      await finish(
        resetting
          ? await api.auth.resetPassword(email.trim(), code.trim(), password, destination)
          : await api.auth.verifyCode(email.trim(), code.trim(), destination),
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not verify that code');
      setElsewhere(err instanceof ApiError && err.code === 'login_challenge_missing');
      setBusy(false);
    }
  };

  const passwordSignIn = async () => {
    setBusy(true);
    setError(null);
    try {
      await finish(await api.auth.passwordLogin(email.trim(), password, destination));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not sign in');
      setBusy(false);
    }
  };

  const passwordOn = config?.password?.enabled === true;

  return (
    <div className="auth-screen flex min-h-full items-center justify-center px-5 py-12">
      <div className="w-full max-w-[380px]">
        <div className="flex flex-col items-center text-center">
          <span className="text-[color:var(--accent-from)]">
            <Mark size={56} />
          </span>
          <h1 className="auth-title mt-5 text-[28px] leading-tight">On My Radar</h1>
          <p className="mt-1.5 text-[14px] text-[color:var(--paper-dim)]">
            Drop your thoughts somewhere. Sort them out later.
          </p>
        </div>

        {invite ? <InvitationCard invite={invite} /> : null}
        {inviteError ? (
          <p className="panel mt-6 p-4 text-[13px] text-[color:var(--paper-dim)]" role="status">
            {inviteError}
          </p>
        ) : null}

        <div className={`panel p-5 ${invite || inviteError ? 'mt-4' : 'mt-8'}`}>
          {passwordOn && method === 'password' && stage === 'email' ? (
            <form
              className="flex flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                void passwordSignIn();
              }}
            >
              <label className="flex flex-col gap-1.5">
                <span className="instrument">Email address</span>
                <input
                  className="field"
                  type="email"
                  required
                  autoFocus
                  autoComplete="email"
                  value={email}
                  placeholder="you@example.com"
                  onChange={(event) => setEmail(event.target.value)}
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="instrument">Password</span>
                <input
                  className="field"
                  type="password"
                  required
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
              <button
                className="btn btn-accent justify-center"
                disabled={busy || !email.trim() || !password}
              >
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <ArrowRight className="h-4 w-4" />
                )}
                Sign in
              </button>
              <button
                type="button"
                className="btn btn-ghost justify-center"
                onClick={() => {
                  setMethod('code');
                  setError(null);
                }}
              >
                Email me a code instead
              </button>
              <button
                type="button"
                className="btn btn-ghost justify-center"
                disabled={busy || !email.trim()}
                onClick={() => {
                  setResetting(true);
                  setPassword('');
                  void requestCode();
                }}
              >
                Forgot password
              </button>
            </form>
          ) : stage === 'email' ? (
            <form
              className="flex flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                void requestCode();
              }}
            >
              <label className="flex flex-col gap-1.5">
                <span className="instrument">Email address</span>
                <input
                  className="field"
                  type="email"
                  required
                  autoFocus
                  autoComplete="email"
                  value={email}
                  placeholder="you@example.com"
                  onChange={(event) => setEmail(event.target.value)}
                />
              </label>
              <button className="btn btn-accent justify-center" disabled={busy || !email.trim()}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
                Send me a code
              </button>
              <p className="text-center text-[12.5px] text-[color:var(--paper-faint)]">
                {/* What really happens to a new address: it becomes an account
                    that waits for approval. "This creates your account" said
                    the first half and left the waitlist as a surprise. */}
                {invite && !invite.hasAccount
                  ? 'We will email you a six-digit code to prove the address is yours.'
                  : 'New here? The same code asks for an account. New accounts join a waitlist until they are approved.'}
              </p>
              {passwordOn ? (
                <button
                  type="button"
                  className="btn btn-ghost justify-center"
                  onClick={() => setMethod('password')}
                >
                  Use a password instead
                </button>
              ) : null}
            </form>
          ) : (
            <form
              className="flex flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                void verify();
              }}
            >
              <label className="flex flex-col gap-1.5">
                <span className="instrument">Six-digit code sent to {email}</span>
                <span className="text-[12.5px] text-[color:var(--paper-faint)]">
                  Enter it here, in this browser — a code only works where it was requested.
                </span>
                <input
                  className="field text-center font-mono text-[22px] tracking-[0.4em]"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  autoFocus
                  value={code}
                  placeholder="000000"
                  onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
                />
              </label>
              {resetting ? (
                <label className="flex flex-col gap-1.5">
                  <span className="instrument">New password</span>
                  <input
                    className="field"
                    type="password"
                    autoComplete="new-password"
                    minLength={PASSWORD.minLength}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                </label>
              ) : null}
              {devCode ? (
                <p className="rounded-lg border border-dashed border-[color:var(--line)] px-3 py-2 text-center text-[12.5px] text-[color:var(--paper-dim)]">
                  No mail provider configured — your code is{' '}
                  <span className="font-mono text-[color:var(--paper)]">{devCode}</span>
                </p>
              ) : null}
              <button
                className="btn btn-accent justify-center"
                disabled={
                  busy || code.length !== 6 || (resetting && password.length < PASSWORD.minLength)
                }
              >
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <ArrowRight className="h-4 w-4" />
                )}
                {resetting ? 'Set password and sign in' : 'Sign in'}
              </button>
              <button
                type="button"
                className="btn btn-ghost justify-center"
                onClick={() => {
                  setStage('email');
                  setCode('');
                  setResetting(false);
                  setError(null);
                }}
              >
                Use a different address
              </button>
            </form>
          )}

          {error ? (
            <p
              className="mt-3 rounded-lg px-3 py-2 text-[13px]"
              style={{ background: 'rgb(255 107 107 / 0.12)', color: 'var(--danger)' }}
              role="alert"
            >
              {error}
            </p>
          ) : null}
          {elsewhere ? (
            <button
              type="button"
              className="btn btn-accent mt-3 w-full justify-center"
              disabled={busy}
              onClick={() => void requestCode()}
            >
              <Mail className="h-4 w-4" />
              Send a new code to {email}
            </button>
          ) : null}

          {config?.oidc.enabled ? (
            <>
              <div className="my-4 flex items-center gap-3">
                <span className="h-px flex-1 bg-[color:var(--line-soft)]" />
                <span className="instrument">or</span>
                <span className="h-px flex-1 bg-[color:var(--line-soft)]" />
              </div>
              <a
                className="btn w-full justify-center"
                href={`/api/auth/oidc/start${
                  destination === '/' ? '' : `?next=${encodeURIComponent(destination)}`
                }`}
              >
                <KeyRound className="h-4 w-4" />
                Continue with {config.oidc.name}
              </a>
            </>
          ) : null}
        </div>
        <p className="mt-5 text-center">
          <Link className="text-link" to="/help">
            Cannot sign in? Contact support
          </Link>
        </p>
        <AboutLink />
      </div>
    </div>
  );
}
