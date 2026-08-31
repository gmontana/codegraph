# AGENTS.md

CodeGraph is a local-first code-intelligence library + CLI + MCP server: tree-sitter extraction into SQLite (FTS5), exposed to AI agents over MCP. TypeScript, Node >=20 (from source: >=22.5 for `node:sqlite`). Published as `@colbymchenry/codegraph`; CLI at `src/bin/codegraph.ts`, public API at `src/index.ts`.

**Read CLAUDE.md first — it is the detailed, maintained guide (architecture, module layout, benchmark methodology, cross-platform validation). This file only adds the quick reference.**

## Build & Run

```sh
npm run build      # tsc + copy schema.sql and *.wasm into dist/ (build = tsc && copy-assets && chmod)
npm run dev        # tsc --watch
npm run cli        # build then run local dist binary
npm run clean
```

No separate lint/typecheck script; `tsc` in the build is the type gate.

## Test

```sh
npm test                      # vitest run (all of __tests__/)
npm run test:watch
npx vitest run __tests__/extraction.test.ts          # single file
npx vitest run __tests__/extraction.test.ts -t "TypeScript"   # by name
npm run eval                  # builds, then evaluation runner (not part of npm test)
```

## Conventions

- Tests mirror the module they cover; real temp dirs + real SQLite, no DB mocking; cleanup in `afterEach`.
- Platform-differing behavior must be gated with `it.runIf(process.platform === 'win32'|...)`, never assumed.
- Regression suites are named after the PR/incident (`pr19-improvements.test.ts`) — do not rename.
- NodeKind/EdgeKind strings in `src/types.ts` are the contract; extractors and resolvers must use them exactly.

## Gotchas

- `copy-assets` (part of `build`) copies `src/db/schema.sql` and `src/extraction/wasm/*.wasm` into `dist/`. New SQL or grammar wasm that is not copied will not ship.
- Hard Node version gate: exits on Node <20 or 25.x (`src/bin/node-version-check.ts`).
- Don't commit `dist/`, `node_modules/`, or `.codegraph/` per-project indexes.
- Installer changes require matching coverage in `__tests__/installer-targets.test.ts` (~47 contract tests). See CLAUDE.md for the installer architecture and the Cursor `--path` cwd quirk.
- `src/mcp/server-instructions.ts` is the single source of truth for agent-facing tool guidance; keep it in sync with tool descriptions.
