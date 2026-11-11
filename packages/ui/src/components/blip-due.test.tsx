// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import type { BlipDto } from '@onmyradar/contract';
import { DueControl, dueInstant, localDateTime } from './blip-due';
import { api } from '../lib/api';
import { must, setNativeValue } from '../lib/must';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => vi.restoreAllMocks());
it('roundtrips local dates and rejects invalid wall clock values', () => {
  const value = '2030-05-20T14:15';
  expect(localDateTime(dueInstant(value))).toBe(value);
  expect(dueInstant('')).toBeNull();
  expect(() => dueInstant('2030-02-30T14:15')).toThrow('does not exist');
});
it('retains reminder draft after partial save and retries without rewriting the shared date', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const update = vi
    .spyOn(api.blips, 'update')
    .mockResolvedValue({} as Awaited<ReturnType<typeof api.blips.update>>);
  const reminder = vi
    .spyOn(api.blips, 'setReminder')
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue({ reminder: null });
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <DueControl blip={{ id: 'one', dueAt: null, reminder: null } as BlipDto} canWrite />
      </QueryClientProvider>,
    ),
  );
  await act(async () => must(host.querySelector('button')).click());
  const input = must(document.querySelector<HTMLInputElement>('input[type="datetime-local"]'));
  await act(async () => {
    setNativeValue(input, '2030-05-20T14:15');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const save = () =>
    must([...document.querySelectorAll('button')].find((b) => b.textContent === 'Save'));
  await act(async () => save().click());
  expect(update).toHaveBeenCalledTimes(1);
  expect(reminder).toHaveBeenCalledWith('one', 0);
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Due date saved');
  expect(input.value).toBe('2030-05-20T14:15');
  await act(async () => save().click());
  expect(update).toHaveBeenCalledTimes(1);
  expect(reminder).toHaveBeenCalledTimes(2);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await act(async () => root.unmount());
  host.remove();
});
it('allows readers to manage a reminder without changing the shared date', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const update = vi.spyOn(api.blips, 'update');
  const reminder = vi.spyOn(api.blips, 'setReminder').mockResolvedValue({ reminder: null });
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <DueControl
          blip={{ id: 'read', dueAt: '2030-05-20T14:15:00Z', reminder: null } as BlipDto}
        />
      </QueryClientProvider>,
    ),
  );
  await act(async () => must(host.querySelector('button')).click());
  expect(
    must(document.querySelector<HTMLInputElement>('input[type="datetime-local"]')).disabled,
  ).toBe(true);
  await act(async () =>
    must(document.querySelector<HTMLInputElement>('input[type="checkbox"]')).click(),
  );
  await act(async () =>
    must([...document.querySelectorAll('button')].find((b) => b.textContent === 'Save')).click(),
  );
  expect(update).not.toHaveBeenCalled();
  expect(reminder).toHaveBeenCalledWith('read', 0);
  await act(async () => root.unmount());
  host.remove();
});

it('clearing a date pauses existing consent without a PUT that requires a date', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const update = vi
    .spyOn(api.blips, 'update')
    .mockResolvedValue({} as Awaited<ReturnType<typeof api.blips.update>>);
  const set = vi.spyOn(api.blips, 'setReminder');
  const remove = vi.spyOn(api.blips, 'removeReminder');
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <DueControl
          canWrite
          blip={
            {
              id: 'paused',
              dueAt: '2030-05-20T14:15:25Z',
              reminder: {
                leadMinutes: 60,
                status: 'scheduled',
                reminderAt: '2030-05-20T13:15:25Z',
                reason: null,
              },
            } as BlipDto
          }
        />
      </QueryClientProvider>,
    ),
  );
  await act(async () => must(host.querySelector('button')).click());
  await act(async () =>
    must(
      [...document.querySelectorAll('button')].find((b) => b.textContent === 'Clear due date'),
    ).click(),
  );
  await act(async () =>
    must([...document.querySelectorAll('button')].find((b) => b.textContent === 'Save')).click(),
  );
  expect(update).toHaveBeenCalledWith('paused', { dueAt: null });
  expect(set).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
  await act(async () => root.unmount());
  host.remove();
});
