import { describe, expect, it } from "vitest";
import {
  BUILTIN_DIALECT_PROFILES,
  compileAnnotatedDialectDiff,
  SpecIterationDocumentSchema,
} from "../index.js";

describe("Annotated Dialect Diff Coach (@specprism/core)", () => {
  it("compiles side-by-side Claude XML vs OpenAI Markdown diffs with coaching highlights", () => {
    const doc = SpecIterationDocumentSchema.parse({
      projectId: "550e8400-e29b-41d4-a716-446655440000",
      iterationNumber: 1,
      stage: "stage_2_stories",
      triage: {
        projectTitle: "Webhook Replay Debugger",
        rawPrompt: "Build a webhook replay debugger.",
        scopedVisionSummary: "Capture and replay webhooks deterministically.",
        primaryActors: ["Backend Engineer"],
        explicitOutOfScopeV1: ["Billing"],
        questions: [],
        lockedAssumptions: [
          {
            id: "ASM-001",
            dimension: "security_auth_and_rate_limits",
            statement: "Cap ingress at 60 req/s.",
            source: "user_confirmed",
          },
        ],
      },
      features: [
        {
          id: "FEAT-01",
          title: "Capture Slice",
          outcomeSummary: "Inspect inbound webhooks",
          stories: [
            {
              id: "US-001",
              featureId: "FEAT-01",
              sliceOrder: 1,
              title: "Ingest webhook payload",
              asA: "Backend Engineer",
              iWant: "to inspect captured JSON",
              soThat: "I can debug integrations",
              independentDemoProof: "POST /ingest/bin1 -> row in UI",
              touchpoints: {
                entrySurface: "POST /api/ingest",
                domainLogic: "Signature & rate-limit validator",
                persistenceOrExternal: "PostgreSQL events table",
              },
              linkedAssumptionIds: ["ASM-001"],
            },
          ],
        },
      ],
      criteria: [],
      testCases: [],
      recommendedMcps: [],
      targetDialectId: "anthropic-claude",
      createdAt: "2026-11-26T00:00:00.000Z",
    });

    const claude = BUILTIN_DIALECT_PROFILES.find((d) => d.id === "anthropic-claude")!;
    const openai = BUILTIN_DIALECT_PROFILES.find((d) => d.id === "openai-gpt-reasoning")!;
    const diff = compileAnnotatedDialectDiff(doc, claude, openai);

    expect(diff.primaryPrompt).toContain("<scoped_vision>");
    expect(diff.comparisonPrompt).toContain("## Scoped Vision & Non-Goals");
    expect(diff.highlights.length).toBeGreaterThanOrEqual(3);
  });
});
