import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const here = dirname(fileURLToPath(import.meta.url))

// Standalone config for the CORS relay Worker. This directory is NOT part of
// the main app's vitest run (the root config's include globs only cover
// tests/vitest/** and src/**/__tests__/**). The worker tests exercise a plain
// exported fetch(request, env) function with a mocked global fetch, so the
// default node environment is sufficient — no cloudflare workers-pool needed.
export default defineConfig({
  root: here,
  test: {
    include: [resolve(here, `test/**/*.test.ts`)],
    environment: `node`,
  },
})
