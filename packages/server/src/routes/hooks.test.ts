import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WEBHOOK } from '@onmyradar/contract';
import { hookRoutes } from './hooks.js';
import { ingestWebhook } from '../services/webhooks.js';

vi.mock('../services/webhooks.js', () => ({
  ingestWebhook: vi.fn().mockResolvedValue({ blipId: 'captured' }),
}));
vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), error: vi.fn() } }));

beforeEach(() => vi.clearAllMocks());

describe('webhook HTTP body parsing', () => {
  it('preserves case-sensitive multipart boundaries', async () => {
    const response = await hookRoutes.request('/hook/secret', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=MyMixedCaseBoundary' },
      body: '--MyMixedCaseBoundary\r\nContent-Disposition: form-data; name="message"\r\n\r\nHello\r\n--MyMixedCaseBoundary--\r\n',
    });
    expect(response.status).toBe(202);
    expect(ingestWebhook).toHaveBeenCalledWith(
      'hook',
      'secret',
      expect.objectContaining({
        shape: 'form',
        payload: { message: 'Hello' },
      }),
    );
  });

  it('stops reading an oversized chunked stream and never invokes capture', async () => {
    let pulls = 0;
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(8 * 1024));
        if (pulls >= (WEBHOOK.maxPayloadBytes / (8 * 1024)) * 4) controller.close();
      },
      cancel: cancelled,
    });
    const request = new Request('http://localhost/hook/secret', {
      method: 'POST',
      body,
      duplex: 'half',
    });
    const response = await hookRoutes.request(request);
    expect(response.status).toBe(413);
    expect(cancelled).toHaveBeenCalledOnce();
    expect(pulls).toBeLessThanOrEqual(WEBHOOK.maxPayloadBytes / (8 * 1024) + 2);
    expect(ingestWebhook).not.toHaveBeenCalled();
  });

  it('checks actual bytes even when the declared length is smaller', async () => {
    const response = await hookRoutes.request('/hook/secret', {
      method: 'POST',
      headers: { 'content-length': '1' },
      body: '😀'.repeat(WEBHOOK.maxPayloadBytes / 4 + 1),
    });
    expect(response.status).toBe(413);
    expect(ingestWebhook).not.toHaveBeenCalled();
  });

  it('accepts an exactly-at-limit UTF-8 body', async () => {
    const body = '😀'.repeat(WEBHOOK.maxPayloadBytes / 4);
    const response = await hookRoutes.request('/hook/secret', { method: 'POST', body });
    expect(response.status).toBe(202);
    expect(ingestWebhook).toHaveBeenCalledWith('hook', 'secret', {
      shape: 'text',
      payload: null,
      raw: body,
    });
  });
});
