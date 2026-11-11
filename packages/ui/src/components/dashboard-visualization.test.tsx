// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { DashboardQueryResultDto } from '@onmyradar/contract';
import { WidgetVisualization } from './dashboard-visualization';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));

it('draws lanes as one definition list per radar, holding only term/description pairs', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const data = {
    total: 7,
    laneGroups: [
      { radarId: 'r1', name: 'Work', status: 'todo', label: 'To do', total: 3 },
      { radarId: 'r1', name: 'Work', status: null, label: 'Unfiled', total: 1 },
      { radarId: 'r2', name: 'Home', status: 'todo', label: 'To do', total: 3 },
    ],
  } as unknown as DashboardQueryResultDto;
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(async () => root.render(<WidgetVisualization data={data} display="lanes" />));

  const lists = host.querySelectorAll('dl');
  expect(lists).toHaveLength(2);
  for (const list of lists) {
    // A heading beside the list, not inside it.
    expect(list.previousElementSibling?.tagName).toBe('H3');
    for (const row of list.children) {
      expect(row.tagName).toBe('DIV');
      expect(Array.from(row.children).map((child) => child.tagName)).toEqual(['DT', 'DD']);
    }
  }
  expect(Array.from(host.querySelectorAll('h3')).map((h) => h.textContent)).toEqual([
    'Work',
    'Home',
  ]);
  await act(async () => root.unmount());
});
