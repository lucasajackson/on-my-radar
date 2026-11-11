/**
 * Webhook payload mapping.
 *
 * `mapPayload` is pure so the interesting half of the ingress — what an
 * arbitrary third party's JSON turns into — can be pinned without a database or
 * a network. Everything it does not do (authorization, rate limiting) is
 * deliberately elsewhere and is not what these test.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderPayloadTemplate, humanizeFieldName, WEBHOOK } from '@onmyradar/contract';
import { mapPayload, type InboundDelivery } from './webhooks.js';
import type { Actor } from '../http.js';
import type { schema } from '../db/client.js';

type WebhookRow = typeof schema.radarWebhooks.$inferSelect;

function webhook(patch: Partial<WebhookRow> = {}): WebhookRow {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    radarId: '00000000-0000-0000-0000-000000000002',
    createdBy: '00000000-0000-0000-0000-000000000003',
    name: 'Test hook',
    tokenHash: 'x',
    tokenPrefix: 'omr_hook_abc',
    enabled: true,
    format: 'auto',
    bodyTemplate: null,
    titleTemplate: null,
    tags: [],
    state: 'inbox',
    windowStartedAt: new Date(),
    windowCount: 0,
    deliveryCount: 0,
    lastDeliveryAt: null,
    lastErrorAt: null,
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...patch,
  };
}

function json(payload: unknown): InboundDelivery {
  return { payload, shape: 'json', raw: JSON.stringify(payload) };
}

describe('auto mapping', () => {
  it('uses an obvious message field verbatim', () => {
    const mapped = mapPayload(webhook(), json({ message: 'Build 412 went green' }));
    expect(mapped.body).toBe('Build 412 went green');
  });

  it('renders every field as a labelled line when there is no single message', () => {
    // This is the case a form-submission webhook actually hits: there is no
    // "body", there are eight fields and all of them matter.
    const mapped = mapPayload(
      webhook(),
      json({ customer_name: 'Ada Lovelace', customerEmail: 'ada@example.com', budget: 4200 }),
    );
    expect(mapped.body).toContain('**Customer name:** Ada Lovelace');
    expect(mapped.body).toContain('**Customer email:** ada@example.com');
    expect(mapped.body).toContain('**Budget:** 4200');
  });

  it('leaves out fields with nothing in them', () => {
    const mapped = mapPayload(
      webhook(),
      json({ company: 'Acme', note: '', phone: null, attachments: [] }),
    );
    expect(mapped.body).toBe('**Company:** Acme');
  });

  it('does not print a field twice once it has been lifted into the metadata', () => {
    // `name` becomes the title, so a "**Name:** Grace Hopper" line underneath it
    // says the same thing again — the same mistake title derivation made before
    // it was restricted to real markdown headings.
    const mapped = mapPayload(
      webhook(),
      json({ name: 'Grace Hopper', phone: '555-0100', url: 'https://example.com/x' }),
    );
    expect(mapped.title).toBe('Grace Hopper');
    expect(mapped.url).toBe('https://example.com/x');
    expect(mapped.body).toBe('**Phone:** 555-0100');
    expect(mapped.body).not.toContain('Grace Hopper');
    expect(mapped.body).not.toContain('example.com');
  });

  it('picks up a title, a link and tags when the payload offers them', () => {
    const mapped = mapPayload(
      webhook(),
      json({
        subject: 'New enquiry',
        body: 'Wants a website',
        url: 'https://example.com/submissions/7',
        tags: ['Roving Studio', 'lead'],
      }),
    );
    expect(mapped.title).toBe('New enquiry');
    expect(mapped.url).toBe('https://example.com/submissions/7');
    expect(mapped.tags).toEqual(['roving-studio', 'lead']);
  });

  it('refuses a link that is not http(s)', () => {
    // The URL reaches an anchor's href in the SPA, so nothing else may pass.
    expect(mapPayload(webhook(), json({ body: 'x', url: 'javascript:alert(1)' })).url).toBeNull();
    expect(mapPayload(webhook(), json({ body: 'x', url: 'file:///etc/passwd' })).url).toBeNull();
  });

  it('always applies the webhook’s own tags, for provenance', () => {
    const mapped = mapPayload(webhook({ tags: ['forms'] }), json({ body: 'hi', tags: 'lead' }));
    expect(mapped.tags).toEqual(['forms', 'lead']);
  });

  it('takes plain text verbatim', () => {
    const mapped = mapPayload(webhook(), {
      payload: null,
      shape: 'text',
      raw: 'the printer is on fire',
    });
    expect(mapped.body).toBe('the printer is on fire');
  });

  it('does not choke on a top-level array', () => {
    const mapped = mapPayload(webhook(), json([1, 2, 3]));
    expect(mapped.body).toBe('[1,2,3]');
    expect(mapped.title).toBeNull();
  });

  it('caps a body that would otherwise be enormous', () => {
    const mapped = mapPayload(webhook(), json({ body: 'x'.repeat(WEBHOOK.maxBodyChars * 2) }));
    expect(mapped.body.length).toBeLessThanOrEqual(WEBHOOK.maxBodyChars);
  });
});

describe('template mapping', () => {
  it('interpolates a path out of a nested payload', () => {
    const mapped = mapPayload(
      webhook({
        format: 'template',
        bodyTemplate: '{{form.name}} wants {{form.service}} — reply to {{form.email}}',
        titleTemplate: 'Enquiry from {{form.name}}',
      }),
      json({ form: { name: 'Ada', service: 'a website', email: 'ada@example.com' } }),
    );
    expect(mapped.body).toBe('Ada wants a website — reply to ada@example.com');
    expect(mapped.title).toBe('Enquiry from Ada');
  });

  it('renders a missing path as a gap rather than leaving the braces showing', () => {
    // A body full of literal {{customer.name}} is worse than one with a hole.
    expect(renderPayloadTemplate('Hello {{nope.at.all}}!', {})).toBe('Hello !');
  });

  it('indexes into arrays', () => {
    expect(
      renderPayloadTemplate('{{items.0.sku}} / {{items[1].sku}}', {
        items: [{ sku: 'A1' }, { sku: 'B2' }],
      }),
    ).toBe('A1 / B2');
  });

  it('does no escaping of its own, because the renderer escapes everything', () => {
    // Safety here comes from lib/markdown.ts escaping the source in full before
    // emitting any tags; escaping twice would just print entities at the reader.
    expect(renderPayloadTemplate('{{x}}', { x: '<b>bold</b>' })).toBe('<b>bold</b>');
  });
});

describe('humanizeFieldName', () => {
  it('turns wire names into something a person would read', () => {
    expect(humanizeFieldName('customer_email')).toBe('Customer email');
    expect(humanizeFieldName('customerEmail')).toBe('Customer email');
    expect(humanizeFieldName('phone-number')).toBe('Phone number');
    expect(humanizeFieldName('name')).toBe('Name');
  });
});

/* -------------------------------------------------------------------------- */
/* The ingress itself, against a real Postgres                                */
/* -------------------------------------------------------------------------- */

/**
 * The mapping above is pure; these are the rules that are not. Each one is a
 * property of the *unauthenticated* path, so getting it wrong is a real hole
 * rather than a cosmetic bug — which is why they are exercised against the
 * database rather than reasoned about.
 *
 * Skipped without DATABASE_URL; CI sets it.
 */
const hasDatabase = Boolean(process.env['DATABASE_URL']);
process.env['SESSION_SECRET'] ??= 'test-only-session-secret-not-used-anywhere-else';

describe.skipIf(!hasDatabase)('ingest (real postgres)', async () => {
  const { eq } = await import('drizzle-orm');
  const { closeDb, getDb, schema: db } = await import('../db/client.js');
  const { runMigrations } = await import('../db/migrate.js');
  const { createRadar } = await import('./radars.js');
  const { createWebhook, ingestWebhook, rotateWebhookSecret } = await import('./webhooks.js');
  const { WEBHOOK: LIMITS_W } = await import('@onmyradar/contract');

  let owner: Actor;
  let radarId: string;

  async function newActor(): Promise<Actor> {
    const [user] = await getDb()
      .insert(db.users)
      .values({
        email: `hook-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
        state: 'active',
      })
      .returning();
    if (!user) throw new Error('user insert returned no row');
    return { user, kind: 'user' };
  }

  /** The URL the owner is handed is the only place the token exists. */
  function tokenOf(secretUrl: string): string {
    return secretUrl.split('/').pop() ?? '';
  }

  beforeAll(async () => {
    await runMigrations();
    owner = await newActor();
    radarId = (await createRadar(owner, { name: `Hooked ${Math.random()}` })).id;
  }, 30_000);

  afterAll(async () => {
    await closeDb();
  });

  it('turns a form post into a blip authored by the webhook’s creator', async () => {
    const hook = await createWebhook(owner, radarId, { name: 'Roving form', tags: ['forms'] });
    const result = await ingestWebhook(hook.id, tokenOf(hook.secretUrl ?? ''), {
      payload: { name: 'Ada', email: 'ada@example.com', message: 'Hello' },
      shape: 'form',
      raw: '',
    });

    const [blip] = await getDb().select().from(db.blips).where(eq(db.blips.id, result.blipId));
    expect(blip?.authorId).toBe(owner.user.id);
    expect(blip?.tags).toContain('forms');
    // The audit row says a webhook did it, not that the owner sat down and typed.
    const audit = await getDb()
      .select()
      .from(db.auditLog)
      .where(eq(db.auditLog.subjectId, result.blipId));
    expect(audit[0]?.actorKind).toBe('webhook');
  });

  it('answers a wrong token exactly as it answers a missing webhook', async () => {
    const hook = await createWebhook(owner, radarId, { name: 'Wrong token' });
    const delivery = { payload: { body: 'x' }, shape: 'json' as const, raw: '{}' };
    await expect(ingestWebhook(hook.id, 'omr_hook_not-the-token', delivery)).rejects.toThrow(
      /No such webhook/,
    );
    await expect(
      ingestWebhook('00000000-0000-0000-0000-0000000000ff', 'anything', delivery),
    ).rejects.toThrow(/No such webhook/);
  });

  it('stops accepting the old URL the moment the secret is rotated', async () => {
    const hook = await createWebhook(owner, radarId, { name: 'Rotate me' });
    const oldToken = tokenOf(hook.secretUrl ?? '');
    const rotated = await rotateWebhookSecret(owner, hook.id);
    const delivery = { payload: { body: 'x' }, shape: 'json' as const, raw: '{}' };

    await expect(ingestWebhook(hook.id, oldToken, delivery)).rejects.toThrow(/No such webhook/);
    await expect(
      ingestWebhook(hook.id, tokenOf(rotated.secretUrl ?? ''), delivery),
    ).resolves.toBeTruthy();
  });

  it('refuses a disabled webhook', async () => {
    const hook = await createWebhook(owner, radarId, { name: 'Off', enabled: false });
    await expect(
      ingestWebhook(hook.id, tokenOf(hook.secretUrl ?? ''), {
        payload: { body: 'x' },
        shape: 'json',
        raw: '{}',
      }),
    ).rejects.toThrow(/disabled/i);
  });

  it('dies with its creator’s account, because suspension has to mean everything', async () => {
    const doomed = await newActor();
    const theirRadar = (await createRadar(doomed, { name: `Doomed ${Math.random()}` })).id;
    const hook = await createWebhook(doomed, theirRadar, { name: 'Doomed hook' });
    const token = tokenOf(hook.secretUrl ?? '');
    const delivery = { payload: { body: 'x' }, shape: 'json' as const, raw: '{}' };

    await expect(ingestWebhook(hook.id, token, delivery)).resolves.toBeTruthy();
    await getDb()
      .update(db.users)
      .set({ state: 'suspended' })
      .where(eq(db.users.id, doomed.user.id));
    await expect(ingestWebhook(hook.id, token, delivery)).rejects.toThrow(/not active/i);
  });

  it('counts every delivery into one fixed window and then refuses', async () => {
    const hook = await createWebhook(owner, radarId, { name: 'Floody' });
    const token = tokenOf(hook.secretUrl ?? '');
    // Start the window already spent, so this does not have to send 60 requests.
    await getDb()
      .update(db.radarWebhooks)
      .set({ windowStartedAt: new Date(), windowCount: LIMITS_W.requestsPerMinute })
      .where(eq(db.radarWebhooks.id, hook.id));

    await expect(
      ingestWebhook(hook.id, token, { payload: { body: 'x' }, shape: 'json', raw: '{}' }),
    ).rejects.toThrow(/per minute/i);
  });

  it('rolls the window once the minute is up', async () => {
    const hook = await createWebhook(owner, radarId, { name: 'Rolls over' });
    const token = tokenOf(hook.secretUrl ?? '');
    await getDb()
      .update(db.radarWebhooks)
      .set({
        windowStartedAt: new Date(Date.now() - 61_000),
        windowCount: LIMITS_W.requestsPerMinute,
      })
      .where(eq(db.radarWebhooks.id, hook.id));

    await expect(
      ingestWebhook(hook.id, token, { payload: { body: 'x' }, shape: 'json', raw: '{}' }),
    ).resolves.toBeTruthy();
  });

  it('never shows a manager the database’s words as the last error', async () => {
    const hook = await createWebhook(owner, radarId, { name: 'Nul byte' });
    // Postgres text refuses a NUL, so this fails in SQL rather than as a refusal.
    await expect(
      ingestWebhook(hook.id, tokenOf(hook.secretUrl ?? ''), {
        payload: { message: 'before\u0000after' },
        shape: 'json',
        raw: '{}',
      }),
    ).rejects.toBeTruthy();
    const [row] = await getDb()
      .select()
      .from(db.radarWebhooks)
      .where(eq(db.radarWebhooks.id, hook.id));
    expect(row?.lastError).toBe(
      'Delivery failed on the server rather than because of the payload.',
    );
  });

  it('refuses a payload that would produce an empty blip', async () => {
    const hook = await createWebhook(owner, radarId, { name: 'Empty' });
    await expect(
      ingestWebhook(hook.id, tokenOf(hook.secretUrl ?? ''), {
        payload: {},
        shape: 'json',
        raw: '{}',
      }),
    ).rejects.toThrow(/empty blip/i);
  });
});
