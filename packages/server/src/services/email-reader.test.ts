import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDb, getDb, getPool, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv, setEnvForTesting } from '../env.js';
import type { Actor } from '../http.js';
import type * as StorageModule from './storage.js';
import { createRadar, deleteRadar, setVisibility } from './radars.js';
import { createBlip, deleteBlip, getBlip, listBlips, updateBlip } from './blips.js';
import {
  authorizeEmailDelivery,
  claimEmailCaptureIdentity,
  cleanupDeletedRadarEmailUploads,
  cleanupEmailReceipts,
  finalizeEmailDelivery,
  updateRadarEmailCapture,
} from './inbound-email.js';
import { getEmailDetail, getOriginalEmailUrl } from './email-reader.js';
import { createApp } from '../app.js';
import { readEmailContent, headObject, createDownloadUrl } from './storage.js';
import { must } from '../errors.js';
vi.mock('./storage.js', async (original) => ({
  ...(await original<typeof StorageModule>()),
  headObject: vi.fn(),
  readEmailContent: vi.fn(),
  createDownloadUrl: vi.fn(
    async (key: string, _filename: string, _type: string, disposition = 'inline') =>
      `https://storage.example/${key}?disposition=${String(disposition)}`,
  ),
  deleteObjects: vi.fn(async () => {
    throw new Error('Retain cleanup job for assertion');
  }),
}));

describe.skipIf(!process.env['DATABASE_URL'])(
  'blip-owned email lifecycle (isolated postgres)',
  () => {
    const database = `omr_emailreader_${randomUUID().replaceAll('-', '')}`;
    let admin: pg.Pool;
    let owner: Actor;
    let outsider: Actor;
    let radarId: string;
    let recipient: string;
    beforeAll(async () => {
      admin = new pg.Pool({ connectionString: process.env['DATABASE_URL'] });
      await admin.query(`CREATE DATABASE ${database}`);
      const url = new URL(must(process.env['DATABASE_URL']));
      url.pathname = `/${database}`;
      setEnvForTesting(
        loadEnv({
          ...process.env,
          DATABASE_URL: url.toString(),
          SESSION_SECRET: 'test-email-reader-secret-for-isolated-tests',
          EMAIL_CAPTURE_DOMAIN: 'onmyradar.io',
          EMAIL_CAPTURE_ENABLED: 'true',
          EMAIL_INGEST_SECRET: 'test-email-reader-secret-for-isolated-tests',
        }),
      );
      await runMigrations();
      await runMigrations();
      const users = await getDb()
        .insert(schema.users)
        .values([
          { email: 'reader@example.test', state: 'active' },
          { email: 'outsider@example.test', state: 'active' },
        ])
        .returning();
      owner = { kind: 'user', user: must(users[0]) };
      outsider = { kind: 'user', user: must(users[1]) };
      radarId = (await createRadar(owner, { name: 'Email reader' })).id;
      await claimEmailCaptureIdentity(owner, 'mailreader');
      recipient = must(
        (await updateRadarEmailCapture(owner, radarId, { enabled: true, allowedSenders: [] }))
          .address,
      );
      vi.mocked(headObject).mockResolvedValue({ size: 3, contentType: 'image/png' });
    });
    afterAll(async () => {
      await closeDb();
      await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
      await admin.end();
    });
    async function capture() {
      const id = randomUUID().replaceAll('-', '').repeat(2);
      const receipt = await authorizeEmailDelivery({
        id,
        recipient,
        sender: owner.user.email,
        body: 'Original searchable newsletter',
        files: [
          { filename: 'logo.png', contentType: 'image/png', size: 3 },
          { filename: 'file.png', contentType: 'image/png', size: 3 },
        ],
        email: {
          subject: 'Newsletter subject',
          senderName: 'Publisher',
          sentAt: '2026-09-19T10:00:00.000Z',
          preview: 'Original searchable newsletter',
          hasHtml: true,
          attachmentCount: 1,
        },
      });
      await finalizeEmailDelivery(id);
      const [stored] = await getDb()
        .select()
        .from(schema.emailCaptureReceipts)
        .where(eq(schema.emailCaptureReceipts.id, id));
      expect(stored).toMatchObject({ body: '', files: [], email: null });
      vi.mocked(readEmailContent).mockResolvedValue({
        text: 'Full original searchable newsletter',
        html: '<p>Newsletter</p><img src="cid:logo"><img data-omr-image="https://images.example/pixel">',
        files: [
          { key: must(receipt.files[0]).key, contentId: 'logo', inline: true },
          { key: must(receipt.files[1]).key, contentId: null, inline: false },
          { key: 'radars/foreign/logo.png', contentId: 'foreign', inline: true },
        ],
      });
      return { id, blipId: must(must(stored).blipId), receipt };
    }
    it('backfills proven legacy receipts and indexes notes during the real schema transition', async () => {
      const connection = await getPool().connect();
      try {
        await connection.query('BEGIN');
        await connection.query(
          "DROP TABLE blip_emails; ALTER TABLE blips DROP COLUMN search; ALTER TABLE blips DROP COLUMN email_notes; ALTER TABLE blips ADD COLUMN search tsvector GENERATED ALWAYS AS (to_tsvector('english',body)) STORED; ALTER TABLE email_capture_receipts DROP COLUMN email",
        );
        const id = randomUUID();
        await connection.query('INSERT INTO blips(id,radar_id,body,title) VALUES($1,$2,$3,$4)', [
          id,
          radarId,
          'Old flattened content',
          'Old subject',
        ]);
        await connection.query(
          "INSERT INTO email_capture_receipts(id,radar_id,sender,body,files,blip_id,completed_at) VALUES($1,$2,$3,'','[]',$4,now())",
          [randomUUID().replaceAll('-', '').repeat(2), radarId, owner.user.email, id],
        );
        await connection.query('SET CONSTRAINTS ALL IMMEDIATE');
        await connection.query(
          await readFile(
            new URL('../../drizzle/0025_blip_email_content.sql', import.meta.url),
            'utf8',
          ),
        );
        const migrated = await connection.query(
          'SELECT subject,sender_address,legacy,payload_key,original_key FROM blip_emails WHERE blip_id=$1',
          [id],
        );
        expect(migrated.rows[0]).toEqual({
          subject: 'Old subject',
          sender_address: owner.user.email,
          legacy: true,
          payload_key: null,
          original_key: null,
        });
        await connection.query("UPDATE blips SET email_notes='migrationsearchword' WHERE id=$1", [
          id,
        ]);
        expect(
          (
            await connection.query(
              "SELECT id FROM blips WHERE search @@ to_tsquery('english','migrationsearchword') AND id=$1",
              [id],
            )
          ).rowCount,
        ).toBe(1);
      } finally {
        await connection.query('ROLLBACK');
        connection.release();
      }
    });
    it('keeps immutable original and separately indexed notes, with idempotent capture and batched summaries', async () => {
      const { id, blipId } = await capture();
      expect((await getBlip(blipId, owner)).email).toMatchObject({
        subject: 'Newsletter subject',
        senderName: 'Publisher',
        notes: '',
        attachmentCount: 1,
      });
      await expect(updateBlip(owner, blipId, { body: 'overwrite' })).rejects.toMatchObject({
        status: 400,
      });
      const updated = await updateBlip(owner, blipId, { emailNotes: 'unicorn-lexicography' });
      expect(updated.body).toBe('Original searchable newsletter');
      expect(updated.email?.notes).toBe('unicorn-lexicography');
      expect(
        (
          await listBlips([radarId], { q: 'lexicography', limit: 30 }, null, owner.user.id)
        ).items.map((b) => b.id),
      ).toContain(blipId);
      await finalizeEmailDelivery(id);
      expect(
        await getDb().select().from(schema.blipEmails).where(eq(schema.blipEmails.blipId, blipId)),
      ).toHaveLength(1);
      const plain = await createBlip(owner, radarId, { body: 'Ordinary note' });
      await expect(updateBlip(owner, plain.id, { emailNotes: 'invalid' })).rejects.toMatchObject({
        status: 400,
      });
    });
    it('reads full content with exact-blip CID authorization, remote-image consent and private original download', async () => {
      const { blipId } = await capture();
      const detail = await getEmailDetail(blipId, owner);
      expect(detail.text).toBe('Full original searchable newsletter');
      expect(detail.attachments).toHaveLength(1);
      expect(detail.attachments[0]?.filename).toBe('file.png');
      expect(detail.remoteImagesBlocked).toBe(1);
      expect(detail.imageOrigins).toEqual(['https://storage.example']);
      expect(detail.html).not.toContain('foreign');
      expect(detail.originalHref).toContain('/email/original');
      expect(await getOriginalEmailUrl(blipId, owner)).toContain('disposition=attachment');
      expect((await getEmailDetail(blipId, owner, undefined, true)).imageOrigins).toContain(
        'https://images.example',
      );
      await expect(getEmailDetail(blipId, outsider)).rejects.toMatchObject({ status: 404 });
      await expect(getOriginalEmailUrl(blipId, outsider)).rejects.toMatchObject({ status: 404 });
    });
    it('reads MCP text without signing CID resources or rendering HTML', async () => {
      const { blipId } = await capture();
      vi.mocked(createDownloadUrl).mockClear();
      const detail = await getEmailDetail(blipId, owner, undefined, false, { renderHtml: false });
      expect(detail.text).toBe('Full original searchable newsletter');
      expect(detail.html).toBeNull();
      expect(detail.imageOrigins).toEqual([]);
      expect(detail.attachments.map((file) => file.filename)).toEqual(['file.png']);
      expect(createDownloadUrl).not.toHaveBeenCalled();
    });
    it('public reads redact sender addresses and originals, and permissions follow moves', async () => {
      const { blipId } = await capture();
      const published = await setVisibility(owner, radarId, 'public');
      const slug = must(published.publicSlug);
      const detail = await getEmailDetail(blipId, null, slug);
      expect(detail.senderAddress).toBeNull();
      expect(detail.originalHref).toBeNull();
      const response = await createApp().request(
        `/api/public/radars/${slug}/blips/${blipId}/email`,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toContain('no-store');
      await expect(getEmailDetail(blipId, null, radarId)).rejects.toMatchObject({ status: 404 });
      const target = (await createRadar(owner, { name: 'Private moved email' })).id;
      await updateBlip(owner, blipId, { radarId: target });
      await expect(getEmailDetail(blipId, null, slug)).rejects.toMatchObject({ status: 404 });
      expect((await getEmailDetail(blipId, owner)).attachments).toHaveLength(1);
    });
    it('never lets anonymous readers use up the members’ reading budget', async () => {
      const { blipId } = await capture();
      const slug = must((await setVisibility(owner, radarId, 'public')).publicSlug);
      const content = await readEmailContent('unused');
      vi.mocked(readEmailContent).mockClear();
      // Hold every public read open, as a slow or hostile caller would.
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => (release = resolve));
      vi.mocked(readEmailContent).mockImplementation(async () => {
        await held;
        return content;
      });
      const publicReads = [
        getEmailDetail(blipId, null, slug, false, { renderHtml: false }),
        getEmailDetail(blipId, null, slug, false, { renderHtml: false }),
      ];
      await vi.waitFor(() => expect(readEmailContent).toHaveBeenCalledTimes(2));
      try {
        // The public budget is full…
        await expect(
          getEmailDetail(blipId, null, slug, false, { renderHtml: false }),
        ).rejects.toMatchObject({ status: 503 });
        // …and a member still reads, on a budget of their own.
        vi.mocked(readEmailContent).mockResolvedValueOnce(content);
        const member = await getEmailDetail(blipId, owner, undefined, false, {
          renderHtml: false,
        });
        expect(member.text).toBe('Full original searchable newsletter');
      } finally {
        // Released whatever happened, so a failure here cannot leave the
        // budget held and fail the tests after it.
        release();
        await Promise.allSettled(publicReads);
      }
      vi.mocked(readEmailContent).mockResolvedValue(content);
      await setVisibility(owner, radarId, 'private');
    });

    it('snapshots payload/raw keys for blip/radar deletion and reconciles late writes after blip deletion', async () => {
      const first = await capture();
      await deleteBlip(owner, first.blipId);
      expect(
        await getDb()
          .select()
          .from(schema.blipEmails)
          .where(eq(schema.blipEmails.blipId, first.blipId)),
      ).toHaveLength(0);
      const keys = [must(first.receipt.email).payloadKey, must(first.receipt.email).originalKey];
      await cleanupDeletedRadarEmailUploads(keys, first.id);
      const jobs = await getDb()
        .select()
        .from(schema.outbox)
        .where(eq(schema.outbox.kind, 'object-cleanup'));
      expect(
        jobs.some((job) =>
          keys.every((key) => (job.payload as { keys: string[] }).keys.includes(key)),
        ),
      ).toBe(true);
      const next = await capture();
      const destination = (await createRadar(owner, { name: 'Delete moved email' })).id;
      await updateBlip(owner, next.blipId, { radarId: destination });
      await deleteRadar(owner, destination);
      const after = await getDb()
        .select()
        .from(schema.outbox)
        .where(eq(schema.outbox.kind, 'object-cleanup'));
      expect(
        after.some((job) =>
          (job.payload as { keys: string[] }).keys.includes(must(next.receipt.email).originalKey),
        ),
      ).toBe(true);
    });
    it('rejects expired upload authorizations and reconciles old generations without deleting replacement objects', async () => {
      const input = {
        id: randomUUID().replaceAll('-', '').repeat(2),
        recipient,
        sender: owner.user.email,
        body: 'Pending race',
        files: [],
        email: {
          subject: null,
          senderName: null,
          sentAt: null,
          preview: 'Pending race',
          hasHtml: false,
          attachmentCount: 0,
        },
      };
      const old = await authorizeEmailDelivery(input);
      await getDb()
        .update(schema.emailCaptureReceipts)
        .set({ createdAt: new Date(Date.now() - 2 * 86400000) })
        .where(eq(schema.emailCaptureReceipts.id, input.id));
      await expect(authorizeEmailDelivery(input)).rejects.toMatchObject({ status: 400 });
      await cleanupEmailReceipts();
      const replacement = await authorizeEmailDelivery(input);
      expect(must(replacement.email).payloadKey).not.toBe(must(old.email).payloadKey);
      const oldKeys = [must(old.email).payloadKey, must(old.email).originalKey];
      await cleanupDeletedRadarEmailUploads(oldKeys, input.id);
      await finalizeEmailDelivery(input.id);
      await cleanupDeletedRadarEmailUploads(oldKeys, input.id);
      await cleanupDeletedRadarEmailUploads(
        [must(replacement.email).payloadKey, must(replacement.email).originalKey],
        input.id,
      );
      const jobs = await getDb()
        .select()
        .from(schema.outbox)
        .where(eq(schema.outbox.kind, 'object-cleanup'));
      expect(
        jobs.filter((job) =>
          (job.payload as { keys: string[] }).keys.includes(must(old.email).payloadKey),
        ),
      ).toHaveLength(3);
      expect(
        jobs.some((job) =>
          (job.payload as { keys: string[] }).keys.includes(must(replacement.email).payloadKey),
        ),
      ).toBe(false);
    });
    it('preserves moved originals when a late upload settles after its source radar and receipt were deleted', async () => {
      const source = (await createRadar(owner, { name: 'Temporary original source' })).id;
      const previousRecipient = recipient;
      recipient = must(
        (await updateRadarEmailCapture(owner, source, { enabled: true, allowedSenders: [] }))
          .address,
      );
      let captured: Awaited<ReturnType<typeof capture>>;
      try {
        captured = await capture();
      } finally {
        recipient = previousRecipient;
      }
      const target = (await createRadar(owner, { name: 'Surviving moved original' })).id;
      await updateBlip(owner, captured.blipId, { radarId: target });
      await deleteRadar(owner, source);
      const keys = [
        must(captured.receipt.email).payloadKey,
        must(captured.receipt.email).originalKey,
        ...captured.receipt.files.map((file) => file.key),
      ];
      await cleanupDeletedRadarEmailUploads(keys, captured.id);
      const jobs = await getDb()
        .select()
        .from(schema.outbox)
        .where(eq(schema.outbox.kind, 'object-cleanup'));
      expect(
        jobs.some((job) =>
          (job.payload as { keys: string[] }).keys.some((key) => keys.includes(key)),
        ),
      ).toBe(false);
      expect((await getEmailDetail(captured.blipId, owner)).text).toBe(
        'Full original searchable newsletter',
      );
    });
    it('preserves an older live blip when a replacement receipt with the same delivery id is pending', async () => {
      const original = await capture();
      await getDb()
        .update(schema.emailCaptureReceipts)
        .set({ completedAt: new Date(Date.now() - 91 * 86400000) })
        .where(eq(schema.emailCaptureReceipts.id, original.id));
      await cleanupEmailReceipts();
      await authorizeEmailDelivery({
        id: original.id,
        recipient,
        sender: owner.user.email,
        body: 'A later replay',
        files: [],
        email: {
          subject: null,
          senderName: null,
          sentAt: null,
          preview: 'Later',
          hasHtml: false,
          attachmentCount: 0,
        },
      });
      const keys = [
        must(original.receipt.email).payloadKey,
        must(original.receipt.email).originalKey,
        ...original.receipt.files.map((file) => file.key),
      ];
      await cleanupDeletedRadarEmailUploads(keys, original.id);
      const jobs = await getDb()
        .select()
        .from(schema.outbox)
        .where(eq(schema.outbox.kind, 'object-cleanup'));
      expect(
        jobs.some((job) =>
          (job.payload as { keys: string[] }).keys.some((key) => keys.includes(key)),
        ),
      ).toBe(false);
    });
    it('retains pending content keys until expiration cleanup and serves honest legacy plaintext', async () => {
      const id = randomUUID().replaceAll('-', '').repeat(2);
      const receipt = await authorizeEmailDelivery({
        id,
        recipient,
        sender: owner.user.email,
        body: 'Pending',
        files: [],
        email: {
          subject: null,
          senderName: null,
          sentAt: null,
          preview: 'Pending',
          hasHtml: false,
          attachmentCount: 0,
        },
      });
      await getDb()
        .update(schema.emailCaptureReceipts)
        .set({ createdAt: new Date(Date.now() - 2 * 86400000) })
        .where(eq(schema.emailCaptureReceipts.id, id));
      await cleanupEmailReceipts();
      const jobs = await getDb()
        .select()
        .from(schema.outbox)
        .where(eq(schema.outbox.kind, 'object-cleanup'));
      expect(
        jobs.some((job) =>
          (job.payload as { keys: string[] }).keys.includes(must(receipt.email).payloadKey),
        ),
      ).toBe(true);
      const legacy = await createBlip(owner, radarId, { body: 'Older flattened email' });
      await getDb()
        .insert(schema.blipEmails)
        .values({ blipId: legacy.id, receivedAt: new Date(), legacy: true });
      expect(await getEmailDetail(legacy.id, owner)).toMatchObject({
        legacy: true,
        text: 'Older flattened email',
        html: null,
        originalHref: null,
      });
    });
  },
);
