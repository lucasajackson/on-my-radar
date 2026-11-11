import { test } from 'vitest';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { dkimSign } from 'mailauth/lib/dkim/sign.js';
import {
  authenticate as authenticateFor,
  FRESH_SIGNATURE_MAX_AGE_MS,
  isFreshSignature,
} from './email-authenticate.js';
const CAPTURE = 'test@onmyradar.io';
const authenticate = (raw: Buffer, r?: Parameters<typeof authenticateFor>[2]) =>
  authenticateFor(raw, CAPTURE, r);
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const resolver = async () => [
  [`v=DKIM1; p=${publicKey.export({ type: 'spki', format: 'der' }).toString('base64')}`],
];
const original =
  'From: Alice <alice@example.com>\r\nTo: test@onmyradar.io\r\nSubject: Capture\r\nDate: Sat, 19 Sep 2026 12:00:00 +0000\r\n\r\nOriginal message\r\n';
async function signed(raw = original, domain = 'example.com', extra = {}) {
  const { signatures, errors } = await dkimSign(raw, {
    signatureData: [
      {
        signingDomain: domain,
        selector: 'test',
        privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
        ...extra,
      },
    ],
  });
  assert.deepEqual(errors, []);
  return Buffer.from(signatures + raw);
}
test('accepts a verified exact-domain DKIM signature', async () => {
  assert.equal((await authenticate(await signed(), resolver)).sender, 'alice@example.com');
});
test('rejects spoofed authentication results without valid DKIM', async () => {
  await assert.rejects(
    authenticate(
      Buffer.from('Authentication-Results: mx.cloudflare.net; dmarc=pass\r\n' + original),
      resolver,
    ),
  );
});
test('rejects changed body and mismatched signing domain', async () => {
  await assert.rejects(
    authenticate(
      Buffer.from((await signed()).toString().replace('Original message', 'Injected message')),
      resolver,
    ),
  );
  await assert.rejects(authenticate(await signed(original, 'attacker.example'), resolver));
});
test('rejects duplicate From headers', async () => {
  await assert.rejects(
    authenticate(await signed('From: Eve <eve@example.com>\r\n' + original), resolver),
  );
});
test('rejects signatures allowing unsigned appended body', async () => {
  await assert.rejects(
    authenticate(await signed(original, 'example.com', { maxBodyLength: 5 }), resolver),
  );
});
test('rejects duplicate MIME headers and unsigned transfer encoding', async () => {
  await assert.rejects(
    authenticate(
      await signed('Content-Type: text/plain\r\nContent-Type: text/html\r\n' + original),
      resolver,
    ),
  );
  const good = await signed();
  await assert.rejects(
    authenticate(Buffer.from('Content-Transfer-Encoding: base64\r\n' + good.toString()), resolver),
  );
});
test('DNS outages are temporary rather than permanent sender refusals', async () => {
  await assert.rejects(
    authenticate(await signed(), async () => {
      throw new Error('DNS timeout');
    }),
    (error) =>
      typeof error === 'object' &&
      error !== null &&
      'temporary' in error &&
      error.temporary === true,
  );
});

test('reports bounded reasons without echoing message content', async () => {
  await assert.rejects(authenticate(Buffer.from(original), resolver), { reason: 'dkim_missing' });
  await assert.rejects(authenticate(await signed(original, 'attacker.example'), resolver), {
    reason: 'dkim_domain_mismatch',
  });
  await assert.rejects(
    authenticate(
      Buffer.from((await signed()).toString().replace('Original message', 'changed')),
      resolver,
    ),
    { reason: 'dkim_invalid' },
  );
  await assert.rejects(
    authenticate(
      Buffer.from('Content-Transfer-Encoding: base64\r\n' + (await signed()).toString()),
      resolver,
    ),
    { reason: 'dkim_unsigned_headers' },
  );
  await assert.rejects(
    authenticate(await signed(original, 'example.com', { maxBodyLength: 5 }), resolver),
    { reason: 'dkim_signature_policy' },
  );
});

// The capture address must be in a To/Cc header the passing signature covers, or the
// signature must be fresh.
const body =
  'Date: Sat, 19 Sep 2026 12:00:00 +0000\r\nSubject: Capture\r\n\r\nOriginal message\r\n';
const from = 'From: Alice <alice@example.com>\r\n';
const HOUR = 60 * 60 * 1000;
async function signedAt(raw: string, ageMs: number, options: Record<string, unknown> = {}) {
  // `signTime` and `expires` are real mailauth options its typings omit.
  const { signatures, errors } = await dkimSign(raw, {
    signTime: new Date(Date.now() - ageMs),
    signatureData: [
      {
        signingDomain: 'example.com',
        selector: 'test',
        privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      },
    ],
    ...options,
  } as unknown as Parameters<typeof dkimSign>[1]);
  assert.deepEqual(errors, []);
  return Buffer.from(signatures + raw);
}
const forOther = from + 'To: other@example.net\r\n' + body;

test('accepts the capture address in a signed Cc, a display name, mixed case and a group, even when old', async () => {
  for (const headers of [
    'To: other@example.net\r\nCc: Capture Box <TEST@OnMyRadar.io>\r\n',
    'To: "Someone" <other@example.net>, "Me" <Test@onmyradar.io>\r\n',
    'To: Team: other@example.net, test@onmyradar.io;\r\n',
  ]) {
    const result = await authenticate(
      await signedAt(from + headers + body, 30 * 24 * HOUR),
      resolver,
    );
    assert.equal(result.sender, 'alice@example.com');
  }
});
test('accepts a fresh message that was Bcc-ed or forwarded (signed To/Cc names someone else)', async () => {
  assert.equal(
    (await authenticate(await signedAt(forOther, 0), resolver)).sender,
    'alice@example.com',
  );
  assert.equal(
    (
      await authenticate(
        await signedAt(forOther, FRESH_SIGNATURE_MAX_AGE_MS - 10 * 60 * 1000),
        resolver,
      )
    ).sender,
    'alice@example.com',
  );
});
test('refuses an old message signed for another destination replayed to the capture address', async () => {
  for (const age of [FRESH_SIGNATURE_MAX_AGE_MS + 10 * 60 * 1000, 3 * HOUR, 30 * 24 * HOUR]) {
    await assert.rejects(authenticate(await signedAt(forOther, age), resolver), {
      reason: 'stale_signature_for_other_recipient',
    });
  }
});
test('an old signature that is signed for the capture address is still accepted', async () => {
  const raw = from + 'To: test@onmyradar.io\r\n' + body;
  assert.equal(
    (await authenticate(await signedAt(raw, 3 * HOUR), resolver)).sender,
    'alice@example.com',
  );
});
test('refuses an expired or future-dated signature when the To does not match', async () => {
  // mailauth's own time validity runs first, so neither reaches the freshness rule.
  await assert.rejects(
    authenticate(
      await signedAt(forOther, HOUR, { expires: new Date(Date.now() - 10 * 60 * 1000) }),
      resolver,
    ),
    { reason: 'dkim_invalid' },
  );
  await assert.rejects(authenticate(await signedAt(forOther, -3 * HOUR), resolver), {
    reason: 'dkim_signature_policy',
  });
});
test('a signature with no signing time or an unreadable one is never fresh', () => {
  assert.equal(isFreshSignature({}), false);
  assert.equal(isFreshSignature({ signTime: null }), false);
  assert.equal(isFreshSignature({ signTime: 'not a date' }), false);
  assert.equal(isFreshSignature({ signTime: new Date().toISOString() }), true);
  assert.equal(
    isFreshSignature({
      signTime: new Date(Date.now() - HOUR).toISOString(),
      expiresAfter: new Date(Date.now() - 1000).toISOString(),
    }),
    false,
  );
  assert.equal(
    isFreshSignature({ signTime: new Date(Date.now() + 10 * 60 * 1000).toISOString() }),
    false,
  );
});
test('an unsigned To or Cc prepended above the signed one never counts as signed', async () => {
  for (const injected of ['To: test@onmyradar.io\r\n', 'Cc: test@onmyradar.io\r\n']) {
    // Old signature: the injected header is not covered, so the replay is refused.
    const old = (await signedAt(forOther, 3 * HOUR)).toString();
    await assert.rejects(authenticate(Buffer.from(injected + old), resolver), {
      reason: 'stale_signature_for_other_recipient',
    });
    // Fresh signature: accepted by the freshness rule, by design, not because of the injected header.
    const fresh = (await signedAt(forOther, 0)).toString();
    assert.equal(
      (await authenticate(Buffer.from(injected + fresh), resolver)).sender,
      'alice@example.com',
    );
  }
});
test('an old signature whose h= leaves out to and cc is refused even if the To names us', async () => {
  const raw = from + 'To: test@onmyradar.io\r\n' + body;
  await assert.rejects(
    authenticate(await signedAt(raw, 3 * HOUR, { headerList: 'from:subject:date' }), resolver),
    { reason: 'stale_signature_for_other_recipient' },
  );
});
