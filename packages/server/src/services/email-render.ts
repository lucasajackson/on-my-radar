import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { ApiError } from '../http.js';
import type { renderEmailHtml } from './email-html.js';

/** What email-render-worker.ts receives as workerData. */
export interface EmailRenderWorkerData {
  html: string;
  cidUrls: Array<[string, string]>;
  remote: boolean;
}

/** Image resolution reparses HTML in a bounded worker, keeping large newsletters off the API loop. */
export async function renderEmailHtmlIsolated(
  html: string,
  cidUrls: Map<string, string>,
  remote: boolean,
): Promise<ReturnType<typeof renderEmailHtml>> {
  const source = import.meta.url.endsWith('.ts');
  const url = new URL(
    source ? './email-render-worker.ts' : './email-render-worker.js',
    import.meta.url,
  );
  const options = {
    workerData: { html, cidUrls: [...cidUrls], remote } satisfies EmailRenderWorkerData,
    resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 },
    execArgv: [],
  };
  const worker = source
    ? new Worker(
        `require(${JSON.stringify(createRequire(import.meta.url).resolve('tsx/esm/api'))}).tsImport(${JSON.stringify(url.href)}, ${JSON.stringify(import.meta.url)})`,
        { ...options, eval: true },
      )
    : new Worker(url, options);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise((resolve, reject) => {
      const unavailable = () =>
        reject(
          new ApiError(
            503,
            'email_reader_unavailable',
            'The formatted email is temporarily unavailable.',
          ),
        );
      timeout = setTimeout(unavailable, 10000);
      worker.once('error', unavailable);
      worker.once('exit', unavailable);
      worker.once('message', resolve);
    });
  } finally {
    clearTimeout(timeout);
    await worker.terminate();
  }
}
