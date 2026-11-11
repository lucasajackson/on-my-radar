import assert from 'node:assert/strict';
import { test as nodeTest } from 'node:test';
import { assertLocalUrl, databaseUrls, effectiveHosts, mergeAppEnv } from './config.js';

// `node:test` returns a promise per test that the runner already tracks.
const test = (name: string, fn: () => void): void => void nodeTest(name, fn);

const refuses = (url: string, env: NodeJS.ProcessEnv = {}, message = /Refusing to run/) => {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    assert.throws(() => databaseUrls(url), message);
  } finally {
    for (const key of Object.keys(env)) {
      if (saved[key] === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = saved[key];
    }
  }
};

test('accepts the local hosts and normalises to the one it checked', () => {
  for (const url of [
    'postgres://postgres@localhost:55442/postgres',
    'postgres://postgres@127.0.0.1:55442/postgres',
    'postgres://postgres@[::1]:55442/postgres',
    'postgres://postgres@localhost:5432/postgres?host=/var/run/postgresql',
  ])
    assert.doesNotThrow(() => databaseUrls(url));
  const { admin, app } = databaseUrls('postgres://postgres@localhost:55442/other?sslmode=disable');
  assert.match(admin, /\/postgres$/);
  assert.match(app, /\/omr_loadtest$/);
});

test('refuses a remote host in the authority', () => {
  refuses('postgres://postgres@db.example.com:5432/postgres');
});

test('refuses ?host= and ?hostaddr= that override a localhost authority', () => {
  refuses('postgres://postgres@localhost/postgres?host=db.example.com');
  refuses('postgres://postgres@localhost/postgres?hostaddr=10.1.2.3');
  refuses('postgres://postgres@localhost/postgres?host=localhost,db.example.com');
});

test('refuses a URL with no host when PGHOST points elsewhere', () => {
  refuses('postgres:///postgres', { PGHOST: 'db.example.com' });
  // Not even a URL to the WHATWG parser; fail closed rather than let pg guess.
  refuses('postgres://postgres@/postgres', { PGHOST: '10.0.0.5' }, /Refusing|not a URL/);
  refuses('postgres:///postgres', { PGHOST: 'localhost', PGHOSTADDR: '10.0.0.5' });
});

test('accepts a hostless URL when PGHOST is local or unset', () => {
  assert.deepEqual(effectiveHosts(new URL('postgres:///postgres'), { PGHOST: '/tmp' }), ['/tmp']);
  assert.deepEqual(effectiveHosts(new URL('postgres:///postgres'), {}), ['localhost']);
});

test('refuses a service file, which can name any host', () => {
  refuses('postgres://postgres@localhost/postgres?service=prod', {}, /service/);
  refuses('postgres://postgres@localhost/postgres', { PGSERVICE: 'prod' }, /service/);
});

test('the app URL guard still refuses non-local hosts', () => {
  assert.throws(() => assertLocalUrl('https://onmyradar.io', 'the app URL'), /Refusing to run/);
});

test('--env cannot redirect the app to another database', () => {
  const base = {
    DATABASE_URL: 'postgres://postgres@host.docker.internal/omr_loadtest',
    PORT: '3500',
  };
  for (const key of [
    'DATABASE_URL',
    'database_url',
    'PGHOST',
    'PGHOSTADDR',
    'PGSERVICE',
    'REPLICA_DATABASE_URL',
    'DB_HOST',
    'POSTGRES_URL',
  ])
    assert.throws(
      () => mergeAppEnv(base, [`${key}=postgres://prod.example.com/x`]),
      /Refusing --env/,
    );
  // Ordinary tuning still works, and cannot touch the validated URL.
  const merged = mergeAppEnv(base, ['DB_POOL_MAX=3', 'RATE_LIMIT_ENABLED=false']);
  assert.equal(merged['DATABASE_URL'], base.DATABASE_URL);
  assert.equal(merged['DB_POOL_MAX'], '3');
});
