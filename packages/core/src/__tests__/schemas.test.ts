import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DialectProfileSchema,
  SpecIterationDocumentSchema,
  StatelessMcpRequestStateSchema,
} from "../index.js";

function buildBaseIteration(stage: "stage_3_criteria" | "stage_4_tests") {
  return {
    projectId: "550e8400-e29b-41d4-a716-446655440000",
    iterationNumber: 1,
    stage,
    triage: {
      rawPrompt: "Build a team webhook debugger with replay support.",
      scopedVisionSummary: "Self-serve webhook capture and deterministic replay workbench.",
      primaryActors: ["Developer", "Team Admin"],
      explicitOutOfScopeV1: ["Custom billing metering", "SAML SSO"],
      questions: [
        {
          id: "q1",
          dimension: "actors_and_roles" as const,
          detectedAmbiguity: "Unclear multi-user workspace boundary",
          question: "Who can replay captured payloads?",
          options: [
            { id: "o1", label: "Any workspace member", tradeoffNote: "Fastest debugging", recommended: true },
            { id: "o2", label: "Admins only", tradeoffNote: "Stricter production guard", recommended: false },
          ],
        },
        {
          id: "q2",
          dimension: "v1_out_of_scope_boundary" as const,
          detectedAmbiguity: "Payload retention window unspecified",
          question: "How long should v1 retain payloads?",
          options: [
            { id: "o1", label: "7-day rolling window", tradeoffNote: "Predictable DB footprint", recommended: true },
            { id: "o2", label: "Unlimited retention", tradeoffNote: "Requires archival tiering", recommended: false },
          ],
        },
        {
          id: "q3",
          dimension: "security_auth_and_rate_limits" as const,
          detectedAmbiguity: "Ingress flood risk",
          question: "How should inbound webhook bursts be rate-limited?",
          options: [
            { id: "o1", label: "60 req/sec per endpoint with 429 Retry-After", tradeoffNote: "Safe default", recommended: true },
            { id: "o2", label: "Drop silently above cap", tradeoffNote: "Harder to diagnose", recommended: false },
          ],
        },
      ],
      lockedAssumptions: [
        {
          id: "ASM-001",
          dimension: "security_auth_and_rate_limits" as const,
          statement: "Inbound endpoints enforce 60 req/sec with HTTP 429 Retry-After.",
          source: "user_confirmed" as const,
        },
      ],
    },
    features: [
      {
        id: "FEAT-01",
        title: "Webhook Capture & Replay Slice",
        outcomeSummary: "Capture inbound HTTP requests and replay them on demand.",
        stories: [
          {
            id: "US-001",
            featureId: "FEAT-01",
            sliceOrder: 1,
            title: "Capture and inspect inbound webhook",
            asA: "Developer",
            iWant: "to send an HTTP POST to a unique bin URL and see headers/body immediately",
            soThat: "I can verify third-party webhook payloads end-to-end",
            independentDemoProof: "POST JSON to /ingest/:binId and observe row in UI & Postgres",
            touchpoints: {
              entrySurface: "POST /api/ingest/:binId + Inspector Table UI",
              domainLogic: "Payload size cap & signature header sanitizer",
              persistenceOrExternal: "PostgreSQL captured_events table",
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
        category: "non_functional_guardrail" as const,
        title: "Inbound burst rate limiting",
        gwt: {
          given: ["Endpoint bin-123 has received 60 requests in the current 1-second window"],
          when: "Request #61 arrives within the same second",
          then: ["The server responds with HTTP 429", "Response includes a Retry-After header"],
        },
        ears: {
          pattern: "unwanted_event" as const,
          systemName: "Webhook Ingress Service",
          triggerOrCondition: "inbound traffic exceeds 60 requests per second for a bin",
          shallResponse: "reject excess requests with HTTP 429 and a Retry-After header",
          rendered:
            "IF inbound traffic exceeds 60 requests per second for a bin, THEN THE Webhook Ingress Service SHALL reject excess requests with HTTP 429 and a Retry-After header.",
        },
        coaching: {
          whyItMatters: "Prevents a runaway webhook loop from exhausting database connections.",
          failureModePrevented: "Connection pool starvation under retry storms.",
        },
      },
    ],
    testCases: [],
    recommendedMcps: [],
    targetDialectId: "anthropic-claude",
    createdAt: "2026-11-26T05:00:00.000Z",
  };
}

describe("@specprism/core schemas", () => {
  it("rejects Stage 4 documents when any REQ-* lacks a verifying TC-* test case", () => {
    const orphanDoc = buildBaseIteration("stage_4_tests");
    const result = SpecIterationDocumentSchema.safeParse(orphanDoc);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain("Orphan requirement REQ-001");
    }
  });

  it("accepts Stage 4 documents once every REQ-* is covered by a TC-* test case", () => {
    const coveredDoc = {
      ...buildBaseIteration("stage_4_tests"),
      testCases: [
        {
          id: "TC-001",
          title: "Enforces 60 req/s burst cap with 429 Retry-After",
          tier: "api_contract" as const,
          verifiesReqIds: ["REQ-001"],
          targetFilePath: "tests/api/rate-limit.test.ts",
          skeletonCode: "it('returns 429 on request 61', async () => { /* ... */ });",
          deterministicAssertions: ["status === 429", "headers.get('retry-after') !== null"],
        },
      ],
    };
    const result = SpecIterationDocumentSchema.safeParse(coveredDoc);
    expect(result.success).toBe(true);
  });

  it("validates seed dialect YAML against DialectProfileSchema", () => {
    const yamlPath = resolve(import.meta.dirname, "../../../../dialects/anthropic-claude.yaml");
    const raw = parse(readFileSync(yamlPath, "utf8"));
    const parsed = DialectProfileSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
  });

  it("enforces MCP 2026-07-28 protocolVersion in stateless requestState handles", () => {
    const valid = StatelessMcpRequestStateSchema.safeParse({
      protocolVersion: "2026-07-28",
      projectId: "550e8400-e29b-41d4-a716-446655440000",
      iterationNumber: 1,
      pendingStage: "stage_1_triage",
      elicitationRound: 1,
      draftTriageHash: "sha256:abcdef0123456789",
      expiresAtEpochMs: 1795700000000,
      signature: "hmac_sha256_valid_signature_token",
    });
    expect(valid.success).toBe(true);
  });
});
