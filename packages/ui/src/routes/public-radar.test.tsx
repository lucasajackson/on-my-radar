// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_RADAR_THEME, templateFor, type RadarDto } from '@onmyradar/contract';
import { api } from '../lib/api';
import { paneFor } from '../templates';
import { PublicRadarRoute } from './public-radar';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
  useParams: () => ({ slug: 'open-board' }),
  useRouter: () => undefined,
}));

const roots: Root[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

async function page(template: string) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  // The board measures itself; jsdom has no ResizeObserver.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  const radar = {
    id: 'r1',
    name: 'Open board',
    template,
    tagline: null,
    accent: null,
    glyph: null,
    owner: null,
    commentsEnabled: false,
    reactionsEnabled: false,
    theme: DEFAULT_RADAR_THEME,
    templateConfig: {},
  } as unknown as RadarDto;
  vi.spyOn(api.publicRadars, 'get').mockImplementation(() => Promise.resolve({ radar }));
  vi.spyOn(api.publicRadars, 'blips').mockResolvedValue({ items: [], nextCursor: null });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <PublicRadarRoute />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(host.querySelector('footer')).not.toBeNull());
  return host;
}

// Every template, not just the board: the public page gives a layout the width it gets signed in.
for (const template of ['kanban', 'stream', 'microblog', 'decision-log']) {
  it(`draws a public ${template} radar at the measure its layout declares, not 760px`, async () => {
    const { measure } = paneFor(templateFor(template).layout);
    const host = await page(template);
    const header = host.querySelector('header > div');
    const body = host.querySelector('header + div');
    const footer = host.querySelector('footer');
    for (const node of [header, body, footer]) {
      expect(node?.className).toContain(measure);
      expect(node?.className).not.toContain('760');
    }
    expect(host.querySelector('.public-radar')).not.toBeNull();
  });
}
