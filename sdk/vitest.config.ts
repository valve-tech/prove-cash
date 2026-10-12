import { defineConfig } from 'vitest/config'

/**
 * Source only.
 *
 * `dist` once held compiled copies of these tests, from before `tsconfig.build.json` excluded
 * them. Nothing regenerated those copies and nothing deleted them, so vitest ran every test twice
 * — once against the source and once against a build that could be arbitrarily old. The counts
 * looked healthy either way. Pin the glob so a stale artefact can never be mistaken for a pass.
 */
export default defineConfig({
  test: { include: ['src/**/*.test.ts'] },
})
