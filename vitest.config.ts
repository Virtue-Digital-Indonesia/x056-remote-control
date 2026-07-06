import { defineConfig } from 'vitest/config';

// Several suites spawn real child processes (npx tsx CLI, fake-claude) and the
// gateway/parallel-project suites use real timers. Under an unbounded fork pool
// these contend for CPU and flake on timeout despite being correct in isolation.
// Cap parallelism for reliable, deterministic runs.
export default defineConfig({
  test: {
    pool: 'forks',
    poolOptions: { forks: { maxForks: 3, minForks: 1 } },
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
