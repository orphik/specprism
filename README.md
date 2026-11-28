# SpecPrism (`specprism`) — Open-Core AI Product, Spec & Post-Code QA Co-Architect

[![npm version](https://img.shields.io/npm/v/specprism?color=6366f1&label=npm%20specprism)](https://www.npmjs.com/package/specprism)
[![License: MIT](https://img.shields.io/badge/License-MIT-10b981.svg)](./LICENSE)
[![MCP 2026-07-28](https://img.shields.io/badge/MCP-2026--07--28%20Stateless-0ea5e9)](https://spec-prism.app/mcp)
[![Dogfooded with SpecPrism](https://img.shields.io/badge/Dogfooded%20with-SpecPrism%20100%25%20REQ%E2%86%94TC-8b5cf6)](https://spec-prism.app)

**Turn a rough 1–2 sentence feature idea into stress-tested scope decisions, vertical user stories (`US-*`), testable EARS `SHALL` requirements (`REQ-*`), 100% bi-directional test suites (`TC-*`), and visual Post-Code UAT Scorecards — from first prompt to verified release.**

> **Evolved from [`monkey-paw`](https://github.com/orphik/monkey-paw):** SpecPrism folds all **6 Malicious Compliance Exploit Classes** and anti-slop guardrails from `monkey-paw` into a full-lifecycle workbench, Stateless MCP server, 9-LLM Dialect Diff Coach, and Post-Code UAT Readiness Gatekeeper — built so non-terminal PMs/TPMs, QA leads, and IDE engineers share one source of truth.

- **Live Web Workbench (Instant Anonymous Sandbox + Free Daily Runs + Multi-Key BYOK):** **[https://spec-prism.app](https://spec-prism.app)**
- **Beginner-to-Expert Interactive Guide (`v1.6.0`):** **[https://spec-prism.app/guide](https://spec-prism.app/guide)**
- **Reference Specifications Gallery:** **[https://spec-prism.app/examples](https://spec-prism.app/examples)**
- **Official MCP Registry ID:** `io.github.orphik/specprism` (`stdio` & Streamable HTTP `https://spec-prism.app/mcp`)

---

## Pick Your Workflow (By Experience Level)

| Who You Are | Fastest Way to Start | What SpecPrism Gives You |
| :--- | :--- | :--- |
| **PMs, TPMs & New Builders** *(No terminal required)* | Open **[spec-prism.app](https://spec-prism.app)** and type 1–2 sentences | 3–4 paired PM/Engineer Socratic Scope Cards with Recommended defaults, live streaming vertical stories & tests, 1-click **Copy Agent Prompt**, and `/s/[slug]` stakeholder sign-off links |
| **Engineers in AI IDEs** *(Brownfield & greenfield repos)* | Run `npx skills add orphik/specprism` | Scans your real framework/ORM/test runner read-only, catches 6 literal-agent exploit classes before code is written, edits EARS clauses inline (`edit-spec.mjs`), exports **Linear / GitHub Issues**, and locks Stage 5 **Regression Shields** |
| **Engineering & QA Teams** *(CI/CD & Post-Code UAT)* | Add `uses: orphik/specprism/action@main` + `verify-run` | Automated PR Spec-Drift Guard, **Post-Code UAT Readiness Rings** (Happy Path % vs. Negative Edge Cases % vs. Guardrails %) across Vitest/Playwright/JUnit XML, and **1-Click Dialect-Tuned Repair Prompts** |

---

## 6 Built-In Malicious Compliance Guardrails

Literal-minded AI coding agents pass happy-path prompts while silently introducing production traps. SpecPrism's Stage 1 & Stage 3 referee checks every feature against 6 concrete failure classes before implementation starts:

1. **`orphaned_state`** — Uncleaned timers, dangling background jobs, or leaked state on cancellation/disconnect.
2. **`partial_mutation`** — Multi-step writes missing transactional rollback or idempotency keys on mid-flight failure.
3. **`auth_boundary_leak`** — Cross-tenant IDOR, missing RBAC/ownership checks, or unauthenticated mutation paths.
4. **`concurrency_race`** — Double-submit, lost-update, or race-condition mutations under parallel requests.
5. **`blast_radius_scale`** — Unbounded list queries, missing pagination/rate limits, or cascading bulk deletes.
6. **`silent_fallback`** — Swallowed upstream errors, fake `200 OK` stubs, or vague anti-slop requirements (*"handle errors gracefully"*).

---

## Quickstart Commands

### 1. Install the Zero-Dependency IDE Agent Skill
```bash
# Works in Antigravity, Claude Code, Cursor, Codex, GitHub Copilot, Windsurf & Gemini CLI
npx skills add orphik/specprism
```
Then tell your agent: **`"Use specprism to plan <your feature idea>"`**.

### 2. Run the `specprism` CLI (Zero Config via `npx`)
```bash
npx specprism@latest --help
npx specprism@latest validate specprism/spec.json
npx specprism@latest edit-req specprism/spec.json REQ-001 "WHEN an event arrives, THE System SHALL verify its HMAC-SHA256 signature."
npx specprism@latest issues specprism/spec.json --out ISSUES_BACKLOG.md --gh-script create-issues.sh
npx specprism@latest ci-guard specprism/spec.json --out PR_GUARD.md
npx specprism@latest sync-surface <project-id> .specprism/surface.json --token sp_pat_...
npx specprism@latest verify-run specprism/spec.json vitest-report.json --sync --project-id <project-id> --out UAT_REPORT.md --repair-out REPAIR_PROMPT.md
npx specprism@latest delta v1-spec.json v2-spec.json
npx specprism@latest mcp
```

### 3. Gate Pull Requests & Sync Live UAT Readiness Rings with the GitHub Action
```yaml
# .github/workflows/specprism-guard.yml (auto-included in every .zip export)
- uses: actions/checkout@v4
  with:
    fetch-depth: 0
- uses: orphik/specprism/action@main
  with:
    spec-path: specprism/spec.json
    test-report-path: vitest-report.json # Posts UAT Readiness Scorecard to PR summary
    project-id: YOUR_OPTIONAL_PROJECT_UUID # Syncs live UAT Readiness Ring & /s/[slug] badge
    sync-token: ${{ secrets.SPECPRISM_TOKEN }} # Optional sp_pat_* token from /settings
```

### 4. Connect via Stateless MCP (`2026-07-28`)
Mint an optional cloud-sync token (`sp_pat_*`) at **[https://spec-prism.app/settings](https://spec-prism.app/settings)** or connect anonymously:
```json
{
  "mcpServers": {
    "specprism": {
      "url": "https://spec-prism.app/mcp",
      "serverUrl": "https://spec-prism.app/mcp",
      "headers": {
        "Authorization": "Bearer sp_pat_YOUR_OPTIONAL_SYNC_TOKEN"
      }
    }
  }
}
```

---

## Open-Core Monorepo Architecture (MIT)

| Package / Directory | npm Package | Purpose |
| :--- | :--- | :--- |
| [`packages/core`](./packages/core) | [`@specprism/core`](https://www.npmjs.com/package/@specprism/core) | Canonical Zod schemas, 5-stage Socratic pipeline, 6-class exploit taxonomy, YAML dialect compiler & multi-format UAT verifier |
| [`packages/db`](./packages/db) | [`@specprism/db`](https://www.npmjs.com/package/@specprism/db) | Unified PostgreSQL Drizzle ORM (`@electric-sql/pglite` embedded locally, PostgreSQL 17 + `pgvector` in cloud) |
| [`packages/registry-sync`](./packages/registry-sync) | [`@specprism/registry-sync`](https://www.npmjs.com/package/@specprism/registry-sync) | Live OpenRouter, LiteLLM, Official MCP Registry, Smithery & local Ollama discovery |
| [`packages/mcp-server`](./packages/mcp-server) | [`@specprism/mcp-server`](https://www.npmjs.com/package/@specprism/mcp-server) | Zero-session Stateless MCP `2026-07-28` server (`stdio` + Streamable HTTP, 7 tools incl. `specprism_ingest_uat` & `specprism_push_surface`) |
| [`packages/cli`](./packages/cli) | [`specprism`](https://www.npmjs.com/package/specprism) | Standalone CLI (`validate`, `edit-req`, `issues`, `ci-guard`, `verify-run --sync`, `sync-surface`, `delta`, `mcp`) |
| [`dialects/`](./dialects) | Bundled | Hot-reloadable prompt & anti-slop rulebooks for 9 frontier LLM families (Anthropic, OpenAI, Gemini, DeepSeek, Qwen, xAI, Meta, Mistral, Local) |
| [`skills/specprism`](./skills/specprism) | `npx skills add orphik/specprism` | Zero-dependency IDE Agent Skill + deterministic validator & UAT scripts |
| [`action/`](./action) | `orphik/specprism/action@main` | Composite GitHub Action for PR Spec-Drift & Post-Code UAT gates |

---

## Keep SpecPrism Free & Evergreen
SpecPrism is free and MIT open-core. If SpecPrism saves your team hours of rework, consider supporting our 24/7 Evergreen AI & MCP Radar via **[GitHub Sponsors (`@orphik`)](https://github.com/sponsors/orphik)** or at **[spec-prism.app](https://spec-prism.app)**.
