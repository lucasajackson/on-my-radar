/**
 * The owner's side of integration credentials (`docs/HELPDESK.md` §3.4):
 * Settings → Connections and a helpdesk's "Client portal" control.
 *
 * Minting, rotation, revocation and enrolment are refused by the service for
 * anything that is not a signed-in person (`assertHumanDecision`); listing and
 * unenrolling are open to agents too, on REST and as MCP tools.
 */
import { Hono } from 'hono';
import {
  createIntegrationSchema,
  enrolRadarSchema,
  rotateIntegrationSchema,
  setIntegrationDeliverySchema,
} from '@onmyradar/contract';
import { readJson, requireActor, type AppEnv } from '../http.js';
import {
  kickIntegrationDeliveries,
  listIntegrationDeliveries,
  pauseIntegrationDelivery,
  resumeIntegrationDelivery,
  rotateIntegrationDeliverySecret,
  setIntegrationDelivery,
  testIntegrationDelivery,
} from '../services/integration-events.js';
import {
  createIntegration,
  enrolRadar,
  getIntegration,
  listIntegrations,
  revokeIntegration,
  revokePreviousToken,
  rotateIntegration,
  unenrolRadar,
} from '../services/integrations.js';

export const integrationRoutes = new Hono<AppEnv>();

integrationRoutes.get('/', async (c) =>
  c.json({ integrations: await listIntegrations(requireActor(c)) }),
);

integrationRoutes.post('/', async (c) =>
  c.json(
    {
      integration: await createIntegration(
        requireActor(c),
        await readJson(c, createIntegrationSchema),
      ),
    },
    201,
  ),
);

integrationRoutes.post('/:id/rotate', async (c) =>
  c.json({
    integration: await rotateIntegration(
      requireActor(c),
      c.req.param('id'),
      await readJson(c, rotateIntegrationSchema),
    ),
  }),
);

integrationRoutes.post('/:id/revoke-previous', async (c) =>
  c.json({ integration: await revokePreviousToken(requireActor(c), c.req.param('id')) }),
);

integrationRoutes.post('/:id/revoke', async (c) =>
  c.json({ integration: await revokeIntegration(requireActor(c), c.req.param('id')) }),
);

integrationRoutes.post('/:id/radars', async (c) =>
  c.json(
    {
      integration: await enrolRadar(
        requireActor(c),
        c.req.param('id'),
        await readJson(c, enrolRadarSchema),
      ),
    },
    201,
  ),
);

integrationRoutes.delete('/:id/radars/:radarId', async (c) =>
  c.json({
    integration: await unenrolRadar(requireActor(c), c.req.param('id'), c.req.param('radarId')),
  }),
);

/* ------------------------- events to the portal (§5.4) ------------------------- */

integrationRoutes.put('/:id/delivery', async (c) => {
  const actor = requireActor(c);
  const { url } = await readJson(c, setIntegrationDeliverySchema);
  const { secret } = await setIntegrationDelivery(actor, c.req.param('id'), url);
  const integration = await getIntegration(actor, c.req.param('id'));
  return c.json({ integration: secret ? { ...integration, deliverySecret: secret } : integration });
});

integrationRoutes.post('/:id/delivery/rotate-secret', async (c) => {
  const actor = requireActor(c);
  const { secret } = await rotateIntegrationDeliverySecret(actor, c.req.param('id'));
  const integration = await getIntegration(actor, c.req.param('id'));
  return c.json({ integration: { ...integration, deliverySecret: secret } });
});

integrationRoutes.post('/:id/delivery/pause', async (c) => {
  const actor = requireActor(c);
  await pauseIntegrationDelivery(actor, c.req.param('id'));
  return c.json({ integration: await getIntegration(actor, c.req.param('id')) });
});

integrationRoutes.post('/:id/delivery/resume', async (c) => {
  const actor = requireActor(c);
  await resumeIntegrationDelivery(actor, c.req.param('id'));
  kickIntegrationDeliveries();
  return c.json({ integration: await getIntegration(actor, c.req.param('id')) });
});

integrationRoutes.post('/:id/delivery/test', async (c) => {
  const actor = requireActor(c);
  await testIntegrationDelivery(actor, c.req.param('id'));
  kickIntegrationDeliveries();
  return c.json({ integration: await getIntegration(actor, c.req.param('id')) });
});

integrationRoutes.get('/:id/deliveries', async (c) =>
  c.json(await listIntegrationDeliveries(requireActor(c), c.req.param('id'))),
);
