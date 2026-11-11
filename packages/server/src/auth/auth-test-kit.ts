/** An app on its own database, with env the test can swap (single-user and password suites). */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createApp } from '../app.js';
import { closeDb } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv, setEnvForTesting } from '../env.js';

export async function startAuthApp(initial: Record<string, string>) {
  const database = `omr_auth_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: process.env['DATABASE_URL'] });
  await admin.query(`CREATE DATABASE ${database}`);
  const url = new URL(process.env['DATABASE_URL'] ?? '');
  url.pathname = `/${database}`;
  const withEnv = (extra: Record<string, string>) =>
    setEnvForTesting(
      loadEnv({
        ...process.env,
        DATABASE_URL: url.toString(),
        SESSION_SECRET: 'auth-test-secret-not-used-anywhere-else',
        NODE_ENV: 'test',
        SINGLE_USER_EMAIL: '',
        PASSWORD_LOGIN_ENABLED: '',
        ...extra,
      }),
    );
  withEnv(initial);
  await runMigrations();
  return {
    app: createApp(),
    withEnv,
    async stop() {
      await closeDb();
      setEnvForTesting(null);
      await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
      await admin.end();
    },
  };
}

export const cookieOf = (res: Response, name: string) =>
  res.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${name}=`))
    ?.split(';')[0];

export const json = { 'content-type': 'application/json' };
