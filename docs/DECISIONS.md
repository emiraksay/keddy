# Technical Decisions

This doc explains the big architectural and product choices behind Keddy. For *how* the system is built, see [ARCHITECTURE.md](ARCHITECTURE.md).

## Session intelligence, not a memory layer

Keddy captures and organizes sessions after they happen. It does not inject context into Claude's prompts.

The memory-tool space (Mem0, Zep, Claude-Mem) competes with Claude Code's built-in compaction by stuffing retrieved context back into the system prompt. That's a different product. Session intelligence is structured recall on demand — you or your agent decide what to pull, when. Sessions are the richest unit of context Claude Code produces (plans with your feedback, exchanges with tool calls, git events), and memory summaries throw most of that away.

## Programmatic-first, AI-optional

Every core feature runs without an API key. Plan extraction, work-phase detection, code-event extraction, and full-text search are all deterministic. The optional AI layer (session notes, daily notes, activity analysis) only enhances — it never gates.

This means Keddy is reproducible (re-running analysis on the same JSONL produces identical results), free forever for anyone who doesn't want to spend on AI, and immune to model-availability issues for its core value.

## Local-first, no cloud

Your database lives at `~/.keddy/keddy.db` on your machine. No accounts, no sync, no telemetry. When AI analysis is enabled, prompts go directly to your provider with your API key — Keddy never sits in the middle.

Local-first rules out an entire class of privacy concerns. It also rules out some features (cross-device sync, team dashboards) that we'll address in a hosted tier later, not by compromising the local product.

## Full re-parse on `SessionEnd`

When a Claude Code session exits, Keddy deletes every row for that session and rebuilds from the JSONL. The JSONL is the source of truth; the database is always derivable.

This costs ~500ms at session end for a 100-exchange session, and buys correctness: partial hook writes, schema migrations, and even manual `keddy reimport` runs always converge on the same final state. Idempotency throughout.

## Single SQLite file for all projects

Every session across every project lives in one `~/.keddy/keddy.db`. This enables cross-project search, cross-project daily notes, and "recent activity" across your whole workflow.

The tradeoff: one file to back up, one writer at a time (WAL serializes), no team sharing. Those limits are fine for the solo-developer case we're optimizing for. Team features come later as a hosted tier, not by bending the local product.

## In-process MCP for Keddy's own AI agents

When Keddy generates a session note or daily note, the agent uses the *same* 11 MCP tools that Claude Code uses — but in-process, no subprocess. Saves ~3 seconds of startup per agent invocation, and more importantly, the agent's tool surface is identical to a human user's. The feedback loop is symmetric.

## SQLite over a real database

SQLite has zero config, one file, WAL mode for concurrent reads, FTS5 for search, and a mature synchronous driver (`better-sqlite3`). For a single-machine workload, anything else would be over-engineering. When we add a hosted tier, the hosted storage is a separate decision.

## Four hooks, not one or ten

| Hook | Why this one |
|---|---|
| `SessionStart` (sync) | The one place Keddy can inject project context into Claude's system prompt. Must be sync to return `additionalContext` before the session opens. |
| `Stop` (async) | Per-turn capture. Async so it never blocks Claude. |
| `PostCompact` (async) | Records compaction events so the dashboard can show where context was trimmed. |
| `SessionEnd` (async) | Full re-parse + programmatic analysis at close. The correctness anchor. |

Fewer hooks would leave gaps (no compaction events, no per-turn capture). More hooks would duplicate data without adding correctness.

## Apache 2.0 license

Permissive enough for adoption, patent protection for contributors, compatible with enterprise policies. No surprises.
