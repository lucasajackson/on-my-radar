import { Link } from '@tanstack/react-router';
import { ApiError } from '../lib/api';
import { Empty } from './primitives';

/**
 * Keep a failed read distinct from an authorized empty result or a missing
 * resource — and a refusal distinct from a failure.
 *
 * A 4xx is the server answering, with a reason, and asking again gets the same
 * answer: "check your connection and try again" on an unknown OAuth client was
 * advice that could not work. So a refusal shows the server's own message and
 * no retry; only a failure to get an answer at all (network, 5xx) offers one.
 */
export function QueryError({
  error,
  resource,
  retry,
}: {
  error: unknown;
  resource: string;
  retry: () => unknown;
}) {
  const status = error instanceof ApiError ? error.status : 0;
  const missing = status === 404;
  const refused = status >= 400 && status < 500 && !missing;
  return (
    <div role="alert">
      <Empty
        title={missing ? `${resource} not found` : `Could not load ${resource.toLowerCase()}`}
        hint={
          missing
            ? 'It may have been removed, or you may no longer have access.'
            : refused && error instanceof ApiError
              ? error.message
              : 'Your data has not been changed. Check your connection and try again.'
        }
        action={
          missing || refused ? (
            <Link className="btn" to="/">
              Go home
            </Link>
          ) : (
            <button className="btn" onClick={() => void retry()}>
              Try again
            </button>
          )
        }
      />
    </div>
  );
}
