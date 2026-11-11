// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, it, vi } from 'vitest';
import type { RadarDto } from '@onmyradar/contract';
import { must, setNativeValue } from '../lib/must';
import { AppShell } from './shell';

const { radars } = vi.hoisted(() => ({ radars: [] as RadarDto[] }));
vi.mock('../lib/session', async (original) => ({
  ...(await original<object>()),
  useSession: () => ({ user: { id: 'owner', state: 'active' } }),
  useRadars: () => ({ data: { radars }, isPending: false }),
  useTopics: () => ({ data: { topics: [] }, isPending: false }),
  useDropBox: () => ({ data: null }),
  useSignOut: () => vi.fn(),
}));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useRouter: () => ({ navigate: vi.fn() }),
  useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
    select({ location: { pathname: '/', state: { __TSR_index: 0 } } }),
  Link: ({
    to,
    params,
    children,
  }: {
    to: string;
    params?: Record<string, string>;
    children: ReactNode;
  }) => (
    <a
      href={to
        .replace('$radarId', params?.['radarId'] ?? '')
        .replace('$topicId', params?.['topicId'] ?? '')}
    >
      {children}
    </a>
  ),
}));
vi.mock('../lib/use-push-binding', () => ({ usePushBinding: () => undefined }));
vi.mock('../lib/focus', () => ({ focusWhenPresent: () => undefined }));
vi.mock('../lib/navstack', () => ({
  useNavStack: () => ({ canPop: false, direction: 'none', nonce: 0 }),
  upFor: () => null,
}));
vi.mock('./notifications', () => ({ useNotificationCounts: () => ({ data: null }) }));
vi.mock('./universal-search', () => ({ UniversalSearch: () => null }));

it('keeps every authorized radar reachable across topic, ungrouped and smart sections beyond twenty', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  radars.splice(
    0,
    radars.length,
    ...Array.from(
      { length: 19 },
      (_, index) =>
        ({
          id: `early-${index}`,
          name: `Earlier ${index}`,
          kind: 'standard',
          isDropBox: false,
          topic: null,
          blipCount: 0,
          accent: 'mint',
        }) as unknown as RadarDto,
    ),
  );
  const topic = { id: 'roving', name: 'Roving Studio', accent: 'amber', cascade: false };
  const names = ['Commander Dev', 'CMS Dev', 'Designer Dev', 'Roving Express', 'Roving Guide'];
  radars.push(
    ...names.map(
      (name, index) =>
        ({
          id: `roving-${index}`,
          name,
          kind: 'standard',
          isDropBox: false,
          topicId: topic.id,
          topic,
          blipCount: 0,
          accent: 'amber',
        }) as unknown as RadarDto,
    ),
  );
  radars.push({
    id: 'smart',
    name: 'Late smart radar',
    kind: 'smart',
    isDropBox: false,
    topic: null,
    blipCount: 0,
    accent: 'mint',
  } as unknown as RadarDto);
  const client = new QueryClient();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <AppShell>Content</AppShell>
        </QueryClientProvider>,
      ),
    );
    const sidebar = must(host.querySelector('[aria-label="Sidebar navigation"]'));
    expect(sidebar.querySelectorAll('a[href^="/radar/"]')).toHaveLength(25);
    for (const name of names) expect(sidebar.textContent).toContain(name);
    expect(sidebar.textContent).toContain('Late smart radar');
    const filter = must(sidebar.querySelector<HTMLInputElement>('input[type="search"]'));
    await act(async () => {
      setNativeValue(filter, 'Roving Studio');
      filter.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(sidebar.querySelectorAll('a[href^="/radar/"]')).toHaveLength(5);
    for (const name of names) expect(sidebar.textContent).toContain(name);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    host.remove();
    radars.length = 0;
  }
});
