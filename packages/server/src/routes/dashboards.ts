/** Dashboard tabs and their radar grid layouts. */
import { Hono } from 'hono';
import {
  createDashboardSchema,
  updateDashboardSchema,
  dashboardPreviewSchema,
} from '@onmyradar/contract';
import { readJson, requireActor, type AppEnv } from '../http.js';
import {
  createDashboard,
  previewDashboardQuery,
  dashboardWidgetResults,
  deleteDashboard,
  listDashboards,
  updateDashboard,
} from '../services/dashboards.js';

export const dashboardRoutes = new Hono<AppEnv>();

dashboardRoutes.get('/', async (c) => {
  const actor = requireActor(c);
  return c.json({ dashboards: await listDashboards(actor) });
});

dashboardRoutes.post('/', async (c) => {
  const actor = requireActor(c);
  const input = await readJson(c, createDashboardSchema);
  return c.json({ dashboard: await createDashboard(actor, input.name) }, 201);
});

dashboardRoutes.post('/preview', async (c) => {
  return c.json(
    await previewDashboardQuery(requireActor(c), await readJson(c, dashboardPreviewSchema)),
  );
});

dashboardRoutes.get('/:id/widgets/:widgetId/results', async (c) => {
  return c.json(
    await dashboardWidgetResults(requireActor(c), c.req.param('id'), c.req.param('widgetId')),
  );
});

dashboardRoutes.patch('/:id', async (c) => {
  const actor = requireActor(c);
  const input = await readJson(c, updateDashboardSchema);
  return c.json({ dashboard: await updateDashboard(actor, c.req.param('id'), input) });
});

dashboardRoutes.delete('/:id', async (c) => {
  const actor = requireActor(c);
  await deleteDashboard(actor, c.req.param('id'));
  return c.body(null, 204);
});
