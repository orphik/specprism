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

## 4. Malicious Compliance 6-Class Exploit Taxonomy & Anti-Slop Rules
Coding agents optimize for the shortest diff that satisfies happy-path words while breaking production. Audit brownfield and greenfield specs across these 6 orthogonal exploit classes (and set optional `"exploitClass"` on `questions[]` and `criteria[]` when applicable):
1. **`orphaned_state`**: Parent record paused/canceled/deleted while cron jobs, API keys, active sessions, or cached entitlements stay live. *(Remedy: enforce active parent check at execution time or cascade teardown.)*
2. **`partial_mutation`**: Sequential writes across DB + external APIs (Stripe, S3, email) leave split-brain state on mid-flight timeout. *(Remedy: two-phase `PENDING` ledger row + deterministic idempotency key, or transactional outbox.)*
3. **`auth_boundary_leak`**: Checks login without filtering by `tenant_id` / `organization_id` (IDOR) or enforcing role ceilings. *(Remedy: tenant-scoped query predicates returning `404` + explicit RBAC role check returning `403`.)*
4. **`concurrency_race`**: Check-then-act balance, seat, or status checks in memory fail under double-clicks or parallel retries. *(Remedy: `SELECT ... FOR UPDATE` row locks, optimistic version CAS, or unique DB constraints.)*
5. **`blast_radius_scale`**: Synchronous `O(N)` loops or unbounded `SELECT *` inside HTTP handlers time out workers under load. *(Remedy: bounded batch cap returning HTTP `413` or cursor-paginated async worker chunks.)*
6. **`silent_fallback`**: Broad `catch` blocks or permissive defaults swallow upstream `429`/billing/auth errors behind HTTP `200`. *(Remedy: fail closed with explicit status codes, dunning states, or dead-letter visibility.)*

**Anti-Slop Rejection:** Never write vague filler like *"add proper error handling"*, *"follow security best practices"*, or *"implement appropriate input validation"* — state exact status codes, locks, predicates, and bounds.
