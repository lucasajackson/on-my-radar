/**
 * Same-origin links inside rendered HTML, followed by the router.
 *
 * A blip body is HTML from the markdown renderer, so its `#tag` links are plain
 * anchors the router never sees. Following one was a full page load: the query
 * cache, the session read and the whole shell rebuilt for what should be a
 * change of screen. This intercepts exactly the clicks a browser would have
 * treated as "navigate this tab" and leaves everything else alone — new-tab
 * modifiers, middle clicks, `target`, downloads and other origins.
 */
import type { MouseEvent } from 'react';
import { useRouter, type RegisteredRouter } from '@tanstack/react-router';

/**
 * The router, or undefined outside a RouterProvider. `useRouter({ warn: false })`
 * returns undefined there at runtime, but its type says it never does — a return
 * type is the honest place to say otherwise.
 */
function useOptionalRouter(): RegisteredRouter | undefined {
  return useRouter({ warn: false });
}

export function useInAppLinkClick(): (event: MouseEvent<HTMLElement>) => void {
  // Undefined outside a RouterProvider (a component test), where the browser's
  // own navigation is the right fallback. The hook's type does not admit that.
  const router = useOptionalRouter();
  return (event) => {
    if (!router || event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const target = event.target;
    const anchor = target instanceof Element ? target.closest('a') : null;
    if (!anchor || !event.currentTarget.contains(anchor)) return;
    if (anchor.target || anchor.hasAttribute('download')) return;
    const url = new URL(anchor.href, window.location.href);
    if (url.origin !== window.location.origin) return;
    event.preventDefault();
    void router.navigate({ href: `${url.pathname}${url.search}${url.hash}` });
  };
}
