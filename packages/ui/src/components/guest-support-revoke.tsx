import { useState } from 'react';
import { api } from '../lib/api';
export function GuestSupportRevoke({ requestId }: { requestId: string }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [revoked, setRevoked] = useState(false);
  const [error, setError] = useState('');
  return (
    <div className="mt-3 text-sm">
      {revoked ? (
        <p role="status">
          Guest link and recovery code revoked. The private support record remains.
        </p>
      ) : confirm ? (
        <>
          <p>
            The guest will lose access to this conversation, including recovery. This does not
            delete the request or change an account.
          </p>
          <button
            className="btn mt-2"
            disabled={busy}
            onClick={() => {
              void (async () => {
                setBusy(true);
                setError('');
                try {
                  await api.guestSupportStaff.revoke(requestId);
                  setRevoked(true);
                } catch {
                  setError('Could not confirm revocation. Try again.');
                } finally {
                  setBusy(false);
                }
              })();
            }}
          >
            Confirm revocation
          </button>
          <button
            className="btn btn-ghost ml-2 mt-2"
            disabled={busy}
            onClick={() => setConfirm(false)}
          >
            Keep link active
          </button>
        </>
      ) : (
        <button className="text-link instrument" onClick={() => setConfirm(true)}>
          Revoke guest conversation link
        </button>
      )}
      {error ? (
        <p role="alert" className="mt-2 text-[color:var(--danger)]">
          {error}
        </p>
      ) : null}
    </div>
  );
}
