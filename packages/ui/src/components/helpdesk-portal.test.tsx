// @vitest-environment jsdom
/**
 * Helpdesk slice 3 in the dashboard: a portal request names its requester (not
 * the owner it is authorized as), shows the ball-in-court clock, and a client's
 * reply is labelled as a client's; the integration panels say what they do
 * before the click and offer the safe direction only where it applies.
 */
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import type { BlipDto, IntegrationDto, RadarDto } from '@onmyradar/contract';
import { api } from '../lib/api';
import { BlipCard } from './blips';
import { HelpdeskPortalPanel, IntegrationsSection } from './integrations';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
  useRouter: () => undefined,
}));

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

const request = {
  id: 'b1',
  radarId: 'r1',
  kind: 'note',
  title: 'Fix the contact form',
  body: 'It does nothing',
  url: null,
  state: 'active',
  status: 'waiting-on-client',
  pinned: false,
  tags: [],
  attachments: [],
  commentCount: 1,
  reactions: [],
  author: { id: 'u1', name: 'Lucas Owner', email: 'lucas@example.test' },
  agent: null,
  voice: null,
  mentions: [],
  dueAt: null,
  reminder: null,
  archivedAt: null,
  external: { via: 'portal', requesterName: 'Pat <b>Client</b>' },
  awaitingClientSince: new Date(Date.now() - 3 * 86_400_000).toISOString(),
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
} as unknown as BlipDto;

async function mount(node: ReactNode) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>),
  );
  return host;
}

it('leads a portal request with its requester, as text, and shows how long it has waited', async () => {
  vi.spyOn(api.blips, 'comments').mockResolvedValue({ items: [], nextCursor: null });
  const host = await mount(
    <BlipCard
      blip={request}
      readOnly={false}
      onChanged={vi.fn()}
      conversation={false}
      commentsEnabled
      reactionsEnabled={false}
    />,
  );
  const facet = host.querySelector('[data-facet="requester"]');
  expect(facet?.textContent).toBe('from Pat <b>Client</b> · via portal');
  // Untrusted text stays text: no element was made of it.
  expect(facet?.querySelector('b')).toBeNull();
  // The owner it is authorized as is not who asked.
  expect(host.textContent).not.toContain('Lucas Owner');
  expect(host.querySelector('[data-facet="awaiting-client"]')?.textContent).toBe(
    'waiting on client · 3d',
  );
});

const portal = (over: Partial<IntegrationDto> = {}): IntegrationDto => ({
  id: 'i1',
  purpose: 'helpdesk',
  name: 'W&W portal',
  staffDisplayName: 'Acme Support',
  agentReplyPolicy: 'review',
  tokenPrefix: 'omr_int_abc123',
  tokenLastUsedAt: null,
  previous: null,
  expiresAt: '2026-12-31T00:00:00Z',
  rotatedAt: null,
  createdAt: '2026-10-02T00:00:00Z',
  revokedAt: null,
  enrolments: [],
  delivery: null,
  ...over,
});

it('says what an integration is for in its zero state, so the section is discoverable', async () => {
  vi.spyOn(api.integrations, 'list').mockResolvedValue({ integrations: [] });
  const host = await mount(<IntegrationsSection />);
  await vi.waitFor(() => expect(host.textContent).toContain('No portal connected'));
  expect(host.textContent).toContain('never sees internal notes');
  expect(host.textContent).toContain('Connect a portal');
});

it('shows the previous token and its last use while a rotation overlaps', async () => {
  vi.spyOn(api.integrations, 'list').mockResolvedValue({
    integrations: [
      portal({
        previous: { expiresAt: '2026-10-03T02:00:00Z', lastUsedAt: null },
        enrolments: [
          {
            id: 'e1',
            radarId: 'r1',
            radarName: 'Helpdesk · Acme',
            externalRef: 'site-7',
            enrolledAt: '2026-10-02T00:00:00Z',
          },
        ],
      }),
    ],
  });
  const host = await mount(<IntegrationsSection />);
  await vi.waitFor(() => expect(host.textContent).toContain('previous token works until'));
  expect(host.textContent).toContain('not used since the rotation');
  expect(host.textContent).toContain('Stop previous token now');
  expect(host.textContent).toContain('Helpdesk · Acme');
  expect(host.textContent).toContain('website site-7');
});

it('offers Connect on an unconnected Helpdesk and Disconnect on a connected one', async () => {
  const radar = { id: 'r1', name: 'Helpdesk · Acme', template: 'helpdesk' } as RadarDto;
  vi.spyOn(api.integrations, 'list').mockResolvedValue({
    integrations: [
      portal(),
      portal({
        id: 'i2',
        name: 'Second portal',
        enrolments: [
          {
            id: 'e1',
            radarId: 'r1',
            radarName: 'Helpdesk · Acme',
            externalRef: null,
            enrolledAt: '2026-10-02T00:00:00Z',
          },
        ],
      }),
      portal({ id: 'i3', name: 'Revoked portal', revokedAt: '2026-10-01T00:00:00Z' }),
    ],
  });
  const enrol = vi.spyOn(api.integrations, 'enrol').mockResolvedValue({ integration: portal() });
  const host = await mount(<HelpdeskPortalPanel radar={radar} />);
  await vi.waitFor(() => expect(host.textContent).toContain('Second portal'));
  expect(host.textContent).not.toContain('Revoked portal');
  expect(host.textContent).toContain('never internal notes');
  const buttons = [...host.querySelectorAll('button')].map((b) => b.textContent);
  expect(buttons).toEqual(['Connect', 'Disconnect']);
  const connect = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Connect');
  await act(async () => connect?.click());
  expect(enrol).toHaveBeenCalledWith('i1', { radarId: 'r1' });
});

it('says the portal pulls events until a receiver is added', async () => {
  vi.spyOn(api.integrations, 'list').mockResolvedValue({ integrations: [portal()] });
  const host = await mount(<IntegrationsSection />);
  await vi.waitFor(() => expect(host.querySelector('[data-delivery="pull"]')).not.toBeNull());
  expect(host.textContent).toContain('The portal pulls events');
  expect(host.textContent).toContain('Add receiver');
});

it('shows a paused delivery as buffered, not failed, and resumes it', async () => {
  const paused = portal({
    delivery: {
      url: 'https://portal.example/omr',
      pausedAt: '2026-10-02T10:00:00Z',
      lastError: 'Receiver returned HTTP 503',
      pending: 2,
    },
  });
  vi.spyOn(api.integrations, 'list').mockResolvedValue({ integrations: [paused] });
  const resume = vi
    .spyOn(api.integrations, 'resumeDelivery')
    .mockResolvedValue({ integration: portal() });
  const host = await mount(<IntegrationsSection />);
  await vi.waitFor(() => expect(host.querySelector('[data-delivery="push"]')).not.toBeNull());
  const state = host.querySelector('[data-delivery-state]');
  expect(state?.getAttribute('data-delivery-state')).toBe('paused');
  expect(state?.textContent).toContain('2 waiting');
  expect(state?.textContent).toContain('HTTP 503');
  expect(host.textContent).toContain('pushed to https://portal.example/omr');
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Resume');
  await act(async () => button?.click());
  expect(resume).toHaveBeenCalledWith('i1');
});
