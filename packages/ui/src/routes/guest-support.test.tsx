// @vitest-environment jsdom
import { act, StrictMode, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { guestSupportApi } from '../lib/guest-support';
import { setNativeValue, must } from '../lib/must';
import { GuestSupportRoute } from './guest-support';
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));
let root: Root;
let host: HTMLDivElement;
const token = 'a'.repeat(43),
  recoveryCode = 'b'.repeat(43),
  expiry = '2026-11-01T00:00:00Z';
const thread = {
  expiresAt: expiry,
  thread: {
    request: {
      id: '6ad6a357-d92c-4238-a025-0cd0a5fb1536',
      category: 'account' as const,
      title: 'Lost email',
      body: '<script>private</script>',
      status: 'received' as const,
      createdAt: '2026-10-03T00:00:00Z',
    },
    replies: [],
    next: null,
  },
};
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  sessionStorage.clear();
  window.history.replaceState(null, '', '/help');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  vi.spyOn(guestSupportApi, 'get').mockResolvedValue({ thread: null, expiresAt: expiry });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  sessionStorage.clear();
});
async function render() {
  await act(async () =>
    root.render(
      <StrictMode>
        <GuestSupportRoute />
      </StrictMode>,
    ),
  );
}
async function change(label: string, value: string) {
  const control = must(
    [...host.querySelectorAll('label')]
      .find((el) => el.textContent.includes(label))
      ?.querySelector<HTMLInputElement | HTMLTextAreaElement>('input,textarea'),
  );
  await act(async () => {
    control.focus();
    setNativeValue(control, value);
    control.dispatchEvent(new Event('input', { bubbles: true }));
    control.dispatchEvent(new Event('keyup', { bubbles: true }));
  });
}
async function submit(name: string) {
  const form = must(host.querySelector(`form[aria-label="${name}"]`));
  await act(async () =>
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
}
it('offers signed-out intake without calling login or claiming an unsent receipt', async () => {
  await render();
  expect(host.querySelector('form[aria-label="New signed-out support request"]')).not.toBeNull();
  expect(host.textContent).toContain('do not send email');
  expect(host.textContent).not.toContain('reached the private support queue');
  expect(guestSupportApi.get).not.toHaveBeenCalled();
});
it('preserves fragment capabilities through strict initialization and removes the secret from the address', async () => {
  window.history.replaceState(null, '', `/help#${token}`);
  await render();
  expect(guestSupportApi.get).toHaveBeenCalledWith(token);
  expect(window.location.hash).toBe('');
  expect(sessionStorage.getItem('omr-guest-support')).toContain(token);
});
it('keeps failed text and operation identity, then shows a confirmed receipt with a private recovery code', async () => {
  vi.spyOn(guestSupportApi, 'start').mockResolvedValue({ token, recoveryCode, expiresAt: expiry });
  const create = vi
    .spyOn(guestSupportApi, 'create')
    .mockRejectedValueOnce(new Error('Temporary failure'))
    .mockResolvedValue(thread);
  await render();
  await change('Short summary', 'Lost email');
  await change('What happened?', 'Cannot access my mailbox');
  await submit('New signed-out support request');
  expect(host.textContent).toContain('Temporary failure');
  expect(host.textContent).not.toContain('reached the private support queue');
  expect(host.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe(
    'Cannot access my mailbox',
  );
  await submit('New signed-out support request');
  expect(create.mock.calls[0]?.[1].operationId).toBe(create.mock.calls[1]?.[1].operationId);
  expect(host.textContent).toContain('reached the private support queue');
  expect(host.querySelector('script')).toBeNull();
  expect(host.textContent).toContain(`Reference ${thread.thread.request.id.slice(0, 8)}`);
  expect(guestSupportApi.start).toHaveBeenCalledTimes(1);
});
it('renders released content as text and retains failed replies', async () => {
  sessionStorage.setItem('omr-guest-support', JSON.stringify({ token }));
  vi.mocked(guestSupportApi.get).mockResolvedValue({
    ...thread,
    thread: {
      ...thread.thread,
      replies: [
        { id: 'reply', from: 'support', body: '<img src=x onerror=alert(1)>', createdAt: expiry },
      ],
    },
  });
  vi.spyOn(guestSupportApi, 'reply').mockRejectedValue(new Error('Try again'));
  await render();
  expect(host.querySelector('img')).toBeNull();
  await change('Your reply', 'A follow-up');
  const form = must(host.querySelector('form'));
  await act(async () =>
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
  expect(host.textContent).toContain('Try again');
  expect(host.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('A follow-up');
});
it('switches saved links on the mounted page and clears the previous thread before a refused link', async () => {
  const other = 'c'.repeat(43);
  sessionStorage.setItem('omr-guest-support', JSON.stringify({ token, recoveryCode }));
  vi.mocked(guestSupportApi.get).mockImplementation(async (value) => {
    if (value === token) return thread;
    throw new Error('Conversation unavailable');
  });
  await render();
  expect(host.textContent).toContain('Lost email');
  await act(async () => {
    window.history.replaceState(null, '', `/help#${other}`);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
  expect(guestSupportApi.get).toHaveBeenCalledWith(other);
  expect(host.textContent).toContain('Conversation unavailable');
  expect(host.textContent).not.toContain('Lost email');
  expect(host.textContent).not.toContain('Loading the saved conversation');
  expect(host.querySelector('input[value="' + recoveryCode + '"]')).toBeNull();
  expect(window.location.hash).toBe('');
});

const otherToken = 'c'.repeat(43);
const otherThread = {
  ...thread,
  thread: {
    ...thread.thread,
    request: {
      ...thread.thread.request,
      id: 'a3458de7-7021-4f6c-b08b-53a8afc3c04e',
      title: 'Conversation B',
      body: 'Private body for B',
    },
  },
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function click(text: string) {
  const button = must([...host.querySelectorAll('button')].find((el) => el.textContent === text));
  await act(async () => button.click());
}
async function switchLink(value = otherToken) {
  await act(async () => {
    window.history.replaceState(null, '', `/help#${value}`);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
}
async function showA(next: string | null = null) {
  sessionStorage.setItem('omr-guest-support', JSON.stringify({ token, recoveryCode }));
  vi.mocked(guestSupportApi.get).mockImplementation(async (value) =>
    value === otherToken ? otherThread : { ...thread, thread: { ...thread.thread, next } },
  );
  await render();
}
function expectB() {
  expect(host.textContent).toContain('Conversation B');
  expect(host.textContent).not.toContain('Lost email');
  expect(host.textContent).not.toContain('<script>private</script>');
  expect(host.querySelector<HTMLInputElement>('input[readonly]')?.value).toContain(otherToken);
  expect(sessionStorage.getItem('omr-guest-support')).toContain(otherToken);
  expect(host.textContent).not.toContain('Recovered.');
  expect(host.textContent).not.toContain('were revoked');
  expect(host.textContent).not.toContain('reached the private support queue');
  expect(host.textContent).not.toContain('Old operation failed');
}

it.each(['reply', 'refresh', 'pagination', 'revoke'] as const)(
  'discards late %s success and its cleanup after switching conversation, keeping the next reply bound to B',
  async (action) => {
    await showA(action === 'pagination' ? 'cursor-A' : null);
    const pending = deferred<typeof thread>();
    const revoke = deferred<{ revoked: true }>();
    const replyApi = vi.spyOn(guestSupportApi, 'reply');
    if (action === 'reply') {
      replyApi.mockReturnValueOnce(pending.promise);
      await change('Your reply', 'Reply originally written for A');
      await click('Send reply');
      expect(replyApi.mock.calls[0]?.[0]).toBe(token);
    } else if (action === 'revoke') {
      vi.spyOn(guestSupportApi, 'revoke').mockReturnValueOnce(revoke.promise);
      await click('Revoke this link');
    } else {
      vi.mocked(guestSupportApi.get).mockReturnValueOnce(pending.promise);
      await click(action === 'refresh' ? 'Refresh conversation' : 'Load more replies');
    }
    await switchLink();
    expectB();
    const newReply = deferred<typeof otherThread>();
    replyApi.mockReturnValueOnce(newReply.promise);
    await change('Your reply', 'New reply written for B');
    await click('Send reply');
    expect(replyApi.mock.calls.at(-1)?.[0]).toBe(otherToken);
    await act(async () => {
      if (action === 'revoke') revoke.resolve({ revoked: true });
      else pending.resolve(thread);
    });
    expectB();
    expect(host.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe(
      'New reply written for B',
    );
    expect(
      [...host.querySelectorAll('button')].find((el) => el.textContent === 'Send reply')?.disabled,
    ).toBe(true);
    await act(async () => newReply.resolve(otherThread));
    expectB();
    expect(host.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('');
  },
);
it.each(['reply', 'refresh', 'pagination', 'revoke'] as const)(
  'discards late %s error after switching conversation',
  async (action) => {
    await showA(action === 'pagination' ? 'cursor-A' : null);
    const pending = deferred<typeof thread>();
    const revoke = deferred<{ revoked: true }>();
    if (action === 'reply') {
      vi.spyOn(guestSupportApi, 'reply').mockReturnValueOnce(pending.promise);
      await change('Your reply', 'Old draft');
      await click('Send reply');
    } else if (action === 'revoke') {
      vi.spyOn(guestSupportApi, 'revoke').mockReturnValueOnce(revoke.promise);
      await click('Revoke this link');
    } else {
      vi.mocked(guestSupportApi.get).mockReturnValueOnce(pending.promise);
      await click(action === 'refresh' ? 'Refresh conversation' : 'Load more replies');
    }
    await switchLink();
    await act(async () => {
      if (action === 'revoke') revoke.reject(new Error('Old operation failed'));
      else pending.reject(new Error('Old operation failed'));
    });
    expectB();
    expect(host.querySelector('[role="alert"]')).toBeNull();
  },
);
it.each(['start', 'create'] as const)(
  'invalidates pending %s when a different saved link opens',
  async (stage) => {
    const started = deferred<{ token: string; recoveryCode: string; expiresAt: string }>();
    const created = deferred<typeof thread>();
    vi.spyOn(guestSupportApi, 'start').mockReturnValue(
      stage === 'start'
        ? started.promise
        : Promise.resolve({ token, recoveryCode, expiresAt: expiry }),
    );
    const create = vi.spyOn(guestSupportApi, 'create').mockReturnValue(created.promise);
    vi.mocked(guestSupportApi.get).mockResolvedValue(otherThread);
    await render();
    await change('Short summary', 'Old request title');
    await change('What happened?', 'Old request body');
    await submit('New signed-out support request');
    await switchLink();
    await act(async () => {
      if (stage === 'start') started.resolve({ token, recoveryCode, expiresAt: expiry });
      else created.resolve(thread);
    });
    expectB();
    if (stage === 'start') expect(create).not.toHaveBeenCalled();
  },
);
it('does not continue a started intake or persist its credentials after unmount', async () => {
  const pending = deferred<{ token: string; recoveryCode: string; expiresAt: string }>();
  vi.spyOn(guestSupportApi, 'start').mockReturnValue(pending.promise);
  const create = vi.spyOn(guestSupportApi, 'create');
  await render();
  await change('Short summary', 'Unmounted request');
  await change('What happened?', 'Must not continue');
  await submit('New signed-out support request');
  await act(async () => root.unmount());
  await act(async () => pending.resolve({ token, recoveryCode, expiresAt: expiry }));
  expect(create).not.toHaveBeenCalled();
  expect(sessionStorage.getItem('omr-guest-support')).toBeNull();
});
it.each(['recover', 'get'] as const)(
  'clears the previous thread before recovery and invalidates pending %s on link switch',
  async (stage) => {
    await showA();
    const recoveredToken = 'd'.repeat(43);
    const pendingRecovery = deferred<{ token: string; expiresAt: string }>();
    const pendingRead = deferred<typeof thread>();
    vi.spyOn(guestSupportApi, 'recover').mockReturnValue(
      stage === 'recover'
        ? pendingRecovery.promise
        : Promise.resolve({ token: recoveredToken, expiresAt: expiry }),
    );
    const get = vi.mocked(guestSupportApi.get);
    get.mockImplementation((value) =>
      value === recoveredToken ? pendingRead.promise : Promise.resolve(otherThread),
    );
    await change('Saved recovery code', recoveryCode);
    await click('Recover conversation');
    expect(host.textContent).not.toContain('Lost email');
    expect(host.textContent).not.toContain('<script>private</script>');
    await switchLink();
    await act(async () => {
      if (stage === 'recover')
        pendingRecovery.resolve({ token: recoveredToken, expiresAt: expiry });
      else pendingRead.resolve(thread);
    });
    expectB();
    if (stage === 'recover') expect(get).not.toHaveBeenCalledWith(recoveredToken);
  },
);
it('recovery failure leaves the previous private thread cleared', async () => {
  await showA();
  vi.spyOn(guestSupportApi, 'recover').mockRejectedValue(new Error('Recovery unavailable'));
  await change('Saved recovery code', recoveryCode);
  await click('Recover conversation');
  expect(host.textContent).toContain('Recovery unavailable');
  expect(host.textContent).not.toContain('Lost email');
  expect(host.querySelector('section[aria-label="Support conversation"]')).toBeNull();
  expect(sessionStorage.getItem('omr-guest-support')).toBeNull();
});
it('does not revive a delayed result even when the same token is opened again', async () => {
  await showA();
  const pending = deferred<typeof thread>();
  vi.spyOn(guestSupportApi, 'reply').mockReturnValueOnce(pending.promise);
  await change('Your reply', 'From the earlier visit');
  await click('Send reply');
  await switchLink();
  await switchLink(token);
  await change('Your reply', 'New draft after returning to A');
  const oldResult = {
    ...thread,
    thread: {
      ...thread.thread,
      request: { ...thread.thread.request, title: 'Stale earlier visit' },
    },
  };
  await act(async () => pending.resolve(oldResult));
  expect(host.textContent).not.toContain('Stale earlier visit');
  expect(host.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe(
    'New draft after returning to A',
  );
});
it('discards a pending initial read when the mounted page changes links', async () => {
  const pending = deferred<typeof thread>();
  sessionStorage.setItem('omr-guest-support', JSON.stringify({ token }));
  vi.mocked(guestSupportApi.get).mockImplementation((value) =>
    value === token ? pending.promise : Promise.resolve(otherThread),
  );
  await render();
  await switchLink();
  await act(async () => pending.resolve(thread));
  expectB();
});
it.each(['start', 'create'] as const)(
  'discards pending %s failure after changing links',
  async (stage) => {
    const started = deferred<{ token: string; recoveryCode: string; expiresAt: string }>();
    const created = deferred<typeof thread>();
    vi.spyOn(guestSupportApi, 'start').mockReturnValue(
      stage === 'start'
        ? started.promise
        : Promise.resolve({ token, recoveryCode, expiresAt: expiry }),
    );
    vi.spyOn(guestSupportApi, 'create').mockReturnValue(created.promise);
    vi.mocked(guestSupportApi.get).mockResolvedValue(otherThread);
    await render();
    await change('Short summary', 'Old request');
    await change('What happened?', 'Old body');
    await submit('New signed-out support request');
    await switchLink();
    await act(async () => {
      if (stage === 'start') started.reject(new Error('Old operation failed'));
      else created.reject(new Error('Old operation failed'));
    });
    expectB();
  },
);
it.each(['recover', 'get'] as const)(
  'discards pending recovery %s failure after changing links',
  async (stage) => {
    await showA();
    const recoveredToken = 'd'.repeat(43);
    const pendingRecovery = deferred<{ token: string; expiresAt: string }>();
    const pendingRead = deferred<typeof thread>();
    vi.spyOn(guestSupportApi, 'recover').mockReturnValue(
      stage === 'recover'
        ? pendingRecovery.promise
        : Promise.resolve({ token: recoveredToken, expiresAt: expiry }),
    );
    vi.mocked(guestSupportApi.get).mockImplementation((value) =>
      value === recoveredToken ? pendingRead.promise : Promise.resolve(otherThread),
    );
    await change('Saved recovery code', recoveryCode);
    await click('Recover conversation');
    await switchLink();
    await act(async () => {
      if (stage === 'recover') pendingRecovery.reject(new Error('Old operation failed'));
      else pendingRead.reject(new Error('Old operation failed'));
    });
    expectB();
  },
);
