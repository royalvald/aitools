# Repository Guidelines

Contributor guide for autobugfixer: a state-machine-driven pipeline that pulls bugs from issue platforms/CSV, preprocesses, auto-fixes, deploys, verifies, and persists learned experience, with human-in-the-loop checkpoints.

## Project Structure & Module Organization

Organized by pipeline stage (one package per stage, mapping 1:1 to `docs/specs/01~08`):

- `src/autobugfixer/` — Python package (src layout).
  - `core/` — shared kernel: `config`, `models`, `state` (state machine), `stage` (Stage protocol + TaskContext), `llm` (gateway/budget), `audit`, `bugtext` (injection-safe bug block).
  - `dsl/` — verification DSL: action vocabulary, schema, interpreter.
  - Stage packages: `ingest/` (platform/CSV/webhook ingestion, repo gate), `completeness/`, `planning/`, `scoring/` (v1 + `v2.py`), `fixing/` (stage + `codex.py` channel + `workspace.py`), `deploying/`, `verifying/`, `learning/` — each holds `stage.py` (+ `schemas.py` where the stage owns LLM output schemas).
  - Cross-cutting domains: `platform/` (bug platform adapters `mock`/`jira`/`zentao` + writeback), `env/` (executors `local`/`ssh`/`docker`, `whitelist`, `lock`, `resolve`), `knowledge/` (experience/skill/export), `intervention/` (HITL service + notifiers), `optimization/` (strategy versions), `runtime/` (Orchestrator, Scheduler, adapter `registry`).
  - `perception/` — three-dimension perception (FR-FIX-02); `api/` + `web/` — FastAPI routes and the static console; `security/` — injection defense, Fernet credentials, redaction; `prompts/templates/` — versioned prompt templates.
- `tests/` — pytest suite; `docs/` — PRD, design docs, specs; `examples/` — sample CSV; `var/` — runtime artifacts (workspaces/test env), gitignored.

## Architecture Overview

- State-machine-driven pipeline: `DISCOVERED → ANALYZING → PLANNING → SCORED → FIXING → DEPLOYING → VERIFYING → LEARNING → CLOSED`, with blocking `WAIT_*` states for human/environment intervention and `FAILED` for resumable failures.
- Main flow: ingest (platform/CSV/webhook) → completeness analysis → verification plan (DSL) → difficulty scoring → scheduler dispatch (easiest first) → fix in an isolated workspace → deploy (env lock + rollback) → DSL verification → experience persistence → platform status writeback.
- Functional domains: Bug ingestion; preprocessing (completeness/plan/scoring); scheduling; auto-fix; deploy & verify; experience learning; human intervention (HITL); audit & metering; platform sync; governance (versioned strategy, centralized config).
- Key code areas: `core/` (state machine, Stage protocol, LLM gateway, audit), stage packages `completeness|planning|scoring|fixing|deploying|verifying|learning` (one `stage.py` each), `runtime/` (Orchestrator, Scheduler, adapter registry), `platform/` + `env/` + `intervention/` (adapters and HITL), `security/` (injection defense, credentials, redaction).

## Build, Test, and Development Commands

Windows paths shown; on Unix use `.venv/bin/`:

- `python -m venv .venv` then `.venv/Scripts/pip install -e ".[dev]"` — install the package with dev dependencies.
- `.venv/Scripts/python -m pytest` — run the full suite (no API key needed).
- `.venv/Scripts/autobugfixer-import examples/bugs_sample.csv --run-analysis` — import bugs and run preprocessing.
- `.venv/Scripts/autobugfixer-api` — start the API + console at `http://127.0.0.1:8000`.
- `.venv/Scripts/autobugfixer-scheduler --once` — run one scheduler round.

All tunables are env vars prefixed `AUTOBUGFIXER_` (see `README.md`).

## Coding Style & Naming Conventions

- Python 3.11+, 4-space indentation, PEP 8; use type hints and `from __future__ import annotations`.
- `snake_case` for functions/variables, `PascalCase` for classes, `SCREAMING_SNAKE` for enum values (e.g., `TaskState.DISCOVERED`).
- Docstrings are written in Chinese and reference requirement IDs (e.g., `FR-PRE-02`).
- No formatter or linter is configured; match surrounding style.

## Testing Guidelines

- Framework: pytest. Test files are `tests/test_<module>.py` with `test_<behavior>` functions, e.g., `test_ingest_wakes_wait_info_task`.
- Put shared fixtures in `tests/conftest.py`.
- Prefer the Fake LLM and mock platform for deterministic tests; SSH/Docker adapters are lazy imports, not hard dependencies.
## Commit & Pull Request Guidelines

- Commit messages follow Conventional Commits with concise Chinese summaries: `feat:`, `fix:`, `docs:`, `test:` (e.g., `feat: 新增调度器 SLA 升级`).
- One logical change per commit; add a body for non-obvious decisions.
- PR descriptions: summarize the change, link related requirements (FR-xx), note config/behavior changes, and state how you verified (no CI is configured).

## Configuration & Security Notes

- Local defaults are safe to run: SQLite, Fake LLM, mock platform.
- Set `FERNET_KEY` in production; never commit secrets or `.env` files.
- Add external integrations through `runtime/registry.py` registration instead of modifying the core pipeline.
