import { NOTIFICATION_KINDS, type NotificationKind } from '@onmyradar/contract';
import { and, eq } from 'drizzle-orm';
import { getDb, schema } from '../db/client.js';

export function notificationPreferences(
  stored: Partial<
    Record<NotificationKind, { email?: boolean | undefined; push?: boolean | undefined }>
  > = {},
): Record<NotificationKind, { email: boolean; push: boolean }> {
  return Object.fromEntries(
    NOTIFICATION_KINDS.map((kind) => [
      kind,
      {
        email: stored[kind]?.email ?? !['due', 'email_received'].includes(kind),
        push: stored[kind]?.push ?? true,
      },
    ]),
  ) as Record<NotificationKind, { email: boolean; push: boolean }>;
}
export async function notificationAllowed(
  userId: string,
  kind: NotificationKind,
  radarId: string | null,
  channel: 'push' | 'email',
): Promise<{ allowed: boolean; preview: boolean }> {
  const [settings] = await getDb()
    .select()
    .from(schema.userNotificationSettings)
    .where(eq(schema.userNotificationSettings.userId, userId));
  let allowed = (channel === 'push' ? settings?.pushEnabled : settings?.emailEnabled) ?? true;
  // Keyed by string on purpose: a notification row written by a newer build can
  // carry a kind this one does not know, and that must read as 'not allowed'.
  const preferences: Partial<Record<string, { email: boolean; push: boolean }>> =
    notificationPreferences(settings?.kindPreferences);
  allowed &&= preferences[kind]?.[channel] ?? false;
  if (allowed && radarId && !['share', 'topic_share', 'topic_cascade'].includes(kind)) {
    const [pref] = await getDb()
      .select()
      .from(schema.radarNotificationPrefs)
      .where(
        and(
          eq(schema.radarNotificationPrefs.userId, userId),
          eq(schema.radarNotificationPrefs.radarId, radarId),
        ),
      );
    if (pref?.level === 'none') allowed = false;
  }
  return { allowed, preview: settings?.previewEnabled ?? true };
}
