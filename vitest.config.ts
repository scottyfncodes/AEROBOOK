import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'server/**/*.test.ts'],
    setupFiles: ['src/test/setup.ts'],
    // The server tests share one Postgres database and reset it per test.
    fileParallelism: !process.env.TEST_DATABASE_URL,
  },
});
