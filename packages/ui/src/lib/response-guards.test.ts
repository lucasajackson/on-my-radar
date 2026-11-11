import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import { guards } from './response-guards';

afterEach(() => vi.unstubAllGlobals());

const respondWith = (body: unknown) =>
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async () => new Response(JSON.stringify(body), { status: 200 })),
  );

const agent = { id: 'a1', name: 'Architect', revision: 3, promptVersion: 2 };

describe('responses whose fields are written back', () => {
  it('refuses an agent without a revision, before a save could go out without its check', async () => {
    // The server skips the concurrency check when expectedRevision is absent,
    // so this is the shape that would turn the next save into an overwrite.
    respondWith({ agent: { ...agent, revision: undefined } });
    const failure = api.agentRepo.get('a1');
    await expect(failure).rejects.toThrow(/nothing was saved/);
    await expect(failure).rejects.toMatchObject({ code: 'unexpected_response' });
  });

  it('passes a well-formed agent through unchanged', async () => {
    respondWith({ agent });
    await expect(api.agentRepo.get('a1')).resolves.toEqual({ agent });
  });

  it('checks every memory on a page, and the cursor', async () => {
    const memory = { id: 'm1', revision: 1 };
    expect(guards.memoryPage({ memories: [memory], nextCursor: null })).toBe(true);
    expect(guards.memoryPage({ memories: [memory], nextCursor: 'c1' })).toBe(true);
    expect(guards.memoryPage({ memories: [memory, { id: 'm2' }], nextCursor: null })).toBe(false);
    expect(guards.memoryPage({ memories: [memory] })).toBe(false);
  });

  it('checks the revision a brief edit is based on, on every brief and in the history', async () => {
    const brief = { name: 'commander', revision: 3, newerRevision: null };
    expect(guards.briefs({ briefs: [brief, { ...brief, newerRevision: 5 }] })).toBe(true);
    expect(guards.briefs({ briefs: [brief, { name: 'x', newerRevision: null }] })).toBe(false);
    expect(guards.brief({ brief: { ...brief, revision: '3' } })).toBe(false);
    expect(guards.briefSaved({ brief, created: false })).toBe(true);
    expect(guards.briefSaved({ brief })).toBe(false);
    expect(guards.briefRevisions({ revisions: [{ revision: 2 }], nextCursor: '2' })).toBe(true);
    expect(guards.briefRevisions({ revisions: [{}], nextCursor: null })).toBe(false);
    // A brief without its revision would turn the next save into a blind overwrite.
    respondWith({ brief: { name: 'commander', newerRevision: null } });
    await expect(api.agentRepo.brief('a1', 'commander')).rejects.toMatchObject({
      code: 'unexpected_response',
    });
  });

  it('checks the version a prompt edit is based on', () => {
    expect(guards.prompt({ prompt: { version: 2, basedOn: 1 } })).toBe(true);
    expect(guards.prompt({ prompt: { version: 1, basedOn: null } })).toBe(true);
    expect(guards.prompt({ prompt: { version: '2', basedOn: 1 } })).toBe(false);
  });

  it('checks a dashboard revision, which a layout save sends back', async () => {
    respondWith({ dashboards: [{ id: 'd1', revision: -1 }] });
    await expect(api.dashboards.list()).rejects.toMatchObject({ code: 'unexpected_response' });
  });
});
