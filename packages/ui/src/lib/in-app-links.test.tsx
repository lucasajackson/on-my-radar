// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { expect, it } from 'vitest';
import { ReadingBody } from '../components/reading-body';
import { renderMarkdown } from './markdown';

it('follows a #tag in a blip body with the router, and leaves outside links to the browser', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const body = 'Filed under #garden, via https://example.test/article';
  const rootRoute = createRootRoute({
    component: () => <ReadingBody body={body} html={renderMarkdown(body)} collapsible={false} />,
  });
  const tagRoute = createRoute({ getParentRoute: () => rootRoute, path: '/t/$tag' });
  const router = createRouter({
    routeTree: rootRoute.addChildren([tagRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<RouterProvider router={router} />));

  const tag = host.querySelector<HTMLAnchorElement>('a.tag-link');
  const tagClick = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
  await act(async () => tag?.dispatchEvent(tagClick));
  expect(tagClick.defaultPrevented).toBe(true);
  expect(router.history.location.pathname).toBe('/t/garden');

  const outside = host.querySelector<HTMLAnchorElement>('a[target="_blank"]');
  const outsideClick = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
  outside?.dispatchEvent(outsideClick);
  expect(outsideClick.defaultPrevented).toBe(false);

  // A new-tab click on the tag is the browser's, too.
  const newTab = new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true });
  tag?.dispatchEvent(newTab);
  expect(newTab.defaultPrevented).toBe(false);

  await act(async () => root.unmount());
  host.remove();
});
