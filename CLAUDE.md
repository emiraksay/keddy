# Keddy — Project Instructions

## What is Keddy?

Session intelligence for Claude Code. Captures coding sessions via hooks, organizes transcripts into navigable timelines with plan version tracking, and provides MCP tools for Claude to search past sessions.

## Architecture

```
src/
├── types.ts           # Shared TypeScript interfaces
├── db/                # SQLite database layer (better-sqlite3)
│   ├── index.ts       # initDb(), getDb(), closeDb()
│   ├── schema.ts      # 12 tables + exchanges_fts (FTS5) + config + triggers
│   ├── migrations.ts  # Versioned schema migrations
│   └── queries.ts     # Prepared statements for all operations
├── capture/           # Session capture pipeline
│   ├── parser.ts      # JSONL transcript parser
│   ├── handler.ts     # Hook entry point (reads stdin, routes by event)
│   ├── plans.ts       # Plan extraction (EnterPlanMode/ExitPlanMode)
│   ├── segments.ts    # Segment detection (sliding window)
│   ├── activity-groups.ts # Activity group + boundary detection
│   ├── milestones.ts  # Milestone regex (git commit/push/PR/branch/test)
│   ├── tasks.ts       # TaskCreate/TaskUpdate extraction
│   ├── titles.ts      # Title derivation from first user prompt
│   └── github.ts      # Git remote URL parsing + URL construction
├── mcp/               # MCP server (11 tools)
│   ├── server.ts      # Stdio entry point
│   └── tools.ts       # Tool definitions (createKeddyMcpServer)
├── cli/               # CLI commands
│   ├── index.ts       # Entry point with command router
│   ├── init.ts        # Hook installation + DB init
│   ├── open.ts        # Dashboard server + browser open
│   ├── status.ts      # Health check
│   ├── config.ts      # Read/write ~/.keddy/config.json
│   ├── import.ts      # Historical session import
│   └── backfill.ts    # Re-parse existing sessions to latest schema
├── dashboard/         # Hono API + React frontend
│   ├── server.ts      # Hono app, port 3737
│   ├── server-dev.ts  # Dev entry alongside Vite
│   ├── routes/        # API routes (sessions, plans, notes, daily, projects, stats, analyze, config)
│   └── app/           # React SPA (Vite + Tailwind v4)
└── analysis/          # Optional AI analysis layer
    ├── index.ts            # Orchestrator
    ├── providers.ts        # Anthropic / OpenAI-compatible
    ├── titles.ts           # AI session titles
    ├── summaries.ts        # AI segment summaries
    ├── decisions.ts        # AI decision extraction
    ├── agent.ts            # Session notes generator (Agent SDK + in-process MCP)
    ├── daily-agent.ts      # Daily notes generator
    └── mermaid-generator.ts # Programmatic mermaid diagrams (no AI)
```

## npm Package

- **Published**: https://www.npmjs.com/package/keddy
- **Owner**: `emiraksay` on npm
- **Release flow**: Currently manual — `npm publish --access public` runs tests + build via `prepublishOnly`, then publishes
- **Tagging**: After a successful publish, tag the release commit with `git tag vX.Y.Z && git push --tags`
- **Future**: A `publish.yml` workflow that publishes automatically on tag push has not been added yet

## Key Conventions

- **Module format**: NodeNext (import with `.js` extensions)
- **Build**: tsup for CLI/server, Vite for dashboard frontend
- **Database**: Single SQLite file at `~/.keddy/keddy.db`, WAL mode
- **No AI required**: All core features are programmatic. AI is opt-in enhancement layer.
- **FTS5**: Full-text search on user prompts. Query sanitization strips quotes and wraps words.

## Database Schema

12 tables: `sessions`, `exchanges`, `tool_calls`, `plans`, `segments`, `milestones`, `decisions`, `compaction_events`, `tasks`, `session_links`, `session_notes`, `daily_notes`. Plus `exchanges_fts` (FTS5 virtual table over user_prompt + assistant_response, kept in sync via triggers) and `config` (key-value store). `decisions` is populated by the opt-in AI analysis layer; `session_notes` and `daily_notes` are populated by the AI notes generators.

## How Hooks Work

4 Claude Code hooks:
1. **SessionStart** (sync) — Upserts session, returns additionalContext
2. **Stop** (async) — Parses latest exchange from JSONL
3. **PostCompact** (async) — Stores compaction event
4. **SessionEnd** (async) — Full transcript parse + analysis

## Testing

```bash
npm test          # Run all tests
npm run test:watch # Watch mode
```

Tests use vitest. Fixtures in `tests/fixtures/`. Integration tests use real JSONL from `~/.claude/projects/` when available.

## What NOT to Do

- Don't add memory injection — Keddy is a session organizer, not a memory layer
- Don't require AI for any core functionality
- Don't modify Claude Code settings outside of `keddy init`
- Don't store sensitive data (API keys, credentials) in the database
