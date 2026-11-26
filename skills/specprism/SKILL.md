---
name: specprism
description: "Pre-code Socratic specification & QA co-architect that eliminates vibe-coding drift. Activate when asked to plan a feature, write a PRD/spec, refine ambiguous requirements, generate EARS/Given-When-Then acceptance criteria, or create traceable REQ-to-TC test plans. Scans brownfield/greenfield repos read-only, deals 3-4 Socratic Decision Cards, parks tangents to PARKING-LOT.md, gates specs through a deterministic validator, and compiles SPEC.md, TRACEABILITY.md, and Gherkin/test skeletons."
license: MIT
compatibility: "Node.js 20+ standard library only (zero npm install required). Works read-only during triage across Antigravity, Claude Code, Cursor, Codex, Windsurf, and Gemini CLI, plus visual cloud sync at https://spec-prism.app."
metadata:
  version: "1.0.0"
  domain: "spec-driven-development"
  homepage: "https://spec-prism.app"
---

# SpecPrism — Socratic Product & QA Co-Architect

One-shot AI specifications fail because unstated edge cases, horizontal task slicing ("first build DB, then API, then UI"), and orphan requirements cause coding agents to guess in production.

Run this 5-step workflow **before writing application code** to lock a deterministic, 100% test-traceable specification (`Vision -> VerticalStory [US-*] -> AcceptanceCriterion [REQ-*] -> TestCase [TC-*]`).

## Hard Guardrails

1. **Do NOT edit application source code** while running this specification workflow.
2. **Scratch state** lives strictly inside `.specprism/` (`.specprism/surface.json`, `.specprism/spec.json`).
3. **Never read or echo secrets** (`.env*`, `*.pem`, `*.key`, tokens).
4. Resolve `<SKILL_DIR>` below as the directory containing this `SKILL.md` file. All helper scripts use pure Node.js 20+ built-ins (`node "<SKILL_DIR>/scripts/..."`).

---

## 5-Step Co-Architect Workflow

### Step 1: Deterministic Workspace Surface Scan

Scan the repository read-only so every story, EARS clause, and test skeleton aligns with the project's real framework, ORM, and test runner:

```bash
node "<SKILL_DIR>/scripts/scan-repo.mjs" --repo . --out .specprism/surface.json
```

Inspect `.specprism/surface.json`:
- `"mode": "brownfield"` — Ground vertical story touchpoints (`entrySurface`, `domainLogic`, `persistenceOrExternal`) and `TC-*` test file paths in the detected stack (`frameworks`, `orms`, `testRunners`). Never invent a foreign ORM or test runner.
- `"mode": "greenfield"` — Recommend clean defaults or confirm stack choice in one question.

### Step 2: Deal 3–4 Socratic Scope & Boundary Decision Cards

Read [`references/ears-and-slicing-rubric.md`](./references/ears-and-slicing-rubric.md).

Before generating stories or criteria, analyze the user's prompt for unstated ambiguity across:
1. `actors_and_roles`
2. `v1_out_of_scope_boundary`
3. `failure_and_recovery_states`
4. `security_auth_and_rate_limits`

Present **3 to 4 crisp Decision Cards** (each with `Option A (Recommended)`, `Option B`, plain-English trade-off notes, and shorthand reply instructions like `"Q1: A, Q2: B, Q3: custom — cap retries at 3"`), plus an explicit **v1 Out-of-Scope** list. **Pause and wait for the user's answers.**

#### Operating the Tangent Parking Lot (`PARKING-LOT.md`)
Whenever a Phase-2 feature or off-scope refactor arises during triage, park it immediately without derailing v1 scope:

```bash
node "<SKILL_DIR>/scripts/park-tangent.mjs" \
  --item "<concise summary>" \
  --category <phase-2|tech-debt|ux-polish|infra> \
  --reason "<why deferred from v1>" \
  --out PARKING-LOT.md
```

### Step 3: Author `.specprism/spec.json` (Vertical Slices + EARS + `REQ -> TC`)

Once the user confirms or customizes the Decision Cards:
1. Read [`references/spec-json-contract.md`](./references/spec-json-contract.md) for the exact JSON structure.
2. Lock confirmed answers as `ASM-001+`.
3. Decompose **3 to 5 end-to-end Vertical User Stories (`US-001+`)** — every story MUST exercise concrete `entrySurface`, `domainLogic`, and `persistenceOrExternal` touchpoints (never horizontal DB-only or UI-only layers).
4. Write deterministic **Given/When/Then + canonical EARS (`WHEN ... THE <system> SHALL ...`)** acceptance criteria (`REQ-001+`) spanning `happy_path`, `negative_edge_case`, and `non_functional_guardrail`, each with a `coaching` callout (`whyItMatters`, `failureModePrevented`).
5. Map **100% of `REQ-*` criteria to `TC-001+` test cases** (`unit`, `api_contract`, `e2e_playwright`, or `gherkin_bdd`) with runnable `skeletonCode`.

Save the complete JSON document to `.specprism/spec.json`.

### Step 4: Gate Through the Deterministic Validator (Mandatory)

Never compile or present final outputs until `validate-spec.mjs` passes with exit code `0`:

```bash
node "<SKILL_DIR>/scripts/validate-spec.mjs" --spec .specprism/spec.json
```

If `validate-spec.mjs` flags a horizontal story stub, missing EARS `SHALL` clause, dangling story reference, or orphan `REQ-*` without a verifying `TC-*`, fix `.specprism/spec.json` and re-run until green.

### Step 5: Compile Verified Specification & Test Bundle

Compile `.specprism/spec.json` into human-reviewable and coding-agent-ready artifacts (`claude` XML, `openai` Markdown, `gemini` XML, `deepseek` R-series Markdown, `qwen` Coder Markdown, or `compact` JSON fence dialect):

```bash
node "<SKILL_DIR>/scripts/compile-bundle.mjs" \
  --spec .specprism/spec.json \
  --dialect claude \
  --out .
```

*(Add `--with-skeletons` when the user also wants the `features/*.feature` and `TC-*` test skeleton files written directly into their workspace.)*

### Step 6 (Iterative v2+ Evolution): Compute Spec Deltas & Regression Shields

When evolving an existing specification for a new iteration (`v1 -> v2+`), keep unaffected `US-*`, `REQ-*`, and `TC-*` IDs stable and compute the deterministic delta report:

```bash
node "<SKILL_DIR>/scripts/delta-spec.mjs" \
  --base .specprism/spec.v1.json \
  --next .specprism/spec.json \
  --prompt "<summary of v2 change>" \
  --out DELTA.md
```

---

## Visual Web Workbench, Examples Gallery & Remote MCP (`spec-prism.app`)
Users can visually co-design specs, evolve fast Stage 5 Iterative Deltas (`v1 -> v2+`), share unlisted team links (`/s/<slug>`), browse gold-standard EARS reference specs at **https://spec-prism.app/examples**, mint `sp_pat_*` cloud-sync tokens at **https://spec-prism.app/settings**, and read the full guide at **https://spec-prism.app/guide**.
