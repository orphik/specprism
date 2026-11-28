import { describe, expect, it } from "vitest";
import type { LlmProviderClient } from "../llm/provider-router.js";
import {
  computeDeterministicSpecDelta,
  runStage5IterativeDelta,
  verifySpecTraceability,
} from "../pipeline/stage5-iterative-delta.js";
import { SpecIterationDocumentSchema } from "../schemas/index.js";

const BASE_DOC = SpecIterationDocumentSchema.parse({
  projectId: "11111111-1111-4111-8111-111111111111",
  iterationNumber: 1,
  stage: "stage_4_tests",
  targetDialectId: "anthropic-claude",
  recommendedMcps: [],
  createdAt: "2026-11-26T00:00:00.000Z",
  triage: {
    projectTitle: "Webhook Debugger",
    rawPrompt: "Build a webhook debugger",
    scopedVisionSummary: "Capture and replay webhooks with HMAC verification.",
    primaryActors: ["Developer"],
    explicitOutOfScopeV1: ["Multi-region fanout"],
    questions: [],
    lockedAssumptions: [
      {
        id: "ASM-001",
        dimension: "security_auth_and_rate_limits",
        statement: "Enforce HMAC-SHA256 verification.",
        source: "user_confirmed",
      },
    ],
  },
  features: [
    {
      id: "FEAT-01",
      title: "Webhook Replay",
      outcomeSummary: "Inspect and replay payloads.",
      stories: [
        {
          id: "US-001",
          featureId: "FEAT-01",
          sliceOrder: 1,
          title: "Capture Incoming Webhook",
          asA: "Developer",
          iWant: "to capture incoming webhooks",
          soThat: "I can inspect headers and payload",
          independentDemoProof: "POST payload and view row in UI.",
          touchpoints: {
            entrySurface: "POST /api/ingest",
            domainLogic: "WebhookIngestService",
            persistenceOrExternal: "PostgreSQL webhooks table",
          },
          linkedAssumptionIds: ["ASM-001"],
        },
        {
          id: "US-002",
          featureId: "FEAT-01",
          sliceOrder: 2,
          title: "Replay Captured Webhook",
          asA: "Developer",
          iWant: "to replay a captured webhook",
          soThat: "I can debug downstream handlers",
          independentDemoProof: "Click Replay and verify 200 status.",
          touchpoints: {
            entrySurface: "Replay Button & POST /api/replay",
            domainLogic: "ReplayDispatcher",
            persistenceOrExternal: "PostgreSQL replay_attempts table",
          },
          linkedAssumptionIds: ["ASM-001"],
        },
      ],
    },
  ],
  criteria: [
    {
      id: "REQ-001",
      storyId: "US-001",
      category: "happy_path",
      title: "Persist Valid Webhook",
      gwt: {
        given: ["an endpoint receives a signed webhook"],
        when: "POST /api/ingest executes",
        then: ["payload is stored in PostgreSQL"],
      },
      ears: {
        pattern: "event_driven",
        systemName: "Ingest API",
        triggerOrCondition: "a signed webhook arrives",
        shallResponse: "store the payload and return HTTP 202",
        rendered: "WHEN a signed webhook arrives, THE Ingest API SHALL store the payload and return HTTP 202.",
      },
      coaching: {
        whyItMatters: "Prevents lost payloads.",
        failureModePrevented: "Dropped webhook deliveries",
      },
    },
    {
      id: "REQ-002",
      storyId: "US-002",
      category: "non_functional_guardrail",
      title: "Replay Timeout",
      gwt: {
        given: ["a developer triggers replay"],
        when: "downstream target stalls",
        then: ["request aborts after 5 seconds"],
      },
      ears: {
        pattern: "unwanted_event",
        systemName: "Replay Dispatcher",
        triggerOrCondition: "downstream exceeds 5 seconds",
        shallResponse: "abort the request and record timeout status",
        rendered: "IF downstream exceeds 5 seconds, THEN THE Replay Dispatcher SHALL abort the request and record timeout status.",
      },
      coaching: {
        whyItMatters: "Protects worker pool from hung sockets.",
        failureModePrevented: "Thread exhaustion",
      },
    },
  ],
  testCases: [
    {
      id: "TC-001",
      title: "Ingests valid signed webhook",
      tier: "api_contract",
      verifiesReqIds: ["REQ-001"],
      targetFilePath: "tests/ingest.test.ts",
      skeletonCode: "expect(202).toBe(202);",
      deterministicAssertions: ["HTTP 202 returned"],
    },
    {
      id: "TC-002",
      title: "Aborts stalled replay at 5s",
      tier: "unit",
      verifiesReqIds: ["REQ-002"],
      targetFilePath: "tests/replay.test.ts",
      skeletonCode: "expect('timeout').toBe('timeout');",
      deterministicAssertions: ["Timeout recorded at 5s"],
    },
  ],
});

describe("Stage 5 Incremental Delta Patch & Traceability Audit", () => {
  it("merges fast incremental patches while preserving untouched items byte-for-byte as Regression Shields", async () => {
    const audit = verifySpecTraceability(BASE_DOC);
    expect(audit.valid).toBe(true);
    expect(audit.orphanReqIds).toHaveLength(0);

    const mockLlm: LlmProviderClient = {
      modelId: "mock/stage5-incremental",
      provider: "openrouter",
      async generateStructured({ schema }) {
        return schema.parse({
          scopedVisionSummary:
            "Capture and replay webhooks with 10s configurable timeout and exponential backoff.",
          upsertedStories: [],
          upsertedCriteria: [
            {
              ...BASE_DOC.criteria[1]!,
              ears: {
                ...BASE_DOC.criteria[1]!.ears,
                rendered:
                  "IF downstream exceeds 10 seconds, THEN THE Replay Dispatcher SHALL abort the request and schedule 1 retry.",
              },
            },
            {
              id: "REQ-003",
              storyId: "US-002",
              category: "happy_path",
              title: "Exponential Backoff Retry",
              gwt: {
                given: ["a replay fails with HTTP 503"],
                when: "auto-retry is enabled",
                then: ["a retry is scheduled after 2 seconds"],
              },
              ears: {
                pattern: "event_driven",
                systemName: "Replay Dispatcher",
                triggerOrCondition: "downstream returns HTTP 503",
                shallResponse: "enqueue a single retry after 2000ms",
                rendered:
                  "WHEN downstream returns HTTP 503, THE Replay Dispatcher SHALL enqueue a single retry after 2000ms.",
              },
              coaching: {
                whyItMatters: "Recovers from transient 503 blips without thundering herd.",
                failureModePrevented: "Retry storm",
              },
            },
          ],
          removedReqIds: [],
          upsertedTestCases: [
            {
              ...BASE_DOC.testCases[1]!,
              title: "Aborts stalled replay at 10s",
            },
            {
              id: "TC-003",
              title: "Schedules 2000ms backoff retry on HTTP 503",
              tier: "unit",
              verifiesReqIds: ["REQ-003"],
              targetFilePath: "tests/replay-retry.test.ts",
              skeletonCode: "expect(2000).toBe(2000);",
              deterministicAssertions: ["Retry queued with 2000ms delay"],
            },
          ],
          removedTestCaseIds: [],
        });
      },
    };

    const v2 = await runStage5IterativeDelta({
      previousDoc: BASE_DOC,
      userChangePrompt: "Increase replay timeout to 10s and add a single 2s retry on HTTP 503.",
      llm: mockLlm,
    });

    expect(v2.iterationNumber).toBe(2);
    expect(v2.stage).toBe("stage_5_delta");
    expect(v2.criteria).toHaveLength(3);
    expect(v2.testCases).toHaveLength(3);
    expect(v2.delta!.impactedStoryIds).toEqual(["US-002"]);
    expect(v2.delta!.requirementDeltas).toHaveLength(2);

    const shield = v2.delta!.testImpacts.find((t) => t.testCaseId === "TC-001");
    const updated = v2.delta!.testImpacts.find((t) => t.testCaseId === "TC-002");
    const added = v2.delta!.testImpacts.find((t) => t.testCaseId === "TC-003");

    expect(shield?.status).toBe("regression_shield");
    expect(updated?.status).toBe("requires_update");
    expect(added?.status).toBe("new_test_required");

    const trimmed = computeDeterministicSpecDelta(
      v2,
      {
        iterationNumber: 3,
        features: v2.features,
        criteria: v2.criteria.slice(0, 2),
        testCases: v2.testCases.slice(0, 2),
      },
      "Remove automatic 503 retry."
    );
    expect(trimmed.requirementDeltas.some((d) => d.operation === "REMOVED" && d.reqId === "REQ-003")).toBe(true);
    expect(trimmed.testImpacts.some((t) => t.testCaseId === "TC-003" && t.status === "obsolete")).toBe(true);
  });

  it("coerces fast-model shorthand category, GWT, EARS, coaching, and test tier strings cleanly", async () => {
    const shorthandLlm: LlmProviderClient = {
      modelId: "mock/fast-shorthand",
      provider: "openrouter",
      async generateStructured({ schema }) {
        return schema.parse({
          scopedVisionSummary: "Webhook debugger with 10k-row CSV export.",
          upsertedStories: [],
          upsertedCriteria: [
            {
              id: "REQ-003",
              storyId: "US-002",
              category: "edge",
              title: "Cap CSV Export at 10,000 Rows",
              gwt: "User exports >10,000 webhook rows",
              ears: "WHEN CSV export exceeds 10000 rows, THE Export API SHALL truncate at 10000 rows.",
              coaching: "Prevents OOM crashes on large exports.",
            },
          ],
          removedReqIds: [],
          upsertedTestCases: [
            {
              id: "TC-003",
              title: "Truncates CSV stream at 10000 rows",
              tier: "api",
              verifiesReqIds: ["REQ-003"],
              targetFilePath: "tests/csv-export.spec.ts",
              skeletonCode: "expect(rows.length).toBe(10000);",
            },
          ],
          removedTestCaseIds: [],
        });
      },
    };

    const v2 = await runStage5IterativeDelta({
      previousDoc: BASE_DOC,
      userChangePrompt: "Add CSV export capped at 10,000 rows.",
      llm: shorthandLlm,
    });

    expect(v2.criteria[2]!.category).toBe("negative_edge_case");
    expect(v2.testCases[2]!.tier).toBe("api_contract");
    expect(v2.delta!.testImpacts.find((t) => t.testCaseId === "TC-001")?.status).toBe(
      "regression_shield"
    );
  });
});
