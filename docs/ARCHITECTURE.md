# Keddy Architecture

Keddy is a local-first Node CLI that captures Claude Code coding sessions into SQLite, analyzes them deterministically, and exposes them to both you (through a dashboard) and your coding agent (through MCP tools). Four Claude Code hooks feed a single capture pipeline. A small set of programmatic analyzers turn raw exchanges into structured objects — plan versions with user feedback, work phases divided by plan mode and compaction boundaries, and code events extracted from git and test commands. An optional AI analysis layer produces session notes and daily notes using the Claude Agent SDK wired directly into Keddy's own MCP surface. Everything runs on your machine. Nothing is shipped outside unless you enable AI analysis and bring your own API key.

## Data flow

```
  ┌───────────────┐
  │ Claude Code   │
  │ JSONL         │
  └───────┬───────┘
          │
          ▼  (4 hook types)
  ┌───────────────────────────────────────┐
  │  capture/handler.ts                   │
  │    routes by hook type                │
  │    reads stdin, writes DB             │
  │    SessionStart: also writes stdout   │
  └──────────────────┬────────────────────┘
                     │
         ┌───────────┴───────────┐
         ▼                       ▼
  ┌─────────────┐         ┌──────────────┐
  │ parser.ts   │         │ plans.ts     │
  │ (exchanges, │         │ activity-    │   ◄── programmatic
  │ tool calls, │         │   groups.ts  │       analyzers
  │ fork data)  │         │ milestones.ts│
  └──────┬──────┘         └──────┬───────┘
         │                       │
         └───────────┬───────────┘
                     ▼
              ┌─────────────┐
              │  SQLite DB  │
              │  (WAL mode) │
              │  + FTS5     │
              └──────┬──────┘
                     │
      ┌──────────────┼──────────────┐
      ▼              ▼              ▼
  ┌────────┐   ┌──────────┐   ┌────────────┐
  │  CLI   │   │ MCP svr  │   │ Dashboard  │
  │ (init, │   │  (stdio  │   │ (Hono API  │
  │ open,  │   │   or in- │   │ + React,   │
  │ status)│   │  process)│   │ port 3737) │
  └────────┘   └────┬─────┘   └─────┬──────┘
                    ▲               │
                    │               │
                    └─ in-process ──┤
                                    ▼
                         ┌─────────────────────┐
                         │ analysis/agent.ts   │
                         │ daily-agent.ts      │   ◄── optional
                         │ titles, summaries   │       AI layer
                         │ (Agent SDK + MCP)   │
                         └─────────────────────┘
```

At a glance:

- Every Claude Code session writes an append-only JSONL transcript. Four hook types (`SessionStart`, `Stop`, `PostCompact`, `SessionEnd`) invoke Keddy's capture binary at different moments with the session ID and the path to that transcript.
- The capture binary routes by hook type to a parser and programmatic analyzers, which write to a single local SQLite file at `~/.keddy/keddy.db`.
- Three surfaces read from the DB: the CLI, the MCP server (for your agent), and the dashboard (for you). An optional AI analysis layer loops back through MCP — using Keddy's own tools to generate session and daily notes.

## 1. The capture pipeline

One binary (`src/capture/handler.ts`) is the entrypoint for all four hooks. Claude Code invokes it with the hook type as its first argument; session context arrives as JSON on stdin; the handler writes to SQLite, and — for `SessionStart` only — writes JSON back to stdout that Claude Code injects into the session's system prompt.

### The four hooks

| Hook | Trigger | Timing | stdin | stdout | DB work |
|---|---|---|---|---|---|
| `SessionStart` | Session opens | **Sync**, ~500ms | `session_id`, `cwd` | `{additionalContext: "..."}` — recent prompts, active plan, pending tasks, last milestone, latest session note | Upsert session row |
| `Stop` | Each turn ends (2s idle) | Async | `session_id`, `transcript_path` | — | Insert/update latest exchange + tool calls; extract new plans/milestones/tasks mid-session |
| `PostCompact` | Claude compacts context | Async | `session_id`, `compact_summary` | — | Insert compaction event |
| `SessionEnd` | Session exits | **Sync**, ~500ms for 100 exchanges | `session_id`, `transcript_path` | — | **Full re-parse + replace** — DELETEs all exchanges/tool_calls/plans/segments/milestones for this session, re-inserts from fresh parse, runs full programmatic analysis |

### Contract details

- stdin read times out at 5 seconds. If Keddy is slow, the hook returns without blocking the session.
- `SessionStart`'s `additionalContext` wraps recent prompts (last 3 concatenated with " → "), the active plan text with version and status, pending tasks, the last milestone, and the first 500 characters of the latest session note — then a hint that the agent can call `keddy_project_status` for more.
- The Stop hook has a built-in **1.5-second self-delay after its initial parse**, then re-parses just the `content_blocks` field. This handles JSONL-flush timing: Claude Code's writer doesn't always have the full turn on disk when Stop fires.
- `SessionEnd` skips its own work for Agent SDK sessions — detected heuristically by the first user prompt starting with *"Analyze the coding session"*. This prevents Keddy's own note-generation agents from being captured as user sessions.

### The JSONL parser (`src/capture/parser.ts`)

The Claude Code JSONL format is append-only lines of JSON, each tagged `user`, `assistant`, `progress`, `custom-title`, `system` (with subtypes `compact_boundary`, `turn_duration`), etc. The parser's job is to reconstruct **exchanges** (each bounded by a real user message) from that stream.

Key parsing rules:

- Exchanges are bounded by user messages. Tool results and image uploads don't start new exchanges — they merge into the current one.
- Tool calls in an assistant message are accumulated into `pendingToolCalls[]`, then matched with their results in the next user message's `tool_result` blocks.
- **Noise filtering**: `<system-reminder>` wrappers, `<task-notification>`, IDE metadata like `<ide_opened_file>` or `<bash-stdout>` with no real text, progress messages, and empty queue-operations are dropped. This is why the dashboard shows the real conversation, not the raw transcript.
- **Interrupts**: a user pressing Escape produces a `[Request interrupted by user]` message. The parser marks the exchange `is_interrupt=true` rather than starting a new exchange.
- **Content blocks**: each exchange stores a `content_blocks` JSON array of `{type, text?, tool_use_id?}` in order, preserving the exact sequence of text, reasoning, and tool use so the dashboard can replay a turn precisely.
- **Facts-first metadata**: model, token counts (input / output / cache read / cache write), stop reason, permission mode, cwd, git branch, and turn duration — all accumulated from assistant metadata and system entries.

### Fork detection

A forked Claude Code session is a session that branched off from another. Its first JSONL line embeds the full parent conversation (often 100KB+). The parser reads up to 1MB of that first line to pull the fork metadata, storing `forked_from` (parent session ID) and `fork_exchange_index` (where the child diverges). The dashboard, MCP tools, and AI analysis all carry fork awareness through to the user.

## 2. Programmatic analyzer

Three deterministic subsystems run at `SessionEnd` against the freshly parsed exchanges. No AI is called. Every output is reproducible from the JSONL alone.

### Plans (`src/capture/plans.ts`)

Plans are Claude Code's `ExitPlanMode` outputs — the drafted plans you approve, reject, or revise.

- Each `ExitPlanMode` tool call increments a version counter for that session.
- Plan text comes from `ExitPlanMode.input.plan`.
- **Status is inferred, not stored**:
  - Result contains "User has approved your plan" → `approved`
  - Result contains "doesn't want to proceed" → `rejected`, plus user feedback extracted from the result text (stripped of system notes, capped at 1000 characters)
  - A rejected plan with user feedback is rewritten as `revised` if a next version exists (user revised instead of abandoning)
  - A drafted/rejected plan becomes `approved` if it's the latest plan and subsequent Edit/Write/Bash tools exist (implicit approval)
  - Earlier approved plans get marked `superseded` by later ones
- Task extraction: `TaskCreate` and `TaskStop` calls that fall under an approved plan's exchange range become that plan's tasks.

This inference logic is the single most distinguishing part of Keddy's programmatic analysis — no other tool in the space reconstructs this state machine.

### Work phases (`src/capture/activity-groups.ts`, stored in the `segments` table)

A session is cut into contiguous work phases at **structural boundaries**. Boundaries are ordered by priority; the highest-priority candidate at each exchange wins.

Boundary types:

- `session_start` (exchange 0)
- `plan_mode` (when `EnterPlanMode`/`ExitPlanMode` appears)
- `compaction` (at a compaction event)
- `interrupt` (user pressed Escape)
- `branch_change` (git branch changed mid-session)
- `file_focus_shift` (the set of files worked on changes significantly)
- `long_pause` (>10 minutes between exchanges)
- `session_end`

Each phase accumulates: files read / files written (deduped sets), tool-use counts, error count, token counts (in / out / cache read), models used, and *markers* — git commits, pushes, PRs, tests, subagent calls, skill invocations — that happened inside that phase.

**Legacy note**: an older subsystem (`src/capture/segments.ts`) assigned each exchange a heuristic type (`planning`, `implementing`, `debugging`, etc.) based on tool distribution. It's kept in the code for backward UI compatibility but is no longer the primary analyzer.

### Code events (`src/capture/milestones.ts`, stored in the `milestones` table)

Regex extraction over Bash tool inputs.

| Event type | Pattern | Extracted fields |
|---|---|---|
| `commit` | `git commit -m "..."` (simple or heredoc) | Commit message (first line if heredoc) |
| `push` | `git push ...` | Remote + branch |
| `pull` | `git pull ...` | Remote + branch |
| `pr` | `gh pr create ...` | PR title from `--title`; PR number from tool result if present |
| `branch` | `git checkout -b <name>` / `git switch -c <name>` | Branch name |
| `test_pass` / `test_fail` | `npm test`, `pytest`, `cargo test`, `go test`, `vitest`, `jest` | Pass / fail counts + first failing test name (parsed from stdout) |

False-positive rejection: if the bash command contains SQL-like text that merely includes the words "git push", or the tool call errored, the match is skipped. Duplicates are suppressed via compound UNIQUE indexes (commits dedupe on exact message; other events dedupe on type + exchange index + description).

## 3. The database

A single SQLite file at `~/.keddy/keddy.db` in WAL mode. Ten content tables plus an FTS5 virtual table plus a key-value config table.

### Tables

| Table | Purpose |
|---|---|
| `sessions` | One row per Claude Code session. Stores project path, branch, title, timestamps, exchange count, fork metadata, entrypoint. |
| `exchanges` | One row per turn. Unique on `(session_id, exchange_index)`. Stores prompt, full response, tool_call_count, timestamp, is_interrupt, model, token counts, stop_reason, permission mode, cwd, branch, turn duration, content_blocks. |
| `tool_calls` | One row per tool use. Unique on `(session_id, tool_use_id)`. Stores tool_name, tool_input, tool_result, is_error, duration, plus **facts-first enrichment** columns (`file_path`, `bash_command`, `skill_name`, `subagent_type`, `web_query`, `web_url`) pattern-extracted from tool input at write time. |
| `plans` | One row per plan version. Unique on `(session_id, version)`. Stores text, status, user_feedback, exchange range, created_at. |
| `segments` | One row per work phase (and legacy heuristic segment). Stores type, exchange range, files touched, tool counts, boundary type, token totals, markers, optional AI label/summary. |
| `milestones` | One row per code event. Two UNIQUE indexes prevent duplicates. |
| `tasks` | One row per task created by `TaskCreate`. FK to session and plan. |
| `decisions` | Optional AI-extracted key decisions. |
| `compaction_events` | One row per `PostCompact` firing. |
| `session_links` | Fork relationships: parent session ↔ child session + divergence exchange. |
| `session_notes`, `daily_notes` | AI-generated notes: session-scoped and day-scoped. |
| `config` | Key-value runtime config. Most config lives in `~/.keddy/config.json` instead. |

### Search: `exchanges_fts`

FTS5 virtual table over `user_prompt` and `assistant_response`. Kept in sync with `exchanges` via three triggers (insert / update / delete). User queries are sanitized — quotes stripped, words wrapped — before being passed to FTS5 syntax.

### Concurrency

- **WAL mode**: concurrent reads alongside serialized writes. Readers always see the last committed snapshot, never an in-flight write.
- **`busy_timeout = 5000`**: if a writer is active, other writers wait up to 5 seconds before failing.
- **`synchronous = NORMAL`**: balances durability and speed (loses at most the last committed transaction on OS crash).
- **`foreign_keys = ON`**: relational integrity enforced.

### Idempotency

Every write is either:

- **Idempotent by UNIQUE constraint** — e.g., inserting the same `tool_use_id` twice is a no-op.
- **Idempotent by full replace** — `SessionEnd` DELETEs then INSERTs every child row of the session, so re-running it always converges on the same state.

### Schema migrations

On DB open, Keddy runs a migration pass: new columns added via `ALTER TABLE ADD COLUMN` (backward-compatible); constraint changes applied via table recreation (create new, copy rows, rename). Migrations are idempotent — running them against an up-to-date DB is a no-op.

## 4. The MCP server

A **single factory** (`createKeddyMcpServer` in `src/mcp/tools.ts`) produces an MCP server with 11 tools. It's wired two ways:

1. **Stdio transport** (`src/mcp/server.ts`) — a subprocess Claude Code spawns and talks to. Registered during `keddy init`. Hardcoded with `agentTools: true`, so every client gets the full 11 tools.
2. **In-process** (`src/analysis/agent.ts`) — when Keddy generates session notes or daily notes, it embeds the same factory directly into the Agent SDK process. No subprocess spawn. Saves ~3 seconds of startup cost per agent invocation.

### The 11 tools, grouped by intent

| Group | Tools |
|---|---|
| **Find** | `keddy_search_sessions`, `keddy_search_by_file`, `keddy_recent_activity` |
| **Project context** | `keddy_project_status` |
| **Read a session** (varying depth) | `keddy_get_session_skeleton` (3–5KB), `keddy_get_session` (100KB+), `keddy_transcript_summary`, `keddy_get_transcript`, `keddy_get_plans` |
| **Read pre-generated AI notes** | `keddy_get_session_note`, `keddy_get_daily_note` |

### The `agentTools` flag

Currently gates only 2 tools (`keddy_get_session_skeleton`, `keddy_transcript_summary`). The note-retrieval tools are unconditionally registered — they're available to every client regardless of the flag. Since the stdio entrypoint hardcodes `agentTools: true`, this flag is effectively vestigial today; all 11 tools are exposed everywhere.

## 5. The AI analysis layer

Everything in `src/analysis/` is optional and disabled by default. Turn it on by setting `analysis.enabled = true` in `~/.keddy/config.json` and supplying your own API key.

### Session notes (`src/analysis/agent.ts`)

Session notes are per-session narrative write-ups, generated on demand. They describe what was built, what broke, what's unfinished — with references to real file paths, real exchange indices, real plan versions. The agent investigates the session deeply through Keddy's own MCP tools before writing anything.

**System prompt**:

```
You have access to MCP tools for reading coding session data. Use ALL of
them — get the session structure, read the full transcript across multiple
ranges, pull the plans with their feedback, check the file history for
cross-session connections. Spend most of your turns reading before you
start writing.

If plans were central to the session, pull the full plan details and
explain what evolved and why.

Understand what files changed and how those changes connect to the
decisions made. When referencing specific files, use the file search tool
to verify what was actually touched — don't infer file names from
conversation context alone. If tasks were completed or plans evolved,
consider whether the implementation matches the intent. Don't just
describe what was discussed — show what actually happened in the code
and whether it landed correctly.

Go deep on problems. When something broke, failed, or didn't work as
expected, investigate the transcript thoroughly:
- What were the exact symptoms? (error messages, unexpected behavior,
  what the user saw)
- What debugging was attempted? What approaches were tried and ruled out?
- Where did the investigation stop? What's the last known state of the
  problem?
- If a fix was attempted but didn't resolve it, explain what the fix was
  and why it fell short.

This is the most important part of a handoff — someone continuing this
session needs to know exactly what failed, what was already tried, and
where to pick up debugging. Don't summarize failures vaguely ("it didn't
work"). Be specific.

When something was built or deployed, distinguish between "it compiled"
and "the user confirmed it works." A passing build doesn't mean the
feature renders correctly or behaves as intended. Check if subsequent
exchanges confirm it's working, report a problem, or never tested it.
Flag unverified changes as unverified.

Then write about it. Whatever structure, format, or depth serves this
specific session. Let the content determine the shape. Spend more depth
on what's unfinished or broken — that's where the next session starts.

If the session is forked, focus on exchanges after the fork point.
Exchanges marked [COMPACTION SUMMARY] are compressed context, not
conversations.
```

### Daily notes (`src/analysis/daily-agent.ts`)

Daily notes synthesize every session that ran on a given day into one narrative. The agent receives each session's pre-generated session note as expert context (plus optional supplement exchanges when notes are stale), then writes the day across sessions. Scoped strictly to the target date — a multi-day session contributes only its on-that-day work.

- **Session classifier**: each session for the day is labeled `fresh` (note up to date), `stale` (note exists but exchanges added since), or `missing` (no note yet).
- **Parallel backfill**: missing session notes are generated concurrently before the daily synthesis begins.
- **Stale supplement**: the day's exchanges added since an existing note are appended as supplementary context.

**System prompt**:

```
You synthesize a day of coding sessions into a daily note.
Sessions are numbered chronologically: session 1 = first of the day.
You have MCP tools to read session transcripts, prior session notes,
and daily notes. Use them to understand what actually happened — read
the exchanges, check timestamps, trace how work unfolded through the day.

Each session below includes a pre-generated session note as expert
context. Some may also include a supplement of exchanges that happened
after the note was generated.

For multi-day sessions, focus ONLY on today's exchanges (ranges marked
below).
Exchanges marked [COMPACTION SUMMARY] are compressed context, not
conversations.

Write about this day. Whatever structure, format, or depth serves it
best. Let the content determine the shape. Connect sessions that relate
to each other. Reference sessions as [session N].
Use timestamps to understand the day — when sessions started, ended,
gaps, pacing — and let that shape how you explain what happened.
When files changed or plans evolved, understand what the changes
actually do and whether they match the intent. When referencing specific
files, use the file search tool to verify what was actually touched —
don't infer file names from conversation context alone. Connect the code
changes to the decisions that drove them.
When sessions hit problems — things that broke, failed, or didn't work
as expected — carry that depth through. The session notes may already
detail exact errors, debugging attempts, and where investigations
stopped. Preserve that specificity in the daily note. If something is
unfinished or broken at end of day, that's the most important thing for
tomorrow's context.
When changes were built or deployed, distinguish between "compiled
successfully" and "user confirmed it works." A passing build doesn't
mean the feature renders or behaves correctly. If session notes or
transcripts show user confirmation, say so. If they don't, flag it as
unverified.
If a previous day's note is provided, show how today connects to or
continues from it.
Start directly with the content — no preamble.
At the very end, after the full analysis, write a single line:
TITLE: <short title that captures the day's theme>
```

### The shared Agent SDK + MCP pattern

Session notes and daily notes both run on the same two-path architecture.

**Short session fast path (≤3 exchanges):** direct Anthropic API call, no Agent SDK. Uses the `SHORT_SESSION_PROMPT`:

```
You have access to a coding session transcript. Tell me what happened —
what was the goal, what was done, where it ended up. Keep it
proportional to the session length.
```

Returns in one turn. Avoids Agent SDK overhead for tiny sessions.

**Full Agent SDK path:**

1. **Lightweight scaffold** — Keddy builds a 1–2KB context packet: session metadata, plan skeleton, milestones, fork point, effective exchange count, and a programmatically-generated Mermaid activity diagram. Not the full 100KB transcript.
2. **In-process MCP** — the Agent SDK receives the same factory (`createKeddyMcpServer({agentTools: true})`) as an in-process tool provider. No subprocess spawn.
3. **Investigation via tool calls** — the agent uses `keddy_get_transcript`, `keddy_get_plans`, and `keddy_search_by_file` to pull specific exchange ranges and verify file paths before writing.
4. **Streaming output** — events are yielded as the agent thinks, calls tools, and writes.

### Simple AI features

Lightweight — no Agent SDK, no MCP. Each runs at `SessionEnd` if enabled.

- **Titles** (`titles.ts`) — Claude Haiku, structured prompt: verb-first, 4–8 words, max 50 characters.
- **Work-phase summaries** (`summaries.ts`) — Claude Haiku, two-line structured output: LABEL + SUMMARY.
- **Decision extraction** (`decisions.ts`) — Claude Haiku, returns a JSON array of notable decisions from the transcript.

### Configuration shape

```jsonc
{
  "analysis": {
    "enabled": false,
    "provider": "anthropic",
    "apiKey": "",
    "features": {
      "sessionTitles":      { "enabled": true, "model": "claude-haiku-4-5" },
      "segmentSummaries":   { "enabled": true, "model": "claude-haiku-4-5" },
      "decisionExtraction": { "enabled": true, "model": "claude-haiku-4-5" }
    }
  },
  "notes": {
    "sessionModel": "claude-sonnet-4-6",
    "dailyModel":   "claude-sonnet-4-6",
    "autoSessionNotes": false,
    "autoDailyNotes":   false
  }
}
```

## 6. The dashboard

A Hono API and a React 19 / Tailwind v4 SPA, both served by the same process.

- **Entrypoint**: `keddy open` starts the Hono server on port 3737 and opens `http://localhost:3737` in the default browser.
- **Security**: localhost-only. Host header validation accepts only `localhost`, `127.0.0.1`, and `[::1]`. CORS is limited to localhost origins. Standard security headers applied.
- **API routes**: `/api/sessions`, `/api/plans`, `/api/stats`, `/api/projects`, `/api/analyze`, `/api/notes`, `/api/daily`, `/api/config`. All return JSON read from the SQLite DB.
- **Static serving**: the Vite-built React bundle is served from `dist/dashboard/public`, with an SPA fallback — unknown routes return `index.html`.
- **Live updates**: the dashboard polls the session API; no WebSockets or SSE are currently wired.

## 7. The CLI

A single dispatcher (`src/cli/index.ts`) switches on `process.argv[2]`.

| Command | Purpose |
|---|---|
| `keddy init` | One-time setup: creates the DB, registers the four hooks in `~/.claude/settings.json`, installs the MCP server entry. |
| `keddy open` | Boots the dashboard server and opens the browser. |
| `keddy status` | Reports hook status, session count, database size. |
| `keddy config [get\|set] <key> [value]` | Reads / writes `~/.keddy/config.json` with dot-notation keys. |
| `keddy import [--force]` | One-time historical import from `~/.claude/projects/**/*.jsonl`. |
| `keddy reimport` | Wipes and re-imports everything from the canonical JSONL files. |
| `keddy backfill` | Migrates old exchanges to the current schema. |
| `keddy version`, `keddy help` | Self-explanatory. |

Every handler is lazy-imported so trivial commands stay snappy.

## 8. Design decisions

**Programmatic-first, AI-optional.** All capture, parsing, plan extraction, work phase division, and code event detection are deterministic. AI is an opt-in enhancement layer. This means Keddy works with no API keys, output is reproducible, and AI is used only where it wins clearly — narrative notes, not data extraction.

**Full re-parse on `SessionEnd`.** When a session ends, Keddy doesn't merge incremental data — it DELETEs everything for that session and rebuilds from scratch against the JSONL. Correctness wins. The JSONL file is the source of truth; the DB is always derivable.

**The 1.5-second Stop-hook self-delay.** Claude Code's JSONL writer doesn't always flush the turn's `content_blocks` before Stop fires. Keddy's workaround — parse once, wait 1.5s, re-parse just `content_blocks` — isn't elegant, but addresses a real timing-correctness issue.

**Single SQLite file for all projects.** Enables cross-project search, cross-project daily notes, and `keddy_recent_activity`. The tradeoff: one file to back up, doesn't scale to a team. Team use is planned for a future hosted tier.

**WAL mode.** Required for the workload — hooks writing while the dashboard reads, and multiple hooks potentially writing concurrently. WAL gives concurrent reads with serialized writes and a 5-second busy timeout.

**Idempotent everywhere.** Every write is either UNIQUE-constrained or part of a full replace. Hooks can fail and retry, migrations can run repeatedly, the DB never ends up in a partially-written inconsistent state.

**Factory-pattern MCP, wired two ways.** The same `createKeddyMcpServer` produces the server Claude Code talks to via stdio and the server Keddy's own AI agents embed in-process. Saves ~3 seconds per agent invocation. More importantly, the AI agents have the exact same tool surface as a human user — the feedback loop is symmetric.

**Facts-first enrichment at write time.** Tool call fields like `file_path`, `bash_command`, `skill_name` are extracted from `tool_input` JSON at insert, not on every query. Queries stay fast, facts survive format changes in Claude Code's tool input, and the DB is query-ready without runtime parsing.

**No telemetry.** Not a philosophical statement — a hard product constraint. Keddy runs locally. AI analysis uses your own API key and hits the provider directly.

## 9. Failure modes, concurrency, performance

### Failure modes

- **Parse failure on a single JSONL line** — caught and skipped. The session continues with partial data.
- **DB locked** — `busy_timeout = 5000` waits up to 5 seconds. After that, the hook returns without writing; `SessionEnd` reconciles.
- **Hook process crashes mid-write** — SQLite's WAL guarantees that partial writes aren't visible. The next hook (or `SessionEnd`) rebuilds from JSONL.
- **Missing transcript file** — handler gracefully returns minimal output.
- **AI provider outage** — analysis calls catch exceptions and return empty results. Core data is unaffected.

### Concurrency

Multiple hooks writing at once: WAL serializes writes; each hook takes ~100ms for Stop, ~500ms for SessionEnd. Dashboard reading while hooks write: WAL readers see last-committed state; never block writers. In-process MCP (from `agent.ts`) and stdio MCP (from Claude Code) both open the DB read-only for queries.

### Performance (rough numbers)

- Stop hook: ~100ms average (parse last 3 exchanges, insert delta).
- SessionEnd: ~500ms for a 100-exchange session.
- FTS5 search: <50ms for small result sets; scales with JSONL volume, not session count.
- Dashboard initial load: ~200ms for session list.
- Session note generation (Agent SDK path): 30s–3min depending on session size and model.

## 10. Glossary

Internal names have historical baggage. For a first-time reader:

| Internal name (code / DB / MCP) | Plain-English meaning |
|---|---|
| **Session** | One run of Claude Code — from open to exit. |
| **Exchange** | One turn: your prompt plus Claude's full response (including tool calls). |
| **Plan** | A plan drafted by Claude via `ExitPlanMode`. Tracked across versions with your feedback. |
| **Segment** / **Activity group** / **Work phase** | A contiguous slice of a session divided at structural boundaries (plan mode, compaction, interrupt, branch change, file focus shift, long pause). The DB calls these "segments"; in prose we call them work phases. |
| **Milestone** | A git or test event — commit, push, PR, branch creation, test pass/fail — extracted from Bash tool calls. Also called "code events." |
| **Fork** | A Claude Code session branched off from another. Keddy tracks the parent and the divergence exchange. |
| **Compaction** | Claude Code trimming context to stay within the model's window. Keddy records these events. |
| **Hook** | A shell command Claude Code invokes at a specific lifecycle moment. Keddy registers four. |

## Further reading

- [`docs/DECISIONS.md`](DECISIONS.md) — extended rationale for why Keddy is session intelligence (not a memory layer), why programmatic-first, why local-only.
- [`CONTRIBUTING.md`](../CONTRIBUTING.md) — development setup, coding standards, PR process.
- [`README.md`](../README.md) — product-level overview and install instructions.
