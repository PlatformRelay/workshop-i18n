import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * CI runs `install -> lint -> typecheck -> test` with no build step, so a workspace
 * package that imports a sibling by its published name would otherwise resolve to a
 * `dist/` that does not exist yet. Aliasing the published names onto their sources
 * keeps `pnpm test` a pure function of the working tree (constitution IV) instead of
 * a function of whatever was last compiled.
 *
 * Each package's own `tsconfig.json` carries the matching `paths` entry for `tsc --noEmit`;
 * `tsconfig.build.json` clears it, so the *published* build still resolves through
 * `node_modules` and cannot silently ship a deep import into a sibling's sources.
 */
const source = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url))

export default defineConfig({
  resolve: {
    // Exact matches only. A bare string alias matches by *prefix*, so the object form
    // pins the whole specifier and a future `@workshop-i18n/core-something` cannot be
    // silently rewritten into core's entry point.
    alias: [
      {
        find: /^@workshop-i18n\/core$/,
        replacement: source('./packages/core/src/index.ts'),
      },
    ],
  },
})
