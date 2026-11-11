import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Each integration worker owns a PostgreSQL pool and may create an isolated
    // database. CPU-count parallelism can exceed PostgreSQL's connection budget.
    // Smaller hosted runners (2 cores) set these lower and longer; the defaults are our CI's.
    maxWorkers: Number(process.env['VITEST_MAX_WORKERS'] ?? 4),
    testTimeout: Number(process.env['VITEST_TEST_TIMEOUT'] ?? 5000),
    // Suites that drive many bearer requests back to back would trip the production rate
    // limits, and suites that write then count expect exact counts; the suites that test the
    // limiter and the stats cache turn them on explicitly. The product default is open signup;
    // the suites that exercise the waitlist and approval flow were written against a queue.
    env: { RATE_LIMIT_ENABLED: 'false', STATS_CACHE_TTL_MS: '0', SIGNUP_MODE: 'waitlist' },
    // iCloud conflict copies ("x.test 2.ts") would run as duplicate suites.
    exclude: ['**/node_modules/**', '**/dist/**', '**/* 2.*'],
  },
});
