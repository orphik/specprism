# SpecPrism (`specprism`)

**Turn a rough 1-to-2 sentence idea into verified, traceable software specifications (`REQ-*` <-> `TC-*`) without vibe-coding drift.**

SpecPrism is a free, open-core AI Product & QA Co-Architect usable directly in your IDE as an **Agent Skill** or **MCP `2026-07-28` Server**, via CLI (`npx specprism`), or visually in the hosted split-pane workbench at **[https://spec-prism.app](https://spec-prism.app)**.

- **Full Interactive How-To Guide (`v1.0`):** **[https://spec-prism.app/guide](https://spec-prism.app/guide)**
- **Verified Reference Specifications Gallery:** **[https://spec-prism.app/examples](https://spec-prism.app/examples)**

## Quickstart

### 1. Visual Web Workbench (Recommended)
Sign in free with **Google** or **GitHub** at **[https://spec-prism.app](https://spec-prism.app)** to co-design specifications interactively, inspect side-by-side **Annotated Dialect Diffs** across 6 model families (`Claude`, `OpenAI`, `Gemini`, `DeepSeek`, `Qwen`, `Ollama`), get auto-matched Official MCP Registry tools, and export Gherkin/Playwright `.zip` test bundles.

### 2. Install as an Agent Skill
```bash
npx skills add orphik/specprism
```

### 3. Connect via Stateless MCP (`2026-07-28`) or Local CLI
Mint an optional cloud-sync token (`sp_pat_*`) at **[https://spec-prism.app/settings](https://spec-prism.app/settings)** or connect directly via Streamable HTTP / local `stdio` (`npx specprism mcp`):
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

## Core 5-Stage Pipeline
1. **Socratic Scope & Boundary Triage** — Surfaces 3–4 clickable/editable ambiguity forks (`ASM-*`).
2. **Vertical-Slice Feature & Story Decomposition** — Enforces end-to-end UI + Domain + Persistence slices (`US-*`) + Official MCP Registry recommendations.
3. **Guided Acceptance Criteria Co-Design** — Generates deterministic Given/When/Then + EARS (`REQ-*`) with inline QA coaching.
4. **Traceable Test Blueprint & Dialect Diff Coach** — Maps every `REQ-*` to `TC-*` across Unit, API Contract, and Playwright/Gherkin tiers and compiles vendor-tuned handoff prompts across 6 model dialects.
5. **Iterative Delta Mode** — Computes `ADDED`, `MODIFIED`, and `REMOVED` deltas while badging existing tests as Regression Shields.

## Keep SpecPrism Free & Evergreen
SpecPrism is free to use and open-core (MIT). If SpecPrism saves your team hours of rework, consider supporting ongoing AI/MCP radar maintenance via **[GitHub Sponsors](https://github.com/sponsors/orphik)** or at **[spec-prism.app](https://spec-prism.app)**.
