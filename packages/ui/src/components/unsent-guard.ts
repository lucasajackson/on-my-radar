/**
 * Asks before leaving with text that would be lost.
 *
 * Rendered by a composer only while it holds text its draft store cannot keep
 * past a navigation — so it never interrupts anybody whose draft is safe, and
 * a composer with nothing unsent never touches the router at all. In-app
 * navigation asks in the app's own confirmation; closing the tab asks through
 * the browser, the only thing that can.
 */
import { createElement } from 'react';
import { useBlocker } from '@tanstack/react-router';
import { ConfirmDialog } from './primitives';

export function UnsentGuard() {
  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) => next.pathname !== current.pathname,
    enableBeforeUnload: true,
    withResolver: true,
  });
  if (blocker.status !== 'blocked') return null;
  return createElement(ConfirmDialog, {
    title: 'Leave without sending?',
    body: 'This browser is not keeping drafts, so the text you have not sent will be lost.',
    confirmLabel: 'Leave it',
    danger: true,
    onClose: () => blocker.reset(),
    onConfirm: () => blocker.proceed(),
  });
}
