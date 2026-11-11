// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { DecisionReplacement } from './decision-replacement';
import { api, ApiError } from '../lib/api';
import { must, setNativeValue } from '../lib/must';

it('retains replacement text after a rejected original and retries the exact supersession request', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const create = vi
    .spyOn(api.radars, 'createBlip')
    .mockRejectedValueOnce(new ApiError(400, 'bad_request', 'The original moved to another radar'));
  const saved = vi.fn();
  await act(async () =>
    root.render(
      <DecisionReplacement
        blip={{ id: 'original', radarId: 'decisions', title: 'Previous choice' }}
        onClose={vi.fn()}
        onCreated={saved}
      />,
    ),
  );
  const input = must(document.querySelector('textarea'));
  const save = must(
    [...document.querySelectorAll('button')].find(
      (button) => button.textContent === 'Save replacement',
    ),
  );
  expect(save.disabled).toBe(true);
  await act(async () => {
    setNativeValue(input, 'Use native plants');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => save.click());
  expect(create).toHaveBeenCalledWith('decisions', {
    body: 'Use native plants',
    supersedes: 'original',
  });
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('original moved');
  expect(input.value).toBe('Use native plants');
  expect(saved).not.toHaveBeenCalled();
  create.mockResolvedValueOnce({} as Awaited<ReturnType<typeof api.radars.createBlip>>);
  await act(async () => save.click());
  expect(saved).toHaveBeenCalledOnce();
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});
