/** The waiting room for accounts that have not been approved yet. */
import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useSession, useSignOut } from '../lib/session';
import { Mark, Spinner } from '../components/primitives';
import { QueryError } from '../components/query-error';
import { AboutLink } from '../components/about-link';
import { useDocumentTitle } from '../lib/title';
import './auth-screen.css';
import { useDarkScreen } from '../lib/theme';

export function WaitingRoute() {
  useDarkScreen();
  useDocumentTitle('On the list');
  const { user, refresh, loading, error } = useSession();
  const navigate = useNavigate();
  const signOut = useSignOut();

  useEffect(() => {
    if (loading || error) return;
    if (!user) void navigate({ to: '/login' });
    else if (user.state === 'active') void navigate({ to: '/' });
  }, [error, loading, navigate, user]);

  // An approval that lands while this tab is open should let them straight in.
  useEffect(() => {
    const timer = setInterval(() => void refresh(), 20_000);
    return () => clearInterval(timer);
  }, [refresh]);

  if (error) return <QueryError error={error} resource="Session" retry={refresh} />;
  if (loading) return <Spinner label="Checking your account" />;

  return (
    <div className="auth-screen flex min-h-full items-center justify-center px-5 py-12">
      <div className="w-full max-w-[420px] text-center">
        <span className="inline-block text-[color:var(--accent-from)]">
          <Mark size={56} />
        </span>
        <h1 className="auth-title mt-5 text-[26px] leading-tight">You are on the list</h1>
        <p className="mt-2 text-[14px] leading-relaxed text-[color:var(--paper-dim)]">
          On My Radar is invite-only while it settles down. Your account is waiting to be approved —
          you will get an email the moment it is, and this page will let you in on its own.
        </p>
        <p className="instrument mt-5">{user?.email}</p>
        <p className="mt-5">
          <Link to="/support" className="text-link">
            Contact support
          </Link>
        </p>
        <button className="btn mt-6" onClick={() => void signOut()}>
          Sign out
        </button>
        <AboutLink href="/features" />
      </div>
    </div>
  );
}
