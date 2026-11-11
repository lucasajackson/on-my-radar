import { parentPort, workerData } from 'node:worker_threads';
import { renderEmailHtml } from './email-html.js';
import type { EmailRenderWorkerData } from './email-render.js';

if (!parentPort) throw new Error('email-render-worker runs only as a worker thread');
// Spawned only by renderEmailHtmlIsolated, which builds this shape with
// `satisfies`; workerData is structured-cloned, so the cast is the boundary.
const input = workerData as EmailRenderWorkerData;
parentPort.postMessage(renderEmailHtml(input.html, new Map(input.cidUrls), input.remote));
