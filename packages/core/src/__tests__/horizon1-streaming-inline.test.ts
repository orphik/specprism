import { describe, expect, it } from "vitest";
import type { LlmProviderClient } from "../llm/provider-router.js";
import {
  applyInlineSpecEdit,
  runStage3CriteriaCoDesign,
  runStage4TestBlueprint,
  SpecIterationDocumentSchema,
} from "../index.js";

const SAMPLE_DOC = SpecIterationDocumentSchema.parse({
  projectId: "22222222-2222-4222-8222-222222222222",
  iterationNumber: 1,
  stage: "stage_4_tests",
  targetDialectId: "anthropic-claude",
  recommendedMcps: [],
  createdAt: "2026-11-26T12:00:00.000Z",
  triage: {
    projectTitle: "Feature Flag Service",
    rawPrompt: "Build a feature flag service with percentage rollouts and kill switches",
    scopedVisionSummary: "Evaluate deterministic percentage rollouts and instant kill switches.",
    primaryActors: ["SDK Client", "Release Engineer"],
    explicitOutOfScopeV1: ["Multi-armed bandit auto-tuning"],
    questions: [],
    lockedAssumptions: [
      {
        id: "ASM-001",
        dimension: "failure_and_recovery_states",
        statement: "Default to safe off-state if flag config cache is unreachable.",
        source: "user_confirmed",
      },
    ],
  },
  features: [
    {
      id: "FEAT-01",
      title: "Flag Rollouts & Kill Switch",
      outcomeSummary: "Toggle flags safely.",
      stories: [
        {
          id: "US-001",
          featureId: "FEAT-01",
          sliceOrder: 1,
          title: "Evaluate Percentage Rollout",
          asA: "SDK Client",
          iWant: "deterministic bucketing by userId hash",
          soThat: "users see consistent flag states",
          independentDemoProof: "Evaluate 100 user IDs at 20% rollout.",
          touchpoints: {
            entrySurface: "GET /api/flags/evaluate",
            domainLogic: "MurmurHashBucketer",
            persistenceOrExternal: "PostgreSQL feature_flags table",
          },
          linkedAssumptionIds: ["ASM-001"],
        },
        {
          id: "US-002",
          featureId: "FEAT-01",
          sliceOrder: 2,
          title: "Trigger Instant Kill Switch",
          asA: "Release Engineer",
          iWant: "to disable a broken flag in 1 click",
          soThat: "incidents stop immediately",
          independentDemoProof: "Click Kill Switch and verify false evaluation.",
          touchpoints: {
            entrySurface: "POST /api/flags/[key]/kill",
            domainLogic: "KillSwitchService",
            persistenceOrExternal: "PostgreSQL feature_flags + audit_logs",
          },
          linkedAssumptionIds: ["ASM-001"],
        },
        {
          id: "US-003",
          featureId: "FEAT-01",
          sliceOrder: 3,
          title: "Inspect Kill Switch Audit Trail",
          asA: "Release Engineer",
          iWant: "to view who toggled a kill switch and when",
          soThat: "post-incident reviews have exact timelines",
          independentDemoProof: "Open Audit tab and view actor + timestamp row.",
          touchpoints: {
            entrySurface: "GET /api/flags/[key]/audits",
            domainLogic: "AuditQueryService",
            persistenceOrExternal: "PostgreSQL flag_audit_logs",
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
      title: "Consistent Hash Bucketing",
      gwt: {
        given: ["flag rollout is 25%"],
        when: "same userId evaluates twice",
        then: ["identical boolean variant is returned"],
      },
      ears: {
        pattern: "ubiquitous",
        systemName: "Flag Evaluator",
        shallResponse: "compute deterministic MurmurHash3 bucket per userId and flagKey",
        rendered:
          "THE Flag Evaluator SHALL compute deterministic MurmurHash3 bucket per userId and flagKey.",
      },
      coaching: {
        whyItMatters: "Prevents UI flicker across page reloads.",
        failureModePrevented: "Inconsistent A/B assignment",
      },
    },
    {
      id: "REQ-002",
      storyId: "US-002",
      category: "happy_path",
      title: "Kill Switch Overrides Rollout",
      gwt: {
        given: ["flag killSwitch is true"],
        when: "any userId evaluates the flag",
        then: ["false is returned immediately"],
      },
      ears: {
        pattern: "state_driven",
        systemName: "Flag Evaluator",
        triggerOrCondition: "killSwitch is active",
        shallResponse: "return false regardless of percentage rollout",
        rendered:
          "WHILE killSwitch is active, THE Flag Evaluator SHALL return false regardless of percentage rollout.",
      },
      coaching: {
        whyItMatters: "Guarantees emergency shutoff.",
        failureModePrevented: "Partial incident exposure",
      },
    },
    {
      id: "REQ-003",
      storyId: "US-003",
      category: "non_functional_guardrail",
      title: "Immutable Audit Entry",
      gwt: {
        given: ["an engineer triggers kill switch"],
        when: "state persists",
        then: ["immutable audit row records actorId and timestamp"],
      },
      ears: {
        pattern: "event_driven",
        systemName: "KillSwitchService",
        triggerOrCondition: "a kill switch is toggled",
        shallResponse: "append an immutable row to flag_audit_logs",
        rendered:
          "WHEN a kill switch is toggled, THE KillSwitchService SHALL append an immutable row to flag_audit_logs.",
      },
      coaching: {
        whyItMatters: "Preserves compliance evidence.",
        failureModePrevented: "Unattributed production flag changes",
      },
    },
  ],
  testCases: [
    {
      id: "TC-001",
      title: "Hashes userId deterministically",
      tier: "unit",
      verifiesReqIds: ["REQ-001"],
      targetFilePath: "tests/bucketer.test.ts",
      skeletonCode: "expect(evalFlag('u1')).toBe(evalFlag('u1'));",
      deterministicAssertions: ["Same boolean across repeated calls"],
    },
    {
      id: "TC-002",
      title: "Forces false when killSwitch active",
      tier: "api_contract",
      verifiesReqIds: ["REQ-002"],
      targetFilePath: "tests/kill-switch.spec.ts",
      skeletonCode: "expect(res.enabled).toBe(false);",
      deterministicAssertions: ["Returns enabled=false"],
    },
    {
      id: "TC-003",
      title: "Writes audit log row on kill switch toggle",
      tier: "api_contract",
      verifiesReqIds: ["REQ-003"],
      targetFilePath: "tests/audit-log.spec.ts",
      skeletonCode: "expect(audits).toHaveLength(1);",
      deterministicAssertions: ["Audit row persisted"],
    },
  ],
});

describe("Horizon 1 (v1.1) — Progressive Streaming & Inline Criterion/Story Co-Editing", () => {
  it("streams progressive partial batches in Stage 3 and Stage 4 with deterministic sequential IDs", async () => {
    const partialCriteriaSnapshots: number[] = [];
    const mockStage3Llm: LlmProviderClient = {
      modelId: "mock/streaming-s3",
      provider: "openrouter",
      async generateStructured({ schema, userPrompt }) {
        const storyMatches = [...userPrompt.matchAll(/-\s+(US-\d{3})/g)].map((m) => m[1]!);
        const generated = storyMatches.map((sid, idx) => ({
          id: `REQ-00${idx + 1}`,
          storyId: sid,
          category: "happy_path",
          title: `Verified behavior for ${sid}`,
          gwt: {
            given: [`${sid} precondition`],
            when: `${sid} executes`,
            then: [`${sid} succeeds`],
          },
          ears: {
            pattern: "event_driven",
            systemName: "Flag Service",
            triggerOrCondition: `${sid} is invoked`,
            shallResponse: `complete ${sid} deterministically`,
            rendered: `WHEN ${sid} is invoked, THE Flag Service SHALL complete ${sid} deterministically.`,
          },
          coaching: {
            whyItMatters: "Prevents ambiguity.",
            failureModePrevented: "Silent drift",
          },
        }));
        return schema.parse({ criteria: generated });
      },
    };

    const criteria = await runStage3CriteriaCoDesign({
      triage: SAMPLE_DOC.triage,
      features: SAMPLE_DOC.features,
      llm: mockStage3Llm,
      chunkSize: 1,
      onPartialCriteria(partial) {
        partialCriteriaSnapshots.push(partial.length);
      },
    });

    expect(partialCriteriaSnapshots.length).toBeGreaterThanOrEqual(2);
    expect(criteria.map((c) => c.id)).toEqual(["REQ-001", "REQ-002", "REQ-003"]);

    const partialTestSnapshots: number[] = [];
    const mockStage4Llm: LlmProviderClient = {
      modelId: "mock/streaming-s4",
      provider: "openrouter",
      async generateStructured({ schema, userPrompt }) {
        const reqMatches = [...userPrompt.matchAll(/-\s+(REQ-\d{3})/g)].map((m) => m[1]!);
        const tests = reqMatches.map((rid, idx) => ({
          id: `TC-00${idx + 1}`,
          title: `Verifies ${rid}`,
          tier: "unit",
          verifiesReqIds: [rid],
          targetFilePath: `tests/${rid.toLowerCase()}.test.ts`,
          skeletonCode: "expect(true).toBe(true);",
          deterministicAssertions: [`${rid} verified`],
        }));
        return schema.parse({ testCases: tests });
      },
    };

    const testCases = await runStage4TestBlueprint({
      triage: SAMPLE_DOC.triage,
      features: SAMPLE_DOC.features,
      criteria,
      llm: mockStage4Llm,
      chunkSize: 1,
      onPartialTestCases(partial) {
        partialTestSnapshots.push(partial.length);
      },
    });

    expect(partialTestSnapshots.length).toBeGreaterThanOrEqual(2);
    expect(testCases.map((t) => t.id)).toEqual(["TC-001", "TC-002", "TC-003"]);
  });

  it("applies inline edits to ASM-*, US-*, and REQ-* while rejecting missing SHALL or horizontal stubs", () => {
    const { document: editedAsm } = applyInlineSpecEdit(SAMPLE_DOC, {
      kind: "assumption",
      assumptionId: "ASM-001",
      statement: "Return cached flag config for up to 60s if PostgreSQL is unreachable.",
    });
    expect(editedAsm.triage.lockedAssumptions[0]!.statement).toContain("60s");
    expect(editedAsm.triage.lockedAssumptions[0]!.source).toBe("user_edited");

    const { document: editedReq, audit } = applyInlineSpecEdit(editedAsm, {
      kind: "criterion",
      reqId: "REQ-002",
      title: "Kill Switch Overrides All Rollouts Within 50ms",
      category: "non_functional_guardrail",
      earsRendered:
        "WHILE killSwitch is active, THE Flag Evaluator SHALL return false within 50ms.",
      gwtGiven: ["flag killSwitch is enabled"],
      gwtWhen: "SDK requests evaluation",
      gwtThen: ["false is returned in <50ms"],
    });
    expect(audit.valid).toBe(true);
    expect(editedReq.criteria[1]!.ears.rendered).toContain("within 50ms");
    expect(editedReq.criteria[1]!.category).toBe("non_functional_guardrail");

    // Reject EARS edit missing uppercase SHALL
    expect(() =>
      applyInlineSpecEdit(editedReq, {
        kind: "criterion",
        reqId: "REQ-002",
        title: "Invalid EARS",
        category: "happy_path",
        earsRendered: "The Flag Evaluator should maybe return false.",
        gwtGiven: ["killSwitch active"],
        gwtWhen: "evaluated",
        gwtThen: ["returns false"],
      })
    ).toThrow(/SHALL/);

    // Reject horizontal story edit ("TBD" / "none")
    expect(() =>
      applyInlineSpecEdit(editedReq, {
        kind: "story",
        storyId: "US-001",
        title: "Broken Horizontal Story",
        asA: "SDK Client",
        iWant: "bucketing",
        soThat: "consistency",
        independentDemoProof: "test",
        touchpoints: {
          entrySurface: "GET /api/flags",
          domainLogic: "MurmurHash",
          persistenceOrExternal: "TBD",
        },
      })
    ).toThrow(/Horizontal slice rejected/);
  });
});
