import { and, eq, gt, inArray, or, sql } from 'drizzle-orm';
import type { NativePushInput, PushDeviceDto, PushSubscriptionInput } from '@onmyradar/contract';
import { getDb, schema, type Db } from '../db/client.js';
import { ApiError, badRequest, forbidden, tooManyRequests, type Actor } from '../http.js';
import { assertHumanDecision } from './access.js';
import { endpointHash } from './push.js';
import { apnsConfigured } from './apns.js';
import { must } from '../errors.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export async function requirePushSession(tx: Tx, actor: Actor, client: 'web' | 'ios') {
  assertHumanDecision(actor, 'Push devices must be registered by their signed-in user.');
  if (!actor.sessionId) throw forbidden('A signed-in device session is required.');
  const [user] = await tx
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, actor.user.id))
    .for('update');
  const [session] = await tx
    .select()
    .from(schema.sessions)
    .where(
      and(
        eq(schema.sessions.id, actor.sessionId),
        eq(schema.sessions.userId, actor.user.id),
        gt(schema.sessions.expiresAt, new Date()),
      ),
    )
    .for('share');
  if (!session || session.client !== client || user?.state !== 'active')
    throw forbidden('A live session for this device is required.');
  const charged = await tx.execute(
    sql`UPDATE sessions SET push_registration_count=CASE WHEN push_registration_window<now()-interval '1 hour' THEN 1 ELSE push_registration_count+1 END, push_registration_window=CASE WHEN push_registration_window<now()-interval '1 hour' THEN now() ELSE push_registration_window END WHERE id=${session.id}::uuid AND (push_registration_window<now()-interval '1 hour' OR push_registration_count<120) RETURNING id`,
  );
  if (!charged.rows.length)
    throw tooManyRequests('Too many device registrations. Try again later.', 3600);
  return session;
}
async function quota(tx: Tx, userId: string, newRow = true) {
  const result = await tx.execute<{ count: number }>(
    sql`SELECT ((SELECT count(*) FROM push_devices WHERE user_id=${userId}::uuid AND disabled_at IS NULL)+(SELECT count(*) FROM push_subscriptions WHERE user_id=${userId}::uuid AND disabled_at IS NULL))::int AS count`,
  );
  if (newRow) {
    const retained = await tx.execute<{ count: number }>(
      sql`SELECT ((SELECT count(*) FROM push_devices WHERE user_id=${userId}::uuid)+(SELECT count(*) FROM push_subscriptions WHERE user_id=${userId}::uuid))::int AS count`,
    );
    if ((retained.rows[0]?.count ?? 0) >= 100)
      throw badRequest('Too many retained devices. Sign out old sessions before adding another.');
  }
  if ((result.rows[0]?.count ?? 0) >= 20)
    throw badRequest('Remove an old push device before registering another (limit 20).');
}

export async function registerNativePush(
  actor: Actor,
  input: NativePushInput,
): Promise<{ id: string }> {
  assertHumanDecision(actor, 'Push devices must be registered by their signed-in user.');
  input = {
    ...input,
    token: input.token.toLowerCase(),
    installationId: input.installationId.toLowerCase(),
  };
  if (!apnsConfigured(input.environment))
    throw badRequest('APNs is not configured for this environment.');
  return getDb().transaction(async (tx) => {
    const session = await requirePushSession(tx, actor, 'ios');
    const hash = endpointHash(input.token);
    // Serialize both uniqueness axes, including token changes/account transfers.
    for (const key of [
      `apns:${input.environment}:${hash}`,
      `installation:${input.environment}:${input.installationId}`,
    ].sort())
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key},0))`);
    const existing = await tx
      .select()
      .from(schema.pushDevices)
      .where(
        and(
          eq(schema.pushDevices.environment, input.environment),
          or(
            eq(schema.pushDevices.tokenHash, hash),
            eq(schema.pushDevices.installationId, input.installationId),
          ),
        ),
      )
      .for('update');
    if (!input.activate && existing.some((d) => d.disabledAt || d.userId !== actor.user.id))
      throw new ApiError(
        409,
        'push_device_disabled',
        'Notifications were disconnected. Choose Enable to reconnect this device.',
      );
    const same = existing.find(
      (d) => d.userId === actor.user.id && d.installationId === input.installationId,
    );
    if (same) {
      if (same.disabledAt) await quota(tx, actor.user.id, false);
      const conflicts = existing.filter((d) => d.id !== same.id);
      if (conflicts.length)
        await tx.delete(schema.pushDevices).where(
          inArray(
            schema.pushDevices.id,
            conflicts.map((d) => d.id),
          ),
        );
      const changed = !!same.disabledAt || same.sessionId !== session.id || same.tokenHash !== hash;
      await tx
        .update(schema.pushDevices)
        .set({
          token: input.token,
          tokenHash: hash,
          sessionId: session.id,
          label: input.label ?? same.label,
          disabledAt: null,
          ...(changed ? { generation: same.generation + 1, registeredAt: new Date() } : {}),
        })
        .where(eq(schema.pushDevices.id, same.id));
      return { id: same.id };
    }
    if (existing.length)
      await tx.delete(schema.pushDevices).where(
        inArray(
          schema.pushDevices.id,
          existing.map((d) => d.id),
        ),
      );
    await quota(tx, actor.user.id);
    const [row] = await tx
      .insert(schema.pushDevices)
      .values({
        userId: actor.user.id,
        sessionId: session.id,
        platform: 'apns',
        environment: input.environment,
        token: input.token,
        tokenHash: hash,
        installationId: input.installationId,
        label: input.label ?? null,
      })
      .returning({ id: schema.pushDevices.id });
    return must(row, 'the push device it just saved');
  });
}

export async function registerBrowserPush(
  actor: Actor,
  input: PushSubscriptionInput,
): Promise<{ id: string }> {
  return getDb().transaction(async (tx) => {
    const session = await requirePushSession(tx, actor, 'web');
    const hash = endpointHash(input.endpoint);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`web:${hash}`},0))`);
    const [old] = await tx
      .select()
      .from(schema.pushSubscriptions)
      .where(eq(schema.pushSubscriptions.endpointHash, hash))
      .for('update');
    if (input.rebindExisting) {
      const [settings] = await tx
        .select()
        .from(schema.userNotificationSettings)
        .where(eq(schema.userNotificationSettings.userId, actor.user.id));
      if (old?.disabledAt)
        throw new ApiError(
          409,
          'push_device_disabled',
          'Notifications were disconnected. Choose Enable to reconnect this browser.',
        );
      if (!old || old.userId !== actor.user.id || settings?.pushEnabled === false)
        throw badRequest('Enable notifications explicitly for this account.');
    }
    if (!old || old.userId !== actor.user.id || old.disabledAt)
      await quota(tx, actor.user.id, !old || old.userId !== actor.user.id);
    const unchanged =
      old?.userId === actor.user.id &&
      old.sessionId === session.id &&
      old.p256dh === input.keys.p256dh &&
      old.auth === input.keys.auth;
    const values = {
      disabledAt: null,
      userId: actor.user.id,
      sessionId: session.id,
      endpoint: input.endpoint,
      endpointHash: hash,
      p256dh: input.keys.p256dh,
      auth: input.keys.auth,
      label: input.label ?? old?.label ?? null,
      failureCount: 0,
      generation: unchanged && !old.disabledAt ? old.generation : (old?.generation ?? 0) + 1,
      registeredAt: unchanged && !old.disabledAt ? old.registeredAt : new Date(),
    };
    const [row] = old
      ? await tx
          .update(schema.pushSubscriptions)
          .set(values)
          .where(eq(schema.pushSubscriptions.id, old.id))
          .returning({ id: schema.pushSubscriptions.id })
      : await tx
          .insert(schema.pushSubscriptions)
          .values(values)
          .returning({ id: schema.pushSubscriptions.id });
    return must(row, 'the push device it just saved');
  });
}

export async function removePushDevice(actor: Actor, id: string): Promise<void> {
  assertHumanDecision(actor, 'Only you may remove your push devices.');
  for (const table of [schema.pushDevices, schema.pushSubscriptions])
    await getDb()
      .update(table)
      .set({ disabledAt: new Date(), generation: sql`${table.generation}+1` })
      .where(and(eq(table.id, id), eq(table.userId, actor.user.id)));
}

export async function pushDeviceSettings(
  actor: Actor,
  mineHash?: string,
  deviceId?: string,
): Promise<{
  devices: PushDeviceDto[];
  browserBinding: 'active' | 'needs_reconnect' | 'not_registered';
}> {
  const db = getDb();
  const [web, native] = await Promise.all([
    db
      .select()
      .from(schema.pushSubscriptions)
      .where(eq(schema.pushSubscriptions.userId, actor.user.id)),
    db.select().from(schema.pushDevices).where(eq(schema.pushDevices.userId, actor.user.id)),
  ]);
  const mine = web.find((d) => d.endpointHash === mineHash || d.id === deviceId);
  return {
    browserBinding: !mine
      ? 'not_registered'
      : mine.sessionId === actor.sessionId && !mine.disabledAt
        ? 'active'
        : 'needs_reconnect',
    devices: [
      ...web.map((d) => ({
        id: d.id,
        label: d.label,
        createdAt: d.createdAt.toISOString(),
        lastUsedAt: d.lastUsedAt?.toISOString() ?? null,
        current:
          d.sessionId === actor.sessionId && (d.endpointHash === mineHash || d.id === deviceId),
        platform: 'web' as const,
        environment: null,
        requiresReconnect: d.sessionId === null,
        disabled: d.disabledAt !== null,
      })),
      ...native.map((d) => ({
        id: d.id,
        label: d.label,
        createdAt: d.createdAt.toISOString(),
        lastUsedAt: d.lastUsedAt?.toISOString() ?? null,
        current: d.sessionId === actor.sessionId && (!deviceId || d.id === deviceId),
        platform: d.platform,
        environment: d.environment,
        requiresReconnect: false,
        disabled: d.disabledAt !== null,
      })),
    ],
  };
}
