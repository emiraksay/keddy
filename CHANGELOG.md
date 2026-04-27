# Changelog

All notable changes to Keddy are listed here.

## [0.1.2] - 2026-04-27

### Changed
- Restructured the README around what each surface gives the user: exchanges, plans, notes, daily notes, activity analysis, dashboard, and the MCP tools.
- Embedded the hero demo video natively via GitHub attachments.

### Fixed
- Pre-launch capture, parsing, and dashboard fixes.

## [0.1.1] - 2026-04-23

Initial public release.

### Added
- Capture pipeline running off four Claude Code hooks, writing to a local SQLite database with FTS5 full-text search.
- 11 MCP tools, all exposed by default, covering session search, session reading at varying depth, plan version history, file lookups, project status, recent activity, and saved session and daily notes.
- Local dashboard at `localhost:3737` with Activity, Plans, and Notes tabs.
- Optional AI layer (session notes, daily notes, activity analysis) using your own Anthropic API key. Off by default.
- CLI: `init`, `open`, `status`, `import`, `reimport`, `backfill`, `config`, `version`, `help`.

### Security
- Dashboard hardened against CSRF, SQL injection, and SVG-based XSS before public release.
