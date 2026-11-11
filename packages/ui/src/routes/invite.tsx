/**
 * `/invite/$token` — an invitation link from an email.
 *
 * This route resolves the token and then hands straight off to the login screen,
 * which renders the invitation above its own form. It is deliberately thin: the
 * invitation is context for signing in, not a step before it, and the token
 * admits nobody on its own (see `services/invites.ts`).
 *
 * A link that no longer resolves — revoked, expired, already accepted, or for a
 * radar that has since been deleted — is not an error page. The server answers
 * all of those identically on purpose, and the useful thing to do with somebody
 * standing in front of a dead link is to say so in one line and leave them on a
 * working sign-in form rather than at a dead end.
 */
import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { Loader2 } from 'lucide-react';
import { ApiError, api } from '../lib/api';
import { QueryError } from '../components/query-error';
import { LoginRoute } from './login';

export function InviteRoute() {
  const { token } = useParams({ from: '/invite/$token' });

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ['invite', token],
    queryFn: () => api.invites.resolve(token),
    enabled: token !== '',
    // One shot. A dead invitation is a settled answer, not a flaky request, and
    // retrying it only delays the sign-in form the person still needs.
    retry: false,
  });

  if (token && isPending) {
    return (
      <div className="flex min-h-full items-center justify-center px-5 py-12">
        <Loader2 className="h-5 w-5 animate-spin text-[color:var(--paper-faint)]" />
        <span className="sr-only">Opening your invitation</span>
      </div>
    );
  }

  if (error && !(error instanceof ApiError && error.status === 404))
    return <QueryError error={error} resource="Invitation" retry={() => refetch()} />;

  return (
    <LoginRoute
      invite={data?.invite ?? null}
      inviteError={
        !token || isError
          ? 'That invitation link is no longer open — it may have been withdrawn, or it may simply have expired. Signing in with the address it was sent to still works.'
          : null
      }
    />
  );
}
