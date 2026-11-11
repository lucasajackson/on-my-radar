/**
 * The Agent Repo over REST. Thin: every handler parses and calls the same
 * service function the MCP tool calls, with the same `Actor`, so the two
 * transports cannot disagree. Human-only acts are refused in the services by
 * `assertHumanDecision`, not here — a route guard would protect this path and
 * nothing else. The two credential endpoints are also session-only
 * (`requireUser`), the tokens route's rule: a bearer token never lists or mints
 * credentials.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import {
  activitySchema,
  briefBindingSchema,
  briefRevisionsSchema,
  checkoutSchema,
  createRepoAgentSchema,
  followUpdatesSchema,
  forgetSchema,
  getBriefSchema,
  importAgentSchema,
  loadAgentSchema,
  MAX_REVISION,
  agentEditsLiveSchema,
  lockPromptSchema,
  setAgentRadarsSchema,
  queryBooleanSchema,
  promptHistorySchema,
  recallSchema,
  rememberSchema,
  renameBriefSchema,
  setProfileSchema,
  tokenExpiryDaysSchema,
  shareAgentSchema,
  transferAgentSchema,
  updateBriefSchema,
  updatePromptSchema,
  updateRepoAgentSchema,
  updateShareSchema,
} from '@onmyradar/contract';
import {
  badRequest,
  readJson,
  readQuery,
  requireActor,
  requireUser,
  type AppEnv,
} from '../http.js';
import {
  forget,
  observeSessions,
  loadAgent,
  memoryRevisions,
  pinMemory,
  recallPage,
  remember,
  restoreMemory,
} from '../services/agent-memory.js';
import { listModels } from '../services/model-catalog.js';
import {
  acceptShare,
  acceptTransfer,
  agentActivity,
  agentConnections,
  cancelTransfer,
  checkoutAgent,
  createRepoAgent,
  declineTransfer,
  deleteRepoAgent,
  duplicateAgent,
  exportAgent,
  deleteBrief,
  getBrief,
  acceptPromptProposal,
  getPromptVersion,
  listPromptProposals,
  rejectPromptProposal,
  getRepoAgent,
  handleAvailable,
  importAgent,
  leaveShare,
  listBriefRevisions,
  listBriefs,
  listProfiles,
  listPromptVersions,
  listRepoAgents,
  listShares,
  mintAgentToken,
  offerTransfer,
  promoteMemoryToBlip,
  removeBriefBinding,
  removeProfile,
  setArchived,
  setBriefBinding,
  setFollow,
  setAgentRadars,
  setAgentEditsLive,
  setLocked,
  setProfile,
  shareAgent,
  takeUpdate,
  unshareAgent,
  renameBrief,
  updateBrief,
  updatePrompt,
  updateRepoAgent,
  updateShare,
} from '../services/repo-agents.js';

export const repoAgentRoutes = new Hono<AppEnv>();

function versionParam(raw: string): number | undefined {
  if (raw === 'live') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_REVISION)
    throw badRequest('A prompt version is a positive integer');
  return n;
}

function subjectTypeParam(raw: string): 'user' | 'topic' {
  if (raw !== 'user' && raw !== 'topic') throw badRequest('A share is for a user or an array');
  return raw;
}

const listQuerySchema = z.object({
  view: z.enum(['mine', 'shared', 'archived']).optional(),
  /** v1's spelling, still sent by cached clients: `archived=true` is the archived view. */
  archived: queryBooleanSchema.optional(),
});

repoAgentRoutes.get('/', async (c) => {
  const actor = requireActor(c);
  const { view, archived } = readQuery(c, listQuerySchema);
  return c.json({
    agents: await listRepoAgents(actor, { view: view ?? (archived ? 'archived' : undefined) }),
  });
});

repoAgentRoutes.get('/handles/:handle', async (c) => {
  const actor = requireActor(c);
  return c.json(await handleAvailable(actor, c.req.param('handle')));
});

repoAgentRoutes.post('/', async (c) => {
  const actor = requireActor(c);
  const input = await readJson(c, createRepoAgentSchema);
  return c.json({ agent: await createRepoAgent(actor, input) }, 201);
});

repoAgentRoutes.post('/import', async (c) => {
  const actor = requireActor(c);
  const input = await readJson(c, importAgentSchema);
  return c.json({ agent: await importAgent(actor, input) }, 201);
});

repoAgentRoutes.get('/:id', async (c) => {
  const actor = requireActor(c);
  return c.json({ agent: await getRepoAgent(actor, c.req.param('id')) });
});

repoAgentRoutes.patch('/:id', async (c) => {
  const actor = requireActor(c);
  const input = await readJson(c, updateRepoAgentSchema);
  return c.json({ agent: await updateRepoAgent(actor, c.req.param('id'), input) });
});

repoAgentRoutes.delete('/:id', async (c) => {
  const actor = requireActor(c);
  await deleteRepoAgent(actor, c.req.param('id'));
  return c.body(null, 204);
});

repoAgentRoutes.put('/:id/archived', async (c) => {
  const actor = requireActor(c);
  const { archived } = await readJson(c, z.object({ archived: z.boolean() }));
  return c.json({ agent: await setArchived(actor, c.req.param('id'), archived) });
});

repoAgentRoutes.put('/:id/lock', async (c) => {
  const actor = requireActor(c);
  const { locked } = await readJson(c, lockPromptSchema);
  return c.json({ agent: await setLocked(actor, c.req.param('id'), locked) });
});

repoAgentRoutes.put('/:id/agent-edits', async (c) => {
  const actor = requireActor(c);
  const { live } = await readJson(c, agentEditsLiveSchema);
  return c.json({ agent: await setAgentEditsLive(actor, c.req.param('id'), live) });
});

repoAgentRoutes.put('/:id/radars', async (c) => {
  const actor = requireUser(c);
  const input = await readJson(c, setAgentRadarsSchema);
  return c.json({ agent: await setAgentRadars(actor, c.req.param('id'), input) });
});

repoAgentRoutes.post('/:id/duplicate', async (c) => {
  const actor = requireActor(c);
  return c.json({ agent: await duplicateAgent(actor, c.req.param('id')) }, 201);
});

/* --------------------------------- prompts -------------------------------- */

repoAgentRoutes.get('/:id/prompts', async (c) => {
  const actor = requireActor(c);
  return c.json(
    await listPromptVersions(actor, c.req.param('id'), readQuery(c, promptHistorySchema)),
  );
});

repoAgentRoutes.get('/:id/prompts/:version', async (c) => {
  const actor = requireActor(c);
  return c.json({
    prompt: await getPromptVersion(actor, c.req.param('id'), versionParam(c.req.param('version'))),
  });
});

repoAgentRoutes.post('/:id/prompts', async (c) => {
  const actor = requireActor(c);
  const input = await readJson(c, updatePromptSchema);
  const result = await updatePrompt(actor, c.req.param('id'), input);
  // Held for the owner (ADR-0029): accepted for review, not created.
  return 'proposalId' in result ? c.json(result, 202) : c.json({ prompt: result }, 201);
});

/* ---------------------------- prompt proposals ---------------------------- */

repoAgentRoutes.get('/:id/prompt-proposals', async (c) => {
  const actor = requireActor(c);
  return c.json({ proposals: await listPromptProposals(actor, c.req.param('id')) });
});

repoAgentRoutes.post('/:id/prompt-proposals/:proposalId/accept', async (c) => {
  const actor = requireActor(c);
  return c.json({
    prompt: await acceptPromptProposal(actor, c.req.param('id'), c.req.param('proposalId')),
  });
});

repoAgentRoutes.post('/:id/prompt-proposals/:proposalId/reject', async (c) => {
  const actor = requireActor(c);
  await rejectPromptProposal(actor, c.req.param('id'), c.req.param('proposalId'));
  return c.body(null, 204);
});

/* ------------------------------ tool profiles ----------------------------- */

repoAgentRoutes.get('/:id/profiles', async (c) => {
  const actor = requireActor(c);
  return c.json({ profiles: await listProfiles(actor, c.req.param('id')) });
});

repoAgentRoutes.put('/:id/profiles/:harness', async (c) => {
  const actor = requireActor(c);
  const input = await readJson(c, setProfileSchema);
  return c.json({
    profile: await setProfile(actor, c.req.param('id'), c.req.param('harness'), input),
  });
});

repoAgentRoutes.delete('/:id/profiles/:harness', async (c) => {
  const actor = requireActor(c);
  const { session } = readQuery(c, z.object({ session: z.string().uuid().optional() }));
  await removeProfile(actor, c.req.param('id'), c.req.param('harness'), session);
  return c.body(null, 204);
});

/* --------------------------------- briefs --------------------------------- */

repoAgentRoutes.get('/:id/briefs', async (c) => {
  const actor = requireActor(c);
  return c.json({ briefs: await listBriefs(actor, c.req.param('id')) });
});

repoAgentRoutes.get('/:id/briefs/:name', async (c) => {
  const actor = requireActor(c);
  const { revision } = readQuery(c, getBriefSchema);
  return c.json({
    brief: await getBrief(actor, c.req.param('id'), c.req.param('name'), revision),
  });
});

repoAgentRoutes.put('/:id/briefs/:name', async (c) => {
  const actor = requireActor(c);
  const input = await readJson(c, updateBriefSchema);
  const result = await updateBrief(actor, c.req.param('id'), c.req.param('name'), input);
  return c.json(result, result.created ? 201 : 200);
});

repoAgentRoutes.get('/:id/briefs/:name/revisions', async (c) => {
  const actor = requireActor(c);
  const input = readQuery(c, briefRevisionsSchema);
  return c.json(await listBriefRevisions(actor, c.req.param('id'), c.req.param('name'), input));
});

repoAgentRoutes.post('/:id/briefs/:name/rename', async (c) => {
  const actor = requireActor(c);
  const input = await readJson(c, renameBriefSchema);
  return c.json({
    brief: await renameBrief(actor, c.req.param('id'), c.req.param('name'), input),
  });
});

repoAgentRoutes.put('/:id/briefs/:name/binding', async (c) => {
  const actor = requireActor(c);
  const input = await readJson(c, briefBindingSchema);
  return c.json({
    stale: await setBriefBinding(actor, c.req.param('id'), c.req.param('name'), input),
  });
});

repoAgentRoutes.delete('/:id/briefs/:name/binding', async (c) => {
  const actor = requireActor(c);
  await removeBriefBinding(actor, c.req.param('id'), c.req.param('name'));
  return c.body(null, 204);
});

repoAgentRoutes.delete('/:id/briefs/:name', async (c) => {
  const actor = requireActor(c);
  await deleteBrief(actor, c.req.param('id'), c.req.param('name'));
  return c.body(null, 204);
});

/* ------------------------------ load & memory ----------------------------- */

repoAgentRoutes.post('/:id/load', async (c) => {
  const actor = requireActor(c);
  const input = await readJson(c, loadAgentSchema);
  return c.json({ loaded: await loadAgent(actor, c.req.param('id'), input) });
});

repoAgentRoutes.get('/:id/sessions', async (c) => {
  const actor = requireActor(c);
  c.header('Cache-Control', 'no-store');
  return c.json(await observeSessions(actor, c.req.param('id')));
});

repoAgentRoutes.get('/:id/activity', async (c) => {
  const actor = requireActor(c);
  return c.json(await agentActivity(actor, c.req.param('id'), readQuery(c, activitySchema)));
});

repoAgentRoutes.get('/:id/memories', async (c) => {
  const actor = requireActor(c);
  const input = readQuery(c, recallSchema);
  return c.json(await recallPage(actor, c.req.param('id'), input));
});

repoAgentRoutes.post('/:id/memories', async (c) => {
  const actor = requireActor(c);
  const input = await readJson(c, rememberSchema);
  const result = await remember(actor, c.req.param('id'), input);
  return c.json(result, result.created ? 201 : 200);
});

repoAgentRoutes.post('/:id/memories/forget', async (c) => {
  const actor = requireActor(c);
  const input = await readJson(c, forgetSchema);
  return c.json({ memory: await forget(actor, c.req.param('id'), input) });
});

repoAgentRoutes.get('/:id/memories/:memoryId/revisions', async (c) => {
  const actor = requireActor(c);
  return c.json({
    revisions: await memoryRevisions(actor, c.req.param('id'), c.req.param('memoryId')),
  });
});

repoAgentRoutes.post('/:id/memories/:memoryId/restore', async (c) => {
  const actor = requireActor(c);
  return c.json({ memory: await restoreMemory(actor, c.req.param('id'), c.req.param('memoryId')) });
});

repoAgentRoutes.put('/:id/memories/:memoryId/pin', async (c) => {
  const actor = requireActor(c);
  const { pinned } = await readJson(c, z.object({ pinned: z.boolean() }));
  return c.json({
    memory: await pinMemory(actor, c.req.param('id'), c.req.param('memoryId'), pinned),
  });
});

repoAgentRoutes.post('/:id/memories/:memoryId/promote', async (c) => {
  const actor = requireActor(c);
  const { radarId } = await readJson(c, z.object({ radarId: z.string().uuid() }));
  return c.json(
    { blip: await promoteMemoryToBlip(actor, c.req.param('id'), c.req.param('memoryId'), radarId) },
    201,
  );
});

/* ---------------------------- checkout & export --------------------------- */

repoAgentRoutes.get('/:id/checkout', async (c) => {
  const actor = requireActor(c);
  const input = readQuery(c, checkoutSchema);
  return c.json({ checkout: await checkoutAgent(actor, c.req.param('id'), input) });
});

repoAgentRoutes.get('/:id/export', async (c) => {
  const actor = requireActor(c);
  return c.json({ agent: await exportAgent(actor, c.req.param('id')) });
});

/* --------------------------------- sharing -------------------------------- */

repoAgentRoutes.get('/:id/shares', async (c) => {
  const actor = requireActor(c);
  return c.json({ shares: await listShares(actor, c.req.param('id')) });
});

repoAgentRoutes.post('/:id/shares', async (c) => {
  const actor = requireActor(c);
  const input = await readJson(c, shareAgentSchema);
  return c.json({ share: await shareAgent(actor, c.req.param('id'), input) }, 201);
});

repoAgentRoutes.patch('/:id/shares/:type/:subjectId', async (c) => {
  const actor = requireActor(c);
  const input = await readJson(c, updateShareSchema);
  return c.json({
    share: await updateShare(
      actor,
      c.req.param('id'),
      subjectTypeParam(c.req.param('type')),
      c.req.param('subjectId'),
      input,
    ),
  });
});

repoAgentRoutes.delete('/:id/shares/:type/:subjectId', async (c) => {
  const actor = requireActor(c);
  await unshareAgent(
    actor,
    c.req.param('id'),
    subjectTypeParam(c.req.param('type')),
    c.req.param('subjectId'),
  );
  return c.body(null, 204);
});

repoAgentRoutes.post('/:id/accept', async (c) => {
  const actor = requireActor(c);
  return c.json({ agent: await acceptShare(actor, c.req.param('id')) });
});

repoAgentRoutes.delete('/:id/accept', async (c) => {
  const actor = requireActor(c);
  await leaveShare(actor, c.req.param('id'));
  return c.body(null, 204);
});

repoAgentRoutes.post('/:id/update', async (c) => {
  const actor = requireActor(c);
  return c.json({ agent: await takeUpdate(actor, c.req.param('id')) });
});

repoAgentRoutes.put('/:id/follow', async (c) => {
  const actor = requireActor(c);
  const { follow } = await readJson(c, followUpdatesSchema);
  return c.json({ agent: await setFollow(actor, c.req.param('id'), follow) });
});

/* -------------------------------- ownership ------------------------------- */

repoAgentRoutes.post('/:id/transfer', async (c) => {
  const actor = requireActor(c);
  const { email } = await readJson(c, transferAgentSchema);
  return c.json({ agent: await offerTransfer(actor, c.req.param('id'), email) });
});

repoAgentRoutes.delete('/:id/transfer', async (c) => {
  const actor = requireActor(c);
  return c.json({ agent: await cancelTransfer(actor, c.req.param('id')) });
});

repoAgentRoutes.post('/:id/transfer/accept', async (c) => {
  const actor = requireActor(c);
  return c.json({ agent: await acceptTransfer(actor, c.req.param('id')) });
});

repoAgentRoutes.post('/:id/transfer/decline', async (c) => {
  const actor = requireActor(c);
  await declineTransfer(actor, c.req.param('id'));
  return c.body(null, 204);
});

/* ------------------------------- connections ------------------------------ */

repoAgentRoutes.get('/:id/connections', async (c) => {
  const actor = requireUser(c);
  return c.json(await agentConnections(actor, c.req.param('id')));
});

repoAgentRoutes.post('/:id/connections', async (c) => {
  const actor = requireUser(c);
  const { name, expiresInDays } = await readJson(
    c,
    z.object({ name: z.string().trim().min(1).max(80), expiresInDays: tokenExpiryDaysSchema }),
  );
  return c.json(
    { token: await mintAgentToken(actor, c.req.param('id'), name, expiresInDays) },
    201,
  );
});

/* ---------------------------------- models -------------------------------- */

export const modelRoutes = new Hono<AppEnv>();

modelRoutes.get('/', async (c) => {
  requireActor(c);
  const { harness } = readQuery(c, z.object({ harness: z.string().max(40).optional() }));
  return c.json({ models: await listModels(harness) });
});
