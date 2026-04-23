# Contributing to Keddy

Thank you for your interest in contributing to Keddy!

## Scope of contributions

The following types of contributions can be submitted directly via pull requests:

- **Isolated additions** that extend Keddy along existing lines — a new MCP tool following the existing pattern, a new milestone regex, a new CLI subcommand.
- **Small bug fixes** in the capture pipeline, parser, analyzers, dashboard, or MCP server.
- **Documentation improvements** — README clarifications, ARCHITECTURE.md corrections, typo fixes.
- **Performance improvements** that preserve Keddy's correctness guarantees (idempotency, deterministic analysis, full-reparse convergence).

For other changes — rethinking a subsystem, changing the database schema, adding a new capture surface beyond the existing hooks/MCP/dashboard — please open an issue first to discuss with the maintainers.

When submitting a PR, ensure a well-defined scope. Every PR should cover a single logical change or a set of closely related changes.

## Extending Keddy along existing lines

**Adding an MCP tool.** All tools are registered in `src/mcp/tools.ts` via `server.tool(name, description, zodSchema, handler)`. Prefer reusing prepared statements from `src/db/queries.ts` over writing ad-hoc SQL.

**Adding a milestone type.** Extend the regex patterns in `src/capture/milestones.ts` and add a fixture under `tests/fixtures/` with the Bash tool input that should trigger it.

**Adding a dashboard view.** Routes live in `src/dashboard/routes/`, React views in `src/dashboard/app/`. The dashboard is read-only against the database — all writes flow through the capture pipeline.

## Development setup

Keddy runs on Node 22 (not 24 — native modules don't match yet).

```bash
git clone https://github.com/emiraksay/keddy.git
cd keddy
npm install
```

## Useful commands

- `npm test` — run the vitest suite
- `npm run typecheck` — TypeScript strict check
- `npm run build` — build CLI + dashboard bundles
- `npm run dev` — watch mode for CLI, server, and dashboard

## Testing capture without a full Claude Code session

The parser can be exercised directly against fixture JSONL files in `tests/fixtures/`. See `tests/capture/parser.test.ts` for examples — you don't need a running Claude Code session to test parsing logic.

## Security issues

See [docs/SECURITY.md](docs/SECURITY.md) — report privately, don't open a public issue.
