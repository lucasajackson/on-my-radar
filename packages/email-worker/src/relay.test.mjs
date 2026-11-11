import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import relay from './index.mjs';
import { signMetadata } from './signing.mjs';
const MAX_RAW_BYTES = 10 * 1024 * 1024;
const env = {
  API_ORIGIN: 'https://onmyradar.io',
  EMAIL_INGEST_SECRET: 'relay-only-test-secret-not-for-production',
};
const message = (raw = 'From: sender@example.com\r\n\r\nHello', declared) => {
  const bytes = new TextEncoder().encode(raw);
  return {
    to: 'Reader@onmyradar.io',
    rawSize: declared ?? bytes.length,
    raw: new ReadableStream({
      start(c) {
        c.enqueue(bytes);
        c.close();
      },
    }),
    rejection: null,
    setReject(value) {
      this.rejection = value;
    },
  };
};
async function withFetch(handler, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}
async function consume(options) {
  return new Response(options.body).arrayBuffer();
}
test('metadata signature matches the Node backend contract', async () => {
  const expected = createHmac('sha256', env.EMAIL_INGEST_SECRET)
    .update('123\nnonce\nreader@onmyradar.io\n42')
    .digest('hex');
  assert.equal(
    await signMetadata(env.EMAIL_INGEST_SECRET, '123', 'nonce', 'reader@onmyradar.io', 42),
    expected,
  );
});
test('streams exact bytes and authenticated metadata without redirect forwarding', async () => {
  const email = message();
  await withFetch(
    async (url, options) => {
      assert.equal(url, 'https://onmyradar.io/hooks/email-capture/raw');
      assert.equal(options.redirect, 'manual');
      assert.equal(options.body, email.raw, 'native stream must pass through without per-chunk JS');
      const h = options.headers;
      assert.equal(h['x-omr-recipient'], 'reader@onmyradar.io');
      assert.equal(
        h['x-omr-signature'],
        await signMetadata(
          env.EMAIL_INGEST_SECRET,
          h['x-omr-timestamp'],
          h['x-omr-nonce'],
          h['x-omr-recipient'],
          email.rawSize,
        ),
      );
      assert.equal((await consume(options)).byteLength, email.rawSize);
      return new Response(null, { status: 204, headers: { 'x-omr-email-result': 'accepted' } });
    },
    () => relay.email(email, env),
  );
  assert.equal(email.rejection, null);
});
test('oversized declaration is rejected before any API call', async () => {
  const email = message('x', MAX_RAW_BYTES + 1);
  await withFetch(
    () => {
      throw new Error('must not fetch');
    },
    () => relay.email(email, env),
  );
  assert.match(email.rejection, /10 MiB/);
});
test('operational and capacity errors stay transient; author refusals are permanent', async () => {
  for (const status of [401, 404, 408, 429, 500, 503]) {
    const email = message();
    await withFetch(
      async (_url, options) => {
        await consume(options);
        return new Response(null, { status, headers: { 'x-omr-email-result': 'rejected' } });
      },
      async () => {
        await assert.rejects(relay.email(email, env), /temporarily/);
      },
    );
    assert.equal(email.rejection, null);
  }
  for (const status of [400, 403, 413]) {
    const email = message();
    await withFetch(
      async (_url, options) => {
        await consume(options);
        return new Response(null, { status, headers: { 'x-omr-email-result': 'rejected' } });
      },
      () => relay.email(email, env),
    );
    assert.match(email.rejection, /refused/);
  }
});
test('network or redirect rejection stays transient and unsafe origins are refused', async () => {
  await withFetch(
    async () => {
      throw new Error('redirect denied');
    },
    () => assert.rejects(relay.email(message(), env), /redirect denied/),
  );
  for (const API_ORIGIN of [
    'http://onmyradar.io',
    'https://user:pass@onmyradar.io',
    'https://onmyradar.io/path',
  ])
    await assert.rejects(relay.email(message(), { ...env, API_ORIGIN }), /configuration/);
});

test('missing or inconsistent application markers never acknowledge or reject mail', async () => {
  for (const [status, marker] of [
    [200, null],
    [403, null],
    [200, 'rejected'],
    [403, 'accepted'],
    [302, null],
  ]) {
    const email = message();
    await withFetch(
      async (_url, options) => {
        await consume(options);
        return new Response(null, {
          status,
          headers: marker ? { 'x-omr-email-result': marker } : {},
        });
      },
      () => assert.rejects(relay.email(email, env), /temporarily/),
    );
    assert.equal(email.rejection, null);
  }
});
