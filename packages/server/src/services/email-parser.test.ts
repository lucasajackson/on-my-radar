import { generateKeyPairSync } from 'node:crypto';
import { dkimSign } from 'mailauth/lib/dkim/sign.js';
import { describe, expect, it } from 'vitest';
import { parseEmail } from './email-parser.js';
import { EMAIL_LIMITS } from './email-limits.js';
import { emailDeliverySchema } from './inbound-email.js';
import { must } from '../errors.js';
const RECIPIENT = 'reader@onmyradar.io';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const dns = {
  'test._domainkey.example.com': [
    [`v=DKIM1; p=${publicKey.export({ type: 'spki', format: 'der' }).toString('base64')}`],
  ],
};
async function signed(
  body: string,
  headers = 'Content-Type: text/plain\r\n',
  subject = 'Isolated capture',
) {
  const raw = `From: alice@example.com\r\nTo: reader@onmyradar.io\r\nSubject: ${subject}\r\n${headers}\r\n${body}`;
  const result = await dkimSign(raw, {
    signatureData: [
      {
        signingDomain: 'example.com',
        selector: 'test',
        privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      },
    ],
  });
  return Buffer.from(result.signatures + raw);
}
describe('isolated email parser', () => {
  it('verifies and parses a real signed message in a worker', async () => {
    const parsed = await parseEmail(
      await signed('A thought'),
      RECIPIENT,
      AbortSignal.timeout(5000),
      dns,
    );
    expect(parsed.sender).toBe('alice@example.com');
    expect(parsed.signatureId).toMatch(/^[a-f0-9]+$/);
    expect(parsed.body).toContain('A thought');
  });
  it('preserves original MIME, formatted HTML, sender and CID disposition without flattening the readable text', async () => {
    const raw = await signed(
      '--parts\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>First &amp; second</p><p>Next paragraph</p><img src="cid:logo"><script>alert(1)</script>\r\n--parts\r\nContent-Type: image/png\r\nContent-ID: <logo>\r\nContent-Disposition: inline; filename="logo.png"\r\nContent-Transfer-Encoding: base64\r\n\r\nAQID\r\n--parts--\r\n',
      'MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary="parts"\r\n',
    );
    const expected = Buffer.from(raw);
    const parsed = await parseEmail(raw, RECIPIENT, AbortSignal.timeout(5000), dns);
    expect(Buffer.from(parsed.original)).toEqual(expected);
    expect(parsed.subject).toBe('Isolated capture');
    expect(parsed.text).toContain('First & second\n\nNext paragraph');
    expect(parsed.html).toContain('<p>First &amp; second</p>');
    expect(parsed.html).not.toContain('script');
    expect(parsed.files[0]).toMatchObject({ contentId: 'logo', inline: true });
    expect(parsed.body).not.toContain('# Isolated capture');
  });
  /**
   * Postgres cannot store U+0000 in text or jsonb, so a NUL that reached the
   * receipt insert turned a valid, signed message into a 500 the relay retries
   * for days. And a single part whose type is refused or malformed used to
   * bounce the whole message; it is kept as opaque bytes instead.
   */
  it('removes NUL characters and stores unsafe or malformed part types as opaque bytes', async () => {
    const raw = await signed(
      '--part\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nbefore=00after\r\n' +
        '--part\r\nContent-Type: text/html\r\nContent-Disposition: attachment; filename="receipt.html"\r\n\r\n<script>alert(1)</script>\r\n' +
        '--part\r\nContent-Type: not a type\r\nContent-Disposition: attachment; filename="odd.bin"\r\n\r\nodd\r\n' +
        '--part\r\nContent-Type: image/PNG\r\nContent-Disposition: attachment; filename="shot.png"\r\nContent-Transfer-Encoding: base64\r\n\r\nAQID\r\n' +
        '--part--\r\n',
      'MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="part"\r\n',
      '=?utf-8?q?null=00byte?=',
    );
    const parsed = await parseEmail(raw, RECIPIENT, AbortSignal.timeout(5000), dns);
    expect(parsed.text).toContain('beforeafter');
    expect(parsed.body).not.toContain('\0');
    expect(parsed.subject).toBe('nullbyte');
    expect(parsed.files.map((file) => file.contentType)).toEqual([
      'application/octet-stream',
      'application/octet-stream',
      'image/png',
    ]);
  });
  /**
   * A newsletter embeds dozens of images by cid:. One shared ceiling of twelve
   * refused the whole message; inline images now have their own budget, and
   * only files a person attached count against twelve.
   */
  describe('attachment and inline-image budgets', () => {
    const png = 'Content-Type: image/png\r\nContent-Transfer-Encoding: base64\r\n';
    function newsletter(inline: number, attached: number) {
      const html = Array.from({ length: inline }, (_, i) => `<img src="cid:img${i}">`).join('');
      const parts = [
        `--n\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Issue</p>${html}\r\n`,
        ...Array.from(
          { length: inline },
          (_, i) =>
            `--n\r\n${png}Content-ID: <img${i}>\r\nContent-Disposition: inline; filename="i${i}.png"\r\n\r\nAQID\r\n`,
        ),
        ...Array.from(
          { length: attached },
          (_, i) =>
            `--n\r\n${png}Content-Disposition: attachment; filename="a${i}.png"\r\n\r\nAQID\r\n`,
        ),
      ];
      return signed(
        `${parts.join('')}--n--\r\n`,
        'MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary="n"\r\n',
      );
    }
    it('captures a newsletter with many inline images, keeping those within budget', async () => {
      const parsed = await parseEmail(
        await newsletter(60, 2),
        RECIPIENT,
        AbortSignal.timeout(10000),
        dns,
      );
      const inline = parsed.files.filter((file) => file.inline);
      expect(inline).toHaveLength(EMAIL_LIMITS.inlineImages);
      expect(inline[0]?.contentId).toBe('img0');
      expect(parsed.files.filter((file) => !file.inline)).toHaveLength(2);
      // The capture path accepts what the parser keeps.
      expect(() =>
        emailDeliverySchema.parse({
          id: 'a'.repeat(64),
          recipient: 'reader@onmyradar.io',
          sender: 'alice@example.com',
          body: parsed.body,
          files: parsed.files.map((file) => ({
            filename: file.filename,
            contentType: file.contentType,
            size: file.bytes.byteLength,
          })),
        }),
      ).not.toThrow();
    }, 20000);
    it('still refuses more than twelve attached files, and a hostile number of parts', async () => {
      await expect(
        parseEmail(
          await newsletter(0, EMAIL_LIMITS.attachments + 1),
          RECIPIENT,
          AbortSignal.timeout(10000),
          dns,
        ),
      ).rejects.toMatchObject({ status: 403, code: 'email_mime_limits' });
      await expect(
        parseEmail(
          await newsletter(EMAIL_LIMITS.parts, 1),
          RECIPIENT,
          AbortSignal.timeout(10000),
          dns,
        ),
      ).rejects.toMatchObject({ status: 403, code: 'email_mime_limits' });
    }, 20000);
  });
  it('handles a near-limit signed MIME attachment under the worker heap ceiling', async () => {
    const attachment = Buffer.alloc(7 * 1024 * 1024, 65);
    const encoded = must(attachment.toString('base64').match(/.{1,76}/g)).join('\r\n');
    const raw = await signed(
      `--part\r\nContent-Type: text/plain\r\n\r\nLarge proof\r\n--part\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="proof.bin"\r\nContent-Transfer-Encoding: base64\r\n\r\n${encoded}\r\n--part--\r\n`,
      'MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="part"\r\n',
    );
    expect(raw.byteLength).toBeGreaterThan(9 * 1024 * 1024);
    expect(raw.byteLength).toBeLessThan(10 * 1024 * 1024);
    const parsed = await parseEmail(raw, RECIPIENT, AbortSignal.timeout(20000), dns);
    expect(parsed.files[0]?.bytes.byteLength).toBe(attachment.byteLength);
    expect(parsed.files[0]?.bytes[0]).toBe(65);
  }, 30000);
  it('refuses excessive MIME nesting and forged unsigned messages', async () => {
    const nested = Array.from(
      { length: 35 },
      (_, i) => `--part${i}\r\nContent-Type: multipart/mixed; boundary="part${i + 1}"\r\n\r\n`,
    ).join('');
    await expect(
      parseEmail(
        await signed(nested, 'Content-Type: multipart/mixed; boundary="part0"\r\n'),
        RECIPIENT,
        AbortSignal.timeout(5000),
        dns,
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      parseEmail(
        Buffer.from('From: alice@example.com\r\n\r\nforged'),
        RECIPIENT,
        AbortSignal.timeout(5000),
        dns,
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
  it('terminates work when its deadline expires', async () => {
    await expect(
      parseEmail(await signed('deadline'), RECIPIENT, AbortSignal.timeout(1), dns),
    ).rejects.toBeDefined();
  });
});
