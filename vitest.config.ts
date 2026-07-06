import { defineConfig } from 'vitest/config';

// Several suites spawn real child processes (npx tsx CLI, fake-claude) or use
// real timers (gateway, parallel-project). Running test files concurrently
// over-subscribes CPU and flakes them on timeout despite each passing in
// isolation. Serialize files for deterministic runs; tests within a file still
// run sequentially. Slower wall-time, but reliable — and this gates deploys.
export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
