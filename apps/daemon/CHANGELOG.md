# Changelog

All notable changes to `@agentic/daemon` (Keep a Changelog, semver).

## [Unreleased]

### Added

- `hello` / `env` carry each environment's `doctor` verdict (#43): the daemon runs every driver's `doctor` over its environments at start and on every environment change and sends `environmentVerdict` per row, so the Machine actor stores auth status and the isolation verdict per environment (EXE-05/07); a driver whose checks throw yields an error verdict `driver-doctor-failed` for each of its environments.
- `agentic-daemon pair <code> --url`, `run`, `doctor` (#19). Pairing stores the machine token owner-only (`icacls` on Windows, `0600` elsewhere); `environments.json` is validated into `LocalEnvironment[]`; `doctor` merges its own checks with each runtime driver's.
- `createDaemon`: one reconnecting WebSocket (bearer header, backoff with jitter), `hello` with environments / capabilities / resume cursors, `welcome.wanted`-driven gapless replay with explicit `gap` frames, `serveSession` per session with idempotent commands, `tool.call` / `tool.result` bridge, cwd-root and concurrency refusals, heartbeats.
- `ndjsonEventLog`: per-session NDJSON `EventLogStore` under `%LOCALAPPDATA%/agentic/sessions`, keyed by the platform session id.
- `builtinDrivers()` registers the Claude Code driver (`@agentic/runtimes/claude-code`); `run` disposes drivers on stop.
- Redacting JSON logger; Windows scheduled-task install / uninstall scripts.
