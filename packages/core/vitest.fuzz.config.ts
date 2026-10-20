/// <reference types="vitest" />

import { defineConfig } from 'vitest/config'
import base from './vitest.config'

/** Long fuzzing runs, `npm run test:fuzz`. Set here rather than in the script so it works on Windows too. */
export default defineConfig({
    ...base,
    test: {
        ...base.test,
        include: ['tests/fuzz.test.ts', 'tests/trie.test.ts', 'tests/differential.test.ts'],
        env: { FUZZ_RUNS: process.env.FUZZ_RUNS ?? '20000' },
        testTimeout: 900_000,
    },
})
