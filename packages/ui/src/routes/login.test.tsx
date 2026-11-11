// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, it, vi } from 'vitest';
import { ApiError, api } from '../lib/api';
import { must, setNativeValue } from '../lib/must';
import { LoginRoute } from './login';

vi.mock('@tanstack/react-router', () => ({
  useSearch: () => ({}),
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));
vi.mock('../lib/session', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useSession: () => ({ user: null, loading: false, error: null, refresh: vi.fn() }),
}));

it('tells a new address it will wait for approval, and links back to what this is', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.spyOn(api.auth, 'config').mockResolvedValue({
    email: { enabled: true, delivers: true },
    oidc: { enabled: false, name: 'SSO' },
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <LoginRoute />
        </QueryClientProvider>,
      ),
    );
    // Not "this creates your account" and stop: the account it creates waits.
    expect(host.textContent).toContain('New accounts join a waitlist until they are approved.');
    // Home: without a session cookie, `/` is the marketing site.
    const about = host.querySelector<HTMLAnchorElement>('a[href="/"]');
    expect(about?.textContent).toBe('What is On My Radar?');
    // Every screen names its tab; this one used to share "On My Radar" with all.
    expect(document.title).toBe('Sign in · On My Radar');
    expect(host.querySelector('a[href="/help"]')?.textContent).toBe(
      'Cannot sign in? Contact support',
    );
    // Dark like the marketing site it follows, whatever the device prefers.
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  }
  // …and only while it is on screen.
  expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
});

it('keeps the address after a mail failure and enters the code stage only after a successful retry', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.spyOn(api.auth, 'config').mockResolvedValue({
    email: { enabled: true, delivers: true },
    oidc: { enabled: false, name: 'SSO' },
  });
  let respond!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    respond = resolve;
  });
  const request = vi
    .spyOn(globalThis, 'fetch')
    .mockReturnValueOnce(pending)
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ status: 'sent', expiresAt: '2026-10-06T03:00:00.000Z' })),
    );
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <LoginRoute />
        </QueryClientProvider>,
      ),
    );
    const email = must(host.querySelector<HTMLInputElement>('input[type=email]'));
    await act(async () => {
      setNativeValue(email, 'ada@example.com');
      email.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const send = must(host.querySelector<HTMLButtonElement>('form button'));
    expect(send.disabled).toBe(false);
    await act(async () => send.click());
    expect(send.disabled).toBe(true);
    expect(host.querySelector('input[inputmode=numeric]')).toBeNull();

    await act(async () => {
      respond(
        new Response(
          JSON.stringify({
            error: {
              code: 'mail_failed',
              message: 'We could not send the code. Try again in a moment.',
            },
          }),
          { status: 502 },
        ),
      );
    });
    expect(must(host.querySelector('[role=alert]')).textContent).toBe(
      'We could not send the code. Try again in a moment.',
    );
    expect(must(host.querySelector<HTMLInputElement>('input[type=email]')).value).toBe(
      'ada@example.com',
    );
    expect(send.disabled).toBe(false);
    expect(host.querySelector('input[inputmode=numeric]')).toBeNull();
    expect(host.textContent).not.toContain('Six-digit code sent to');

    await act(async () => send.click());
    expect(request).toHaveBeenCalledTimes(2);
    for (const call of request.mock.calls) {
      expect(call).toEqual([
        '/api/auth/request-code',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ email: 'ada@example.com' }),
        }),
      ]);
    }
    expect(host.querySelector('[role=alert]')).toBeNull();
    expect(host.querySelector('input[type=email]')).toBeNull();
    expect(host.textContent).toContain('Six-digit code sent to ada@example.com');
    expect(host.querySelector('input[inputmode=numeric]')).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  }
});

it('says plainly when a code was requested in another browser, and sends a new one here', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.spyOn(api.auth, 'config').mockResolvedValue({
    email: { enabled: true, delivers: true },
    oidc: { enabled: false, name: 'SSO' },
  });
  const request = vi.spyOn(api.auth, 'requestCode').mockResolvedValue({} as never);
  vi.spyOn(api.auth, 'verifyCode').mockRejectedValue(
    new ApiError(
      401,
      'login_challenge_missing',
      'Enter the code in the same browser you requested it from. Request a new code here if you need to.',
    ),
  );
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const type = async (field: HTMLInputElement, value: string) =>
    act(async () => {
      setNativeValue(field, value);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <LoginRoute />
        </QueryClientProvider>,
      ),
    );
    await type(must(host.querySelector<HTMLInputElement>('input[type=email]')), 'ada@example.com');
    await act(async () => must(host.querySelector('form')).requestSubmit());
    expect(host.textContent).toContain('a code only works where it was requested');
    await type(must(host.querySelector<HTMLInputElement>('input[inputmode=numeric]')), '123456');
    await act(async () => must(host.querySelector('form')).requestSubmit());
    expect(must(host.querySelector('[role=alert]')).textContent).toContain('same browser');
    const again = must(
      Array.from(host.querySelectorAll('button')).find((b) =>
        b.textContent.includes('Send a new code to ada@example.com'),
      ),
    );
    await act(async () => again.click());
    expect(request).toHaveBeenCalledTimes(2);
    expect(host.querySelector('[role=alert]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  }
});

it('asks for a password when the instance has them, and offers a code instead', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.spyOn(api.auth, 'config').mockResolvedValue({
    email: { enabled: true, delivers: true },
    oidc: { enabled: false, name: 'SSO' },
    password: { enabled: true },
  });
  const signIn = vi
    .spyOn(api.auth, 'passwordLogin')
    .mockRejectedValue(new ApiError(401, 'unauthorized', 'Email or password is not right.'));
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <LoginRoute />
        </QueryClientProvider>,
      ),
    );
    const fill = async (selector: string, value: string) => {
      const field = must(host.querySelector<HTMLInputElement>(selector));
      await act(async () => {
        setNativeValue(field, value);
        field.dispatchEvent(new Event('input', { bubbles: true }));
      });
    };
    await fill('input[type=email]', 'ada@example.com');
    await fill('input[type=password]', 'a long enough password');
    await act(async () => must(host.querySelector<HTMLButtonElement>('form button')).click());
    expect(signIn).toHaveBeenCalledWith('ada@example.com', 'a long enough password', '/');
    expect(must(host.querySelector('[role=alert]')).textContent).toBe(
      'Email or password is not right.',
    );
    expect(host.textContent).toContain('Forgot password');
    const other = [...host.querySelectorAll('button')].find((b) =>
      b.textContent.includes('Email me a code instead'),
    );
    await act(async () => must(other).click());
    expect(host.querySelector('input[type=password]')).toBeNull();
    expect(host.textContent).toContain('Send me a code');
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  }
});
