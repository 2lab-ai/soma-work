# Test File Organization

All test files for source code under `src/` live in sibling `__tests__/`
directories — never co-located next to the source file they exercise.

## Canonical location

- `src/foo/bar.ts` → `src/foo/__tests__/bar.test.ts`
- `src/slack/commands/usage-handler.ts` →
  `src/slack/commands/__tests__/usage-handler.test.ts`

Test files sit exactly one directory deeper than their subject, inside a
`__tests__/` folder that contains only tests.

Out of scope for this rule: `somalib/**` and `mcp-servers/**` — they have
their own layout. This rule governs `src/**` only.

## Naming

- **Single suite per source file**: `<source>.test.ts`
  — e.g. `event-store.test.ts` covers everything exported from `event-store.ts`.
- **Multiple suites per source file**: `<source>.<aspect>.test.ts`
  — e.g. `assistant-status-manager.heartbeat.test.ts`,
  `token-manager.refresh-diagnostics.test.ts`.

The aspect suffix is a short kebab-case noun describing what the suite
covers. It is mandatory only when there would otherwise be a filename
collision inside `__tests__/` (two sources producing the same target
basename). Existing examples:

- `src/metrics/__tests__/token-pricing.pricing.test.ts` +
  `src/metrics/__tests__/token-pricing.test.ts`
- `src/metrics/__tests__/report-aggregator.core.test.ts` +
  `src/metrics/__tests__/report-aggregator.test.ts`
- `src/slack/commands/__tests__/usage-handler.routing.test.ts` +
  `src/slack/commands/__tests__/usage-handler.test.ts`

## Fixtures and helpers

- **Fixtures** live next to the source under `__fixtures__/`, not inside
  `__tests__/`. Tests import them with one extra `..` segment, e.g.
  `import { snapshot } from '../__fixtures__/snapshots';` from inside
  `__tests__/`.
- **Shared test utilities** (mock handlers, factories, etc.) live under
  `src/test-utils/`. Tests import them via the normal `src/**` path
  resolution, e.g. `import { mockSession } from '../../test-utils/mock-session';`.

## Relative-path rule

A test file inside `__tests__/` is one directory deeper than the old
co-located location. Every relative module specifier must compensate with
one extra `..` segment. This applies to every form the TypeScript grammar
accepts:

| Form | Example (co-located → `__tests__/`) |
|---|---|
| `import ... from '...'` | `'./foo'` → `'../foo'` |
| `import type ... from '...'` | `'./types'` → `'../types'` |
| `typeof import('...')` | `typeof import('./x')` → `typeof import('../x')` |
| Dynamic `await import('...')` | `await import('./x')` → `await import('../x')` |
| `require('...')` | `require('./x')` → `require('../x')` |
| `vi.mock('...', factory)` | `vi.mock('./x', ...)` → `vi.mock('../x', ...)` |
| `vi.importActual('...')` | `vi.importActual('./x')` → `vi.importActual('../x')` |
| `importOriginal()` inside `vi.mock(import('...'), importOriginal)` | same rule applies to the nested specifier |

Bare specifiers (`'vitest'`, `'fs'`, `'node:path'`, `'somalib/...'`) are
module names, not relative paths — they stay unchanged regardless of
location.

### `__dirname` FS paths

When a test uses `__dirname` to reach files on disk (fixtures, prompt
text, etc.), the path is one directory deeper under `__tests__/`, so add
one more `..` segment:

```ts
// Co-located test (src/foo/bar.test.ts):
fs.readFileSync(path.join(__dirname, 'prompt', 'x.prompt'));

// Sibling __tests__ test (src/foo/__tests__/bar.test.ts):
fs.readFileSync(path.join(__dirname, '..', 'prompt', 'x.prompt'));
```

### Non-literal / computed specifiers — prohibited in tests

Every module specifier in a test file must be a plain string literal or a
no-substitution template literal. Template expressions with `${…}`,
identifiers, and concatenation expressions (`'./' + foo`) are prohibited
because automated refactors cannot safely rewrite them, and a
location-change refactor is inevitable whenever tests move.

If dynamic selection is genuinely required, hoist the possible targets
into a lookup table whose keys are string literals:

```ts
// Instead of: await import(`./topics/${name}`)
const topics = {
  foo: () => import('../topics/foo'),
  bar: () => import('../topics/bar'),
} as const;
await topics[name]();
```

## Configuration

No config changes are required when moving a test into `__tests__/`:

- **Vitest**: `vitest.config.ts` uses `include: ['src/**/*.test.ts', …]`
  which matches both co-located and `__tests__/` paths by glob-depth.
- **Biome**: `biome.json`'s `files.includes: ['src/**/*.ts', …]` matches
  all nested files; no per-path overrides.
- **TypeScript**: `tsconfig.json`'s `include: ['src/**/*']` matches all
  nested files.

## Rationale

Co-located tests confused tooling (coverage, file-counts, package
globs) that either wanted tests-only views or source-only views, and
forced every directory listing to show 2× the entries. Keeping every
test in a sibling `__tests__/` folder gives a clean, single-purpose
directory layout at every depth of the tree and lets us bulk-filter
tests with one unambiguous glob: `**/__tests__/**`.
