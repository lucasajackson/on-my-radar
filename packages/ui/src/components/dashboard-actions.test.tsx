// @vitest-environment jsdom
/**
 * A dashboard item says where it is (the chip, from the radar's own lane set)
 * and names the move it offers (the button, from the contract's advanceTarget).
 * The button used to read just "Done", which a person takes for the item's
 * status. No lane word below is hard-coded in the component.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import type { BlipDto, RadarDto } from '@onmyradar/contract';
import { DashboardBlipActions, undoFiling } from './dashboard-actions';

vi.mock('./due-chip', () => ({ DueChip: () => null }));
vi.mock('./blip-due', () => ({ DueControl: () => null }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => {
  document.body.innerHTML = '';
});

const radar = (template: string, canWrite = true) =>
  ({
    id: 'r1',
    template,
    templateConfig: {},
    isDropBox: false,
    access: { canWrite },
  }) as unknown as RadarDto;
const blip = (fields: Partial<BlipDto>) =>
  ({
    id: 'b1',
    radarId: 'r1',
    title: 'Thing',
    body: '',
    state: 'inbox',
    status: null,
    ...fields,
  }) as unknown as BlipDto;

async function show(r: RadarDto, b: BlipDto) {
  const host = document.createElement('div');
  document.body.append(host);
  await act(async () =>
    createRoot(host).render(
      <QueryClientProvider client={new QueryClient()}>
        <DashboardBlipActions blip={b} radar={r} />
      </QueryClientProvider>,
    ),
  );
  return {
    chip: host.querySelector('.chip-status')?.textContent ?? null,
    action: host.querySelector('button')?.textContent.trim() ?? null,
    name: host.querySelector('button')?.getAttribute('aria-label') ?? null,
  };
}

it('shows the current lane and an action worded from the lane set', async () => {
  expect(await show(radar('reading'), blip({ status: 'reading', state: 'active' }))).toEqual({
    chip: 'Reading',
    action: 'Move to Finished',
    name: 'Move to Finished: Thing',
  });
});

it('falls back to the universal state on a laneless radar', async () => {
  expect(await show(radar('stream'), blip({ state: 'active' }))).toEqual({
    chip: 'Active',
    action: 'Move to Done',
    name: 'Move to Done: Thing',
  });
});

it('settled items show their lane and offer no forward move', async () => {
  expect(await show(radar('reading'), blip({ status: 'finished', state: 'done' }))).toEqual({
    chip: 'Finished',
    action: null,
    name: null,
  });
});

it('read-only radars still show the chip; triage-less templates show none', async () => {
  expect((await show(radar('reading', false), blip({ status: 'unread' }))).chip).toBe('Unread');
  expect(await show(radar('microblog'), blip({}))).toEqual({
    chip: null,
    action: null,
    name: null,
  });
});

it('puts a filed blip back with its lane only when the lane means its state', () => {
  const board = radar('kanban');
  // doing is active: both go. A dropped card sitting in To do has no lane for its state: state alone.
  expect(undoFiling(blip({ status: 'doing', state: 'active' }), board)).toEqual({
    radarId: 'r1',
    state: 'active',
    status: 'doing',
  });
  expect(undoFiling(blip({ status: 'todo', state: 'dropped' }), board)).toEqual({
    radarId: 'r1',
    state: 'dropped',
  });
  expect(undoFiling(blip({ status: null, state: 'inbox' }), radar('stream'))).toEqual({
    radarId: 'r1',
    state: 'inbox',
  });
});
