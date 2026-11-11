import { useCallback, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, Laptop, Smartphone, Trash2 } from 'lucide-react';
import {
  DEFAULT_RADAR_NOTIFY_LEVEL,
  NOTIFICATION_KINDS,
  RADAR_NOTIFY_LEVELS,
  RADAR_NOTIFY_LEVEL_LABELS,
  type NotificationKind,
  type RadarNotifyLevel,
} from '@onmyradar/contract';
import { ApiError, api } from '../lib/api';
import { accentStyle } from '../lib/theme';
import { fullTime } from '../lib/format';
import { queryKeys } from '../lib/session';
import {
  describeThisBrowser,
  readPushState,
  subscribeToPush,
  unsubscribeFromPush,
  type PushState,
} from '../lib/push';
import { RadarGlyph, notify } from './primitives';
import { Select } from './select';
import { QueryError } from './query-error';

const EVENT_LABELS: Record<NotificationKind, string> = {
  subscription_failed: 'Outbound delivery failures',
  comment: 'Comments in your conversations',
  mention: 'Mentions',
  reaction: 'Reactions to your blips',
  share: 'Radar invitations',
  blip: 'New blips',
  topic_share: 'Array invitations',
  topic_cascade: 'Array access changes',
  email_received: 'Incoming email',
  due: 'Personal due reminders',
  reply_pending: 'Client replies waiting for your review',
  charter_orphaned: 'Amendments of yours that lost their words',
  decision: 'Questions waiting on your decision',
  decision_answered: 'Answers to questions you asked',
};
/** This browser's push state, then the settings that depend on it. */
function useNotificationSettingsQuery() {
  const pushQuery = useQuery({
    queryKey: queryKeys.pushState,
    queryFn: readPushState,
    staleTime: Infinity,
  });
  const push: PushState | null = pushQuery.data ?? null;
  const settingsQuery = useQuery({
    queryKey: [...queryKeys.notificationSettings, push?.endpoint ?? null],
    queryFn: () => api.notifications.settings(push?.endpoint ?? undefined),
    enabled: push !== null,
  });
  return { push, settingsQuery };
}

export function NotificationSettings() {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const { push, settingsQuery } = useNotificationSettingsQuery();
  const settings = settingsQuery.data;
  const refresh = useCallback(async () => {
    await client.invalidateQueries({ queryKey: queryKeys.pushState });
    await client.invalidateQueries({ queryKey: queryKeys.notificationSettings });
  }, [client]);
  const setSwitch = async (input: Parameters<typeof api.notifications.updateSettings>[0]) => {
    setBusy(true);
    try {
      await api.notifications.updateSettings(input);
      await refresh();
    } catch (err) {
      notify(
        err instanceof ApiError ? err.message : 'Could not save notification preferences',
        'error',
      );
    } finally {
      setBusy(false);
    }
  };
  const enablePush = async () => {
    if (!settings?.vapidPublicKey) return;
    setBusy(true);
    try {
      const subscription = await subscribeToPush(settings.vapidPublicKey);
      await api.notifications.subscribePush(subscription, describeThisBrowser());
      await refresh();
      notify('This browser is connected');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Could not connect this browser', 'error');
      await refresh();
    } finally {
      setBusy(false);
    }
  };
  const remove = async (id?: string) => {
    setBusy(true);
    try {
      if (id) await api.notifications.removeDevice(id);
      else if (push?.endpoint) {
        await api.notifications.unsubscribePush(push.endpoint);
        await unsubscribeFromPush();
      }
      await refresh();
      notify('Device disconnected');
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not disconnect this device', 'error');
    } finally {
      setBusy(false);
    }
  };
  if (settingsQuery.error)
    return (
      <QueryError
        error={settingsQuery.error}
        resource="Notification settings"
        retry={() => settingsQuery.refetch()}
      />
    );
  if (!settings)
    return (
      <p className="note" role="status">
        Loading notification settings…
      </p>
    );
  const active = push?.permission === 'granted' && settings.browserBinding === 'active';
  const changed = settings.radars.filter(
    (radar) => radar.level !== DEFAULT_RADAR_NOTIFY_LEVEL,
  ).length;
  return (
    <section className="flex flex-col gap-3">
      <h2 className="instrument">Notifications</h2>
      <div className="panel flex flex-col gap-5 p-4">
        <div>
          <h3 className="font-semibold">Delivery</h3>
          <p className="note mt-1">
            Choose how you hear about activity. Your in-app activity remains available.
          </p>
        </div>
        {(['email', 'push'] as const).map((channel) => (
          <label className="notify-switch" key={channel}>
            <span className="min-w-0 flex-1">
              <span className="notify-switch-title">
                {channel === 'email' ? 'Email notifications' : 'Push notifications'}
              </span>
              <span className="notify-switch-hint">
                {channel === 'email'
                  ? 'Send notifications to your account email.'
                  : 'Allow notifications on your connected browsers and phones.'}
              </span>
            </span>
            <input
              type="checkbox"
              className="notify-checkbox"
              disabled={busy}
              checked={channel === 'email' ? settings.emailEnabled : settings.pushEnabled}
              onChange={(e) =>
                void setSwitch(
                  channel === 'email'
                    ? { emailEnabled: e.target.checked }
                    : { pushEnabled: e.target.checked },
                )
              }
            />
          </label>
        ))}
        <label className="notify-switch">
          <span className="min-w-0 flex-1">
            <span className="notify-switch-title">Show message previews</span>
            <span className="notify-switch-hint">
              Include message text in notifications, including on your lock screen. Turn off for
              generic activity alerts.
            </span>
          </span>
          <input
            className="notify-checkbox"
            type="checkbox"
            checked={settings.previewEnabled ?? true}
            disabled={busy}
            onChange={(e) => void setSwitch({ previewEnabled: e.target.checked })}
          />
        </label>
        <section className="notification-browser">
          <h3 className="font-semibold">This browser</h3>
          <p className="note mt-1" role="status">
            {!push?.supported
              ? 'Notifications are not supported in this browser.'
              : push.permission === 'denied'
                ? 'Blocked by your browser. Allow notifications for this site in browser settings to connect.'
                : !settings.pushAvailable
                  ? 'Browser notifications are currently unavailable.'
                  : active
                    ? settings.pushEnabled
                      ? 'Connected and ready for notifications.'
                      : 'Connected. Push notifications are paused by your delivery preference.'
                    : settings.browserBinding === 'needs_reconnect'
                      ? 'Reconnect this browser after signing in again.'
                      : 'Connect this browser to receive notifications here.'}
          </p>
          {active ? (
            <button className="btn mt-3" disabled={busy} onClick={() => void remove()}>
              Disconnect this browser
            </button>
          ) : push?.supported && push.permission !== 'denied' && settings.pushAvailable ? (
            <button
              className="btn btn-accent mt-3"
              disabled={busy || !settings.pushEnabled}
              onClick={() => void enablePush()}
            >
              <Bell size={16} />
              {settings.browserBinding === 'needs_reconnect'
                ? 'Reconnect this browser'
                : 'Enable in this browser'}
            </button>
          ) : null}
        </section>
        {settings.kindPreferences ? (
          <section>
            <h3 className="font-semibold">Activity to notify you about</h3>
            <p className="note mt-1">
              Channel choices are remembered while a delivery switch is off. Muted radars stay
              quiet.
            </p>
            <div className="notification-events">
              {NOTIFICATION_KINDS.map((kind) => {
                const pref = settings.kindPreferences?.[kind];
                return (
                  <div className="notification-event" key={kind}>
                    <span>{EVENT_LABELS[kind]}</span>
                    <div>
                      {(['email', 'push'] as const).map((channel) => (
                        <label key={channel}>
                          <input
                            type="checkbox"
                            checked={pref?.[channel] ?? false}
                            disabled={busy}
                            onChange={(e) =>
                              void setSwitch({
                                kindPreferences: { [kind]: { [channel]: e.target.checked } },
                              })
                            }
                            aria-label={`${EVENT_LABELS[kind]} by ${channel}`}
                          />
                          {channel === 'email' ? 'Email' : 'Push'}
                        </label>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        ) : null}
        {settings.devices.length ? (
          <section>
            <h3 className="font-semibold">Devices</h3>
            <ul className="flex flex-col divide-y divide-[color:var(--line-soft)]">
              {settings.devices.map((device) => (
                <li key={device.id} className="flex items-center gap-3 py-3">
                  {device.platform === 'apns' || device.platform === 'fcm' ? (
                    <Smartphone size={18} />
                  ) : (
                    <Laptop size={18} />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block break-words">
                      {device.label || (device.platform === 'apns' ? 'iPhone or iPad' : 'Browser')}
                      {device.current ? ' · Current session' : ''}
                    </span>
                    <span className="note">
                      {device.disabled
                        ? 'Disconnected'
                        : device.requiresReconnect
                          ? 'Reconnect needed'
                          : device.lastUsedAt
                            ? `Last delivery accepted ${fullTime(device.lastUsedAt)}`
                            : 'No delivery yet'}
                    </span>
                  </span>
                  <button
                    className="btn btn-ghost"
                    disabled={busy || device.disabled}
                    aria-label={`Disconnect ${device.label || 'device'}`}
                    onClick={() => void remove(device.id)}
                  >
                    <Trash2 size={16} />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {/* ------------------------------- radars -------------------------- */}
        {/* Folded: one row per radar grows with every radar, and most people
            never change one. The summary says how many differ from the default. */}
        <details className="notification-radars" data-omr="per-radar-notifications">
          <summary className="flex min-h-11 cursor-pointer items-center gap-2">
            <span className="font-semibold">Per-radar settings</span>
            <span className="note">
              {changed === 0
                ? `${settings.radars.length} ${settings.radars.length === 1 ? 'radar' : 'radars'} · all ${RADAR_NOTIFY_LEVEL_LABELS[DEFAULT_RADAR_NOTIFY_LEVEL].label.toLowerCase()}`
                : `${changed} of ${settings.radars.length} changed`}
            </span>
          </summary>
          <p className="mt-1 text-[12.5px] text-[color:var(--paper-dim)]">
            {RADAR_NOTIFY_LEVEL_LABELS[DEFAULT_RADAR_NOTIFY_LEVEL].label} unless you change it:{' '}
            {RADAR_NOTIFY_LEVEL_LABELS[DEFAULT_RADAR_NOTIFY_LEVEL].hint.toLowerCase()}. Your own
            setting — turning a shared radar down does not quieten it for anybody else.
          </p>
          <ul className="flex flex-col divide-y divide-[color:var(--line-soft)]">
            {settings.radars.map((radar) => (
              <li
                key={radar.id}
                className="flex items-center gap-2.5 py-2"
                style={accentStyle(radar.accent)}
              >
                <span className="shrink-0 text-[color:var(--accent-from)]">
                  <RadarGlyph glyph={radar.glyph} />
                </span>
                <span className="min-w-0 flex-1 truncate text-[13.5px]">{radar.name}</span>
                <Select
                  className="field w-auto py-1 text-[13px]"
                  value={radar.level}
                  aria-label={`Notifications for ${radar.name}`}
                  onValueChange={(value) =>
                    void (async () => {
                      const level = value as RadarNotifyLevel;
                      try {
                        await api.radars.setNotifyLevel(radar.id, level);
                        await client.invalidateQueries({
                          queryKey: queryKeys.notificationSettings,
                        });
                      } catch (err) {
                        notify(
                          err instanceof ApiError ? err.message : 'Could not save that',
                          'error',
                        );
                      }
                    })()
                  }
                  options={RADAR_NOTIFY_LEVELS.map((level) => ({
                    value: level,
                    label: RADAR_NOTIFY_LEVEL_LABELS[level].label,
                  }))}
                />
              </li>
            ))}
          </ul>
        </details>
      </div>
    </section>
  );
}
