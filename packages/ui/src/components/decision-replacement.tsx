import { useId, useState } from 'react';
import { LIMITS, type BlipDto } from '@onmyradar/contract';
import { ApiError, api } from '../lib/api';
import { Modal } from './primitives';

export function DecisionReplacement({
  blip,
  onClose,
  onCreated,
}: {
  blip: Pick<BlipDto, 'id' | 'radarId' | 'title'>;
  onClose: () => void;
  onCreated: () => void;
}) {
  const id = useId();
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (saving || !body.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await api.radars.createBlip(blip.radarId, { body: body.trim(), supersedes: blip.id });
      onCreated();
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Could not save the replacement. Please try again.',
      );
      setSaving(false);
    }
  };
  return (
    <Modal
      title="Replace decision"
      description="Create the next decision and keep a link to the original."
      onClose={() => {
        if (!saving) onClose();
      }}
      footer={
        <>
          <button type="button" className="btn btn-ghost" disabled={saving} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-accent"
            disabled={saving || !body.trim()}
            onClick={() => void submit()}
          >
            {saving ? 'Saving…' : 'Save replacement'}
          </button>
        </>
      }
    >
      <p className="note">
        Replacing <strong>{blip.title || 'this decision'}</strong>. Its original text and comments
        stay available; you can follow the history from either decision.
      </p>
      <label className="mt-4 block" htmlFor={id}>
        New decision
      </label>
      <textarea
        id={id}
        className="field mt-2 min-h-40 w-full"
        value={body}
        maxLength={LIMITS.blipBody}
        disabled={saving}
        placeholder="What is the new decision, and why did it change?"
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (
            event.key === 'Enter' &&
            (event.metaKey || event.ctrlKey) &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault();
            void submit();
          }
        }}
      />
      {error ? (
        <p role="alert" className="note mt-3">
          {error}
        </p>
      ) : null}
    </Modal>
  );
}
