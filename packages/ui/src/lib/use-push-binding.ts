import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import { queryKeys } from './session';
import { existingPushSubscription, describeThisBrowser } from './push';

/** Server checks existing ownership; automatic reconnect cannot enroll or transfer a device. */
export function usePushBinding(userId: string | undefined) {
  const client = useQueryClient();
  useEffect(() => {
    if (!userId) return;
    // Asked through a function after each await, not read from a `let` the
    // cleanup flips: the checker cannot see a flag mutated from another closure
    // and reads it as forever false, which makes the guard look like dead code.
    const lifetime = new AbortController();
    const stillWanted = () => !lifetime.signal.aborted;
    void (async () => {
      const subscription = await existingPushSubscription();
      if (!subscription || !stillWanted()) return;
      const settings = await api.notifications.settings(subscription.endpoint);
      if (!stillWanted() || !settings.pushEnabled || settings.browserBinding !== 'needs_reconnect')
        return;
      await api.notifications.subscribePush(subscription, describeThisBrowser(), true);
      if (stillWanted())
        await client.invalidateQueries({ queryKey: queryKeys.notificationSettings });
    })().catch(() => {
      /* Settings offers an explicit retry; never prompt during navigation. */
    });
    return () => {
      lifetime.abort();
    };
  }, [userId, client]);
}
