/**
 * Quick drop — capture into the drop box from anywhere in the app.
 *
 * The drop box's whole premise is "things with no home yet". If getting one in
 * there means first deciding to navigate to a radar, the thought has already had
 * to survive a decision, and capture is supposed to be cheaper than the thought.
 * So this is reachable from every screen: ⌘K (Ctrl+K), the button in the
 * sidebar, or the capture tab on a phone.
 *
 * It is one box and nothing else — no radar picker, no state picker, no tag
 * field. Everything is inferred exactly as it is in the ordinary composer,
 * because it *is* the ordinary capture path with the radar chosen for you.
 */
import { useState } from 'react';
import { useDraft } from '../lib/drafts';
import { useQueryClient } from '@tanstack/react-query';
import { Compass, Loader2, Send } from 'lucide-react';
import { extractInlineTags, LIMITS, soleUrl } from '@onmyradar/contract';
import { ApiError, api } from '../lib/api';
import { queryKeys } from '../lib/session';
import { PHONE_QUERY, useMediaQuery } from '../lib/viewport';
import { Modal, notify } from './primitives';

export function QuickDropDialog({
  dropBoxId,
  onClose,
}: {
  /** Null while the drop box is still being provisioned on first load. */
  dropBoxId: string | null;
  onClose: () => void;
}) {
  const client = useQueryClient();
  // Escape closes the box, not the thought: reopening brings the text back.
  const [body, setBody] = useDraft('quick-drop');
  const [saving, setSaving] = useState(false);
  const phone = useMediaQuery(PHONE_QUERY);

  const submit = async () => {
    if (!dropBoxId || !body.trim() || saving) return;
    setSaving(true);
    try {
      await api.radars.createBlip(dropBoxId, { body: body.trim() });
      await Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.radars }),
        client.invalidateQueries({ queryKey: ['blips', dropBoxId] }),
        client.invalidateQueries({ queryKey: queryKeys.allTags }),
      ]);
      setBody('');
      notify('Dropped in');
      onClose();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not drop that in', 'error');
      setSaving(false);
    }
  };

  const inferredTags = extractInlineTags(body);
  const isLink = soleUrl(body) !== null;

  const submitButton = (
    <button
      className="btn btn-accent shrink-0"
      data-omr="drop-submit"
      disabled={!dropBoxId || !body.trim() || saving}
      onClick={() => void submit()}
    >
      {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
      Drop it in
    </button>
  );

  return (
    <Modal
      title="Drop box"
      description="Anything with no home yet. An agent can sort it later."
      onClose={onClose}
      // On a phone this is a screen, not a sheet, and the button lives in the
      // header. Both because of the keyboard: a sheet has nowhere to be, and the
      // bottom of the screen is where iOS floats its accessory bar. See `Modal`.
      fill={phone}
      action={phone ? submitButton : undefined}
    >
      <div className="flex h-full flex-col gap-3">
        <label className="sr-only" htmlFor="quick-drop">
          What is it?
        </label>
        <textarea
          id="quick-drop"
          autoFocus
          rows={4}
          value={body}
          maxLength={LIMITS.blipBody}
          placeholder="Dentist Tuesday 3pm… call the plumber… #idea for the app…"
          // Full height on a phone: whatever room is left above the keyboard is
          // room to write in, and a fixed row count would either waste it or
          // overflow it.
          className={`field resize-none text-[15.5px] leading-relaxed ${phone ? 'min-h-0 flex-1' : ''}`}
          onChange={(event) => setBody(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault();
              void submit();
            }
          }}
        />

        <div className="flex shrink-0 items-center justify-between gap-3">
          {/* The same "show what is about to be inferred" contract the composer
              keeps — nothing the server derives should be a surprise. */}
          <span className="instrument flex min-w-0 items-center gap-1.5 truncate">
            <Compass className="h-3 w-3 shrink-0" aria-hidden="true" />
            {isLink
              ? 'will save as a link'
              : inferredTags.length > 0
                ? `tags · ${inferredTags.join(' · ')}`
                : phone
                  ? '#tags are inferred'
                  : 'cmd + enter to drop'}
          </span>
          {phone ? null : submitButton}
        </div>

        {!dropBoxId ? <p className="instrument shrink-0">setting up your drop box…</p> : null}
      </div>
    </Modal>
  );
}
