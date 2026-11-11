import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CalendarClock } from 'lucide-react';
import type { BlipDto } from '@onmyradar/contract';
import { api, ApiError } from '../lib/api';
import { invalidateBlipLists } from '../lib/session';
import { Modal } from './primitives';
import { Select } from './select';

export function localDateTime(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
export function dueInstant(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || localDateTime(date.toISOString()) !== value)
    throw new Error('That local time does not exist. Choose another time.');
  return date.toISOString();
}
export function DueControl({
  blip,
  canWrite = false,
  showLabel = false,
}: {
  blip: BlipDto;
  canWrite?: boolean;
  showLabel?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="btn btn-ghost"
        onClick={() => setOpen(true)}
        aria-label={
          !canWrite ? 'Personal reminder' : blip.dueAt ? 'Due date and reminder' : 'Set due date'
        }
        title={
          !canWrite ? 'Personal reminder' : blip.dueAt ? 'Due date and reminder' : 'Set due date'
        }
      >
        <CalendarClock size={16} />
        {showLabel ? <span>Due</span> : null}
      </button>
      {open ? <DueDialog blip={blip} canWrite={canWrite} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
function DueDialog({
  blip,
  canWrite,
  onClose,
}: {
  blip: BlipDto;
  canWrite: boolean;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const [date, setDate] = useState(localDateTime(blip.dueAt));
  const [remind, setRemind] = useState(Boolean(blip.reminder));
  const [lead, setLead] = useState<0 | 60 | 1440>(blip.reminder?.leadMinutes ?? 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedDate, setSavedDate] = useState(blip.dueAt ?? null);
  const refresh = () => invalidateBlipLists(client);
  const save = async () => {
    setBusy(true);
    setError(null);
    let changed = false;
    try {
      const next = canWrite && date !== localDateTime(savedDate) ? dueInstant(date) : savedDate;
      if (canWrite && next !== savedDate) {
        await api.blips.update(blip.id, { dueAt: next });
        setSavedDate(next);
        changed = true;
      }
      try {
        if (remind && next && (!blip.reminder || blip.reminder.leadMinutes !== lead))
          await api.blips.setReminder(blip.id, lead);
        else if (!remind && blip.reminder) await api.blips.removeReminder(blip.id);
      } catch (err) {
        await refresh();
        throw new Error(
          `${changed ? 'Due date saved. ' : ''}${err instanceof ApiError ? err.message : 'The reminder could not be updated. Please try again.'}`,
        );
      }
      await refresh();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save. Please try again.');
    } finally {
      setBusy(false);
    }
  };
  const reason = blip.reminder?.reason;
  const reminderInPast = Boolean(date && new Date(date).getTime() - lead * 60000 <= Date.now());
  return (
    <Modal
      title="Due date and reminder"
      description="The due date is shared. Reminders are just for you."
      onClose={() => {
        if (!busy) onClose();
      }}
      footer={
        <>
          <button className="btn btn-ghost" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-accent" disabled={busy} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <label className="flex flex-col gap-2">
        Due date
        <input
          type="datetime-local"
          className="field"
          value={date}
          disabled={!canWrite || busy}
          onChange={(e) => {
            setDate(e.target.value);
            if (!date && e.target.value && !blip.reminder) setRemind(true);
          }}
        />
      </label>
      <p className="note mt-2">
        Time zone: {Intl.DateTimeFormat().resolvedOptions().timeZone}. “Later” does not set a date
        or reminder.
      </p>
      {canWrite && date ? (
        <button className="btn btn-ghost mt-2" disabled={busy} onClick={() => setDate('')}>
          Clear due date
        </button>
      ) : null}
      {!canWrite ? (
        <p className="note mt-2">Only radar editors can change the shared due date.</p>
      ) : null}
      <label className="mt-5 flex items-center gap-3">
        <input
          type="checkbox"
          checked={remind}
          disabled={busy || (!date && !blip.reminder)}
          onChange={(e) => setRemind(e.target.checked)}
        />
        Remind me
      </label>
      {remind ? (
        <Select
          className="field mt-3 w-full"
          aria-label="Reminder timing"
          value={String(lead)}
          disabled={
            busy ||
            !date ||
            (blip.reminder?.status === 'triggered' && date === localDateTime(savedDate))
          }
          onValueChange={(v) => setLead(Number(v) as 0 | 60 | 1440)}
          options={[
            { value: '0', label: 'At due time' },
            { value: '60', label: '1 hour before' },
            { value: '1440', label: '1 day before' },
          ]}
        />
      ) : null}
      <p className="note mt-3">
        Reminders follow your notification preferences and radar mute settings.
      </p>
      {remind && reminderInPast ? (
        <p className="note mt-2">
          This reminder time has passed. The due date will remain visible, but no future alert is
          scheduled.
        </p>
      ) : null}
      {blip.reminder?.status === 'triggered' ? (
        <p className="note mt-2">
          This reminder has already created an activity notification. Change the due date to
          schedule another.
        </p>
      ) : null}
      {!date && remind ? (
        <p className="note mt-2">Your reminder will pause until a due date is set.</p>
      ) : reason ? (
        <p className="note mt-2">
          {reason === 'completed'
            ? 'Paused because this blip is completed.'
            : reason === 'radar_archived'
              ? 'Paused while this radar is archived.'
              : reason === 'past_time'
                ? 'This reminder time has passed. Choose a future date to schedule another.'
                : 'Paused until a due date is set.'}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="note mt-3">
          {error}
        </p>
      ) : null}
    </Modal>
  );
}
