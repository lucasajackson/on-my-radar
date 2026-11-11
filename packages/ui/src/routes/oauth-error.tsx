/** Shown when an MCP client's authorization request cannot be trusted enough to bounce back. */
import { Link, useSearch } from '@tanstack/react-router';
import { Empty } from '../components/primitives';
import { useDocumentTitle } from '../lib/title';

export function OauthErrorRoute() {
  useDocumentTitle('Connection refused');
  const search = useSearch({ from: '/connect/error' });
  return (
    <div className="mx-auto max-w-[600px] px-5 py-16">
      <Empty
        title="That connection request was refused"
        hint={
          search.message ??
          'The request was missing something it needed, so nothing was sent back to the client.'
        }
        action={
          <Link to="/" className="btn">
            Go to On My Radar
          </Link>
        }
      />
    </div>
  );
}
