# SpecPrism EARS & Vertical Slicing Rubric

## 1. Vertical Story Invariant (`US-*`)
Every user story MUST deliver an independently testable vertical slice across all three layers:
- **`entrySurface`**: UI view, HTTP API endpoint, CLI subcommand, or MCP tool.
- **`domainLogic`**: Validation rule, state transition, calculation, or policy invariant.
- **`persistenceOrExternal`**: Database table mutation, queue event, or external API contract.

**Forbidden anti-patterns:** `"Create database schema"`, `"Set up API boilerplate"`, `"Build UI mockup without backend"`, or placeholder touchpoints (`"N/A"`, `"None"`, `"TBD"`).

## 2. Canonical EARS Patterns (`REQ-*`)
Every `ears.rendered` string MUST include an uppercase **`SHALL`** clause:
- **Ubiquitous**: `THE <system> SHALL <deterministic response>.`
- **Event-Driven**: `WHEN <trigger>, THE <system> SHALL <deterministic response>.`
- **State-Driven**: `WHILE <state>, THE <system> SHALL <deterministic response>.`
- **Unwanted Event**: `IF <fault/edge condition>, THEN THE <system> SHALL <deterministic mitigation>.`
- **Optional**: `WHERE <capability enabled>, THE <system> SHALL <deterministic response>.`

## 3. Bi-Directional Traceability (`REQ-*` <-> `TC-*`)
- Zero orphan requirements: every `REQ-*` MUST be verified by `>= 1` `TC-*` test case.
- Zero mystery tests: every ID inside `TC-*.verifiesReqIds` MUST exist in `criteria`.
