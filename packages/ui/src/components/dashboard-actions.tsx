import { DueControl } from './blip-due';
import { DueChip } from './due-chip';
import { createContext, useContext, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight, FolderInput, GripVertical } from 'lucide-react';
import type { BlipDto, RadarDto, UpdateBlipRequest } from '@onmyradar/contract';
import {
  BLIP_STATE_LABELS,
  advanceTarget,
  findStatus,
  statusesFor,
  templateFor,
} from '@onmyradar/contract';
import { ApiError, api } from '../lib/api';
import { invalidateBlipLists } from '../lib/session';
import { Modal, notify } from './primitives';

/**
 * Where the blip is now, in the radar's own words: its lane's label, else the
 * universal state. Shown only where the template shows triage at all, so a
 * timeline post carries no "Inbox" it never had.
 */
export function laneChipLabel(radar: RadarDto | undefined, blip: BlipDto): string | null {
  if (!radar) return null;
  const lanes = statusesFor(radar.template, radar.templateConfig);
  if (!lanes.length && !templateFor(radar.template, radar.templateConfig).showTriage) return null;
  return lanes.find((lane) => lane.id === blip.status)?.label ?? BLIP_STATE_LABELS[blip.state];
}

const DRAG_TYPE = 'application/x-onmyradar-blip';
const Context = createContext<{
  radars: RadarDto[];
  dragging: BlipDto | null;
  setDragging: (blip: BlipDto | null) => void;
  file: (blip: BlipDto, radar: RadarDto) => Promise<boolean>;
} | null>(null);

/**
 * Puts a filed blip back. The lane goes with the state only when the lane means that state; a state
 * no lane carries (a dropped card sitting in To do) goes alone, since the server refuses a pair
 * that disagrees.
 */
export function undoFiling(blip: BlipDto, home: RadarDto | undefined): UpdateBlipRequest {
  const lane = blip.status ? findStatus(home?.template, blip.status, home?.templateConfig) : null;
  return {
    radarId: blip.radarId,
    state: blip.state,
    ...(lane && lane.state === blip.state ? { status: blip.status } : {}),
  };
}

export function DashboardActions({
  radars,
  children,
}: {
  radars: RadarDto[];
  children: ReactNode;
}) {
  const [dragging, setDragging] = useState<BlipDto | null>(null);
  const client = useQueryClient();
  const refresh = () => invalidateBlipLists(client);
  const file = async (blip: BlipDto, radar: RadarDto) => {
    if (radar.kind !== 'standard' || !radar.access.canWrite || radar.id === blip.radarId)
      return false;
    try {
      await api.blips.update(blip.id, { radarId: radar.id });
      setDragging(null);
      await refresh();
      notify(`Filed to ${radar.name}`, 'ok', {
        label: 'Undo',
        run: () => {
          void api.blips
            .update(
              blip.id,
              undoFiling(
                blip,
                radars.find((item) => item.id === blip.radarId),
              ),
            )
            .then(refresh)
            .catch((error: unknown) =>
              notify(error instanceof ApiError ? error.message : 'Could not undo filing', 'error'),
            );
        },
      });
      return true;
    } catch (error) {
      notify(error instanceof ApiError ? error.message : 'Could not file this blip', 'error');
      return false;
    }
  };
  return (
    <Context.Provider value={{ radars, dragging, setDragging, file }}>{children}</Context.Provider>
  );
}

export function DashboardDropTarget({ radar, children }: { radar: RadarDto; children: ReactNode }) {
  const context = useContext(Context);
  const [over, setOver] = useState(false);
  const eligible =
    !!context?.dragging &&
    radar.kind === 'standard' &&
    radar.access.canWrite &&
    radar.id !== context.dragging.radarId;
  return (
    <div
      className={`dashboard-drop-target ${eligible ? 'accepts-drop' : ''} ${eligible && over ? 'is-over' : ''}`}
      data-file-target={radar.id}
      onDragOver={(event) => {
        if (eligible && event.dataTransfer.types.includes(DRAG_TYPE)) {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          setOver(true);
        }
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={(event) => {
        setOver(false);
        if (!eligible || !context.dragging) return;
        event.preventDefault();
        void context.file(context.dragging, radar);
      }}
    >
      {eligible && over ? <div className="dashboard-drop-hint">File to {radar.name}</div> : null}
      {children}
    </div>
  );
}

export function DashboardBlipActions({
  blip,
  radar,
}: {
  blip: BlipDto;
  radar: RadarDto | undefined;
}) {
  const context = useContext(Context);
  const client = useQueryClient();
  const [filing, setFiling] = useState(false);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const current = laneChipLabel(radar, blip);
  const chip = current ? (
    <span className="chip-status" title="Current lane">
      {current}
    </span>
  ) : null;
  if (!radar?.access.canWrite)
    return (
      <div className="blip-due-row">
        {chip}
        <DueChip blip={blip} personal />
        <DueControl blip={blip} />
      </div>
    );
  const label = blip.title || blip.email?.subject || blip.body.slice(0, 60) || 'blip';
  /*
    The button names the move ("Move to Done"); the chip beside it names where
    the blip is. The target's label is a destination, never a status.
    "Done" is the contract's advance (`advanceTarget`): the lane's own word and
    lane on a template with lanes ("Finished" on a reading list), and nothing
    at all where the template has no triage to show. It wrote `state: 'done'`
    everywhere, which put a reading-list blip in whichever lane the server
    mapped Done to and marked timeline posts done where nothing shows it.
    Only a forward move is offered here; reopening stays on the card.
  */
  const target = advanceTarget(radar, blip);
  const advance = target && !target.reopens ? target : null;
  const complete = async () => {
    if (!advance) return;
    setBusy(true);
    try {
      await api.blips.update(
        blip.id,
        advance.status ? { status: advance.status } : { state: advance.state ?? 'done' },
      );
      await invalidateBlipLists(client);
      notify(advance.acknowledgement);
    } catch (error) {
      notify(
        error instanceof ApiError ? error.message : `Could not ${advance.label.toLowerCase()}`,
        'error',
      );
    } finally {
      setBusy(false);
    }
  };
  const targets =
    context?.radars.filter(
      (item) =>
        item.id !== radar.id &&
        item.kind === 'standard' &&
        item.access.canWrite &&
        item.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase()),
    ) ?? [];
  return (
    <>
      <div className="dashboard-blip-actions">
        {chip}
        <DueChip blip={blip} personal />
        <DueControl blip={blip} canWrite />
        {advance ? (
          <button
            className="btn btn-ghost"
            disabled={busy}
            onClick={() => void complete()}
            aria-label={`Move to ${advance.label}: ${label}`}
            title={`Move to ${advance.label}`}
          >
            <ArrowRight size={15} /> <span>Move to {advance.label}</span>
          </button>
        ) : null}
        {radar.isDropBox && context ? (
          <>
            <button
              className="btn btn-ghost"
              onClick={() => setFiling(true)}
              aria-label={`File ${label} to radar`}
              title="File to radar"
            >
              <FolderInput size={15} />
              <span>File</span>
            </button>
            <span
              className="dashboard-file-grip"
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData(DRAG_TYPE, blip.id);
                event.dataTransfer.effectAllowed = 'move';
                context.setDragging(blip);
              }}
              onDragEnd={() => context.setDragging(null)}
              title="Drag to a radar panel to file"
              aria-hidden="true"
            >
              <GripVertical size={15} />
            </span>
          </>
        ) : null}
      </div>
      {filing && context ? (
        <Modal
          title="File to radar"
          description="Move this blip out of Drop box. Its content and attachments stay together."
          onClose={() => setFiling(false)}
        >
          <label className="flex flex-col gap-2">
            <span className="note">Find a radar</span>
            <input
              className="field"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
          </label>
          <div className="mt-3 flex flex-col gap-1">
            {targets.map((target) => (
              <button
                key={target.id}
                className="btn justify-start"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void context.file(blip, target).then((success) => {
                    setBusy(false);
                    if (success) setFiling(false);
                  });
                }}
              >
                {target.name}
              </button>
            ))}
            {!targets.length ? <p className="note">No writable radars match.</p> : null}
          </div>
        </Modal>
      ) : null}
    </>
  );
}
