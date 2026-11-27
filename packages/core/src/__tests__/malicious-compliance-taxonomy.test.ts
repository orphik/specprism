import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { LlmProviderClient } from "../llm/provider-router.js";
import {
  applyInlineSpecEdit,
  detectAntiSlopViolation,
  EXPLOIT_CLASS_CATALOG,
  MALICIOUS_COMPLIANCE_EXPLOIT_CLASSES,
  runStage1SocraticTriage,
  runStage3CriteriaCoDesign,
  SpecIterationDocumentSchema,
} from "../index.js";

describe("Malicious Compliance 6-Class Exploit Taxonomy & Anti-Slop Gate (v1.5.1)", () => {
  const dogfoodSpec = SpecIterationDocumentSchema.parse(
    JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../../specprism/spec.json"), "utf8"))
  );

  it("exports all 6 orthogonal production exploit classes and human-readable catalog", () => {
    expect(MALICIOUS_COMPLIANCE_EXPLOIT_CLASSES).toEqual([
      "orphaned_state",
      "partial_mutation",
      "auth_boundary_leak",
      "concurrency_race",
      "blast_radius_scale",
      "silent_fallback",
    ]);
    expect(Object.keys(EXPLOIT_CLASS_CATALOG)).toHaveLength(6);
    expect(EXPLOIT_CLASS_CATALOG.concurrency_race.badgeLabel).toContain("Concurrency");
  });

  it("injects the 6 exploit classes into Stage 1 and Stage 3 prompts and preserves exploitClass tags", async () => {
    let capturedStage1System = "";
    const mockStage1Llm: LlmProviderClient = {
      modelId: "mock/stage1",
      async generateStructured({ schema, systemPrompt }) {
        capturedStage1System = systemPrompt;
        return schema.parse({
          projectTitle: "Stripe Refund Endpoint",
          rawPrompt: "Add POST /v1/refunds to refund Stripe charges",
          scopedVisionSummary: "Refund Stripe charges safely without double-refunds.",
          primaryActors: ["Support Agent", "Finance Admin"],
          explicitOutOfScopeV1: ["Automated chargeback dispute filing"],
          questions: [
            {
              id: "q-1",
              dimension: "failure_and_recovery_states",
              exploitClass: "partial_mutation",
              detectedAmbiguity: "Stripe refund may succeed while DB commit times out.",
              question: "How should split-brain Stripe + Postgres mutations be reconciled?",
              options: [
                {
                  id: "opt-1",
                  label: "Two-phase PENDING row + deterministic Stripe idempotency key",
                  tradeoffNote: "Zero double-refunds even on DB drop.",
                  recommended: true,
                },
                {
                  id: "opt-2",
                  label: "Async transactional outbox worker (HTTP 202)",
                  tradeoffNote: "Higher resilience, eventual UI confirmation.",
                  recommended: false,
                },
              ],
            },
            {
              id: "q-2",
              dimension: "security_auth_and_rate_limits",
              exploitClass: "concurrency_race",
              detectedAmbiguity: "Parallel clicks could refund 200%.",
              question: "How should concurrent refund requests on the same charge behave?",
              options: [
                {
                  id: "opt-1",
                  label: "SELECT ... FOR UPDATE NOWAIT row lock returning HTTP 409",
                  tradeoffNote: "Immediate deterministic conflict rejection.",
                  recommended: true,
                },
                {
                  id: "opt-2",
                  label: "Optimistic version CAS + client Idempotency-Key header",
                  tradeoffNote: "Stateless lock-free concurrency.",
                  recommended: false,
                },
              ],
            },
            {
              id: "q-3",
              dimension: "actors_and_roles",
              exploitClass: "auth_boundary_leak",
              detectedAmbiguity: "Tenant scoping and support refund ceiling unstated.",
              question: "Which roles and tenant predicates gate refunds?",
              options: [
                {
                  id: "opt-1",
                  label: "Enforce merchant_id == actor.merchant_id + Finance Admin role",
                  tradeoffNote: "Blocks IDOR and unauthorized support refunds.",
                  recommended: true,
                },
                {
                  id: "opt-2",
                  label: "Allow Support up to $100 with Finance Admin queue above $100",
                  tradeoffNote: "Faster tier-1 resolution with bounded risk.",
                  recommended: false,
                },
              ],
            },
          ],
          lockedAssumptions: [],
        });
      },
    };

    const triage = await runStage1SocraticTriage({
      rawPrompt: "Add POST /v1/refunds to refund Stripe charges",
      llm: mockStage1Llm,
    });
    expect(capturedStage1System).toContain("orphaned_state");
    expect(capturedStage1System).toContain("partial_mutation");
    expect(capturedStage1System).toContain("concurrency_race");
    expect(triage.questions[0]?.exploitClass).toBe("partial_mutation");

    let capturedStage3System = "";
    const mockStage3Llm: LlmProviderClient = {
      modelId: "mock/stage3",
      async generateStructured({ schema, systemPrompt }) {
        capturedStage3System = systemPrompt;
        return schema.parse({
          criteria: [
            {
              id: "REQ-001",
              storyId: "US-001",
              category: "negative_edge_case",
              exploitClass: "concurrency_race",
              title: "Reject Concurrent Double-Refund",
              gwt: {
                given: ["an in-flight refund holds the row lock"],
                when: "a second refund request arrives simultaneously",
                then: ["HTTP 409 Conflict is returned before calling Stripe"],
              },
              ears: {
                pattern: "unwanted_event",
                systemName: "RefundService",
                triggerOrCondition: "a concurrent transaction holds the charge lock",
                shallResponse: "abort before calling Stripe and return HTTP 409 Conflict",
                rendered:
                  "IF a concurrent transaction holds the charge lock, THEN THE RefundService SHALL abort before calling Stripe and return HTTP 409 Conflict.",
              },
              coaching: {
                whyItMatters: "Prevents 200% double-refund exploit.",
                failureModePrevented: "TOCTOU race condition",
              },
            },
          ],
        });
      },
    };

    const criteria = await runStage3CriteriaCoDesign({
      triage: dogfoodSpec.triage,
      features: [
        {
          ...dogfoodSpec.features[0]!,
          stories: [dogfoodSpec.features[0]!.stories[0]!],
        },
      ],
      llm: mockStage3Llm,
    });
    expect(capturedStage3System).toContain("blast_radius_scale");
    expect(capturedStage3System).toContain("silent_fallback");
    expect(criteria[0]?.exploitClass).toBe("concurrency_race");
  });

  it("blocks vague anti-slop filler phrases during EARS inline editing", () => {
    expect(detectAntiSlopViolation("THE System SHALL add proper error handling.")).toMatch(
      /Anti-slop/i
    );
    expect(detectAntiSlopViolation("THE System SHALL follow security best practices.")).toMatch(
      /Anti-slop/i
    );
    expect(
      detectAntiSlopViolation(
        "WHEN lock contention occurs, THE RefundService SHALL return HTTP 409 Conflict."
      )
    ).toBeNull();

    expect(() =>
      applyInlineSpecEdit(dogfoodSpec, {
        kind: "criterion",
        reqId: "REQ-001",
        title: "Vague Slop",
        category: "non_functional_guardrail",
        earsRendered: "WHEN an error happens, THE System SHALL add proper error handling.",
        gwtGiven: ["state"],
        gwtWhen: "error",
        gwtThen: ["handled"],
      })
    ).toThrow(/Anti-slop/);
  });
});
