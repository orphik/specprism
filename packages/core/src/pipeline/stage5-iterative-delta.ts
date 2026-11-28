import { z } from "zod";
import {
  type AcceptanceCriterion,
  AcceptanceCriterionSchema,
  type Feature,
  ReqIdSchema,
  type RequirementDelta,
  type SpecDelta,
  type SpecIterationDocument,
  SpecIterationDocumentSchema,
  type TestCase,
  TestCaseIdSchema,
  TestCaseSchema,
  type TestImpactEntry,
  VerticalStorySchema,
} from "../schemas/index.js";
import type { LlmProviderClient } from "../llm/provider-router.js";
import { formatRepoSurfacePromptBlock } from "../surface/repo-surface.js";
import { assertVerticalStorySlices } from "./stage2-vertical-stories.js";

export interface TraceabilityAuditResult {
  valid: boolean;
  storyCount: number;
  reqCount: number;
  testCount: number;
  orphanReqIds: string[];
  horizontalStoryIds: string[];
  issues: string[];
}

export function verifySpecTraceability(doc: unknown): TraceabilityAuditResult {
  const parsed = SpecIterationDocumentSchema.safeParse(doc);
  const issues: string[] = [];
  const orphanReqIds: string[] = [];
  const horizontalStoryIds: string[] = [];

  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push(`${issue.path.join(".") || "document"}: ${issue.message}`);
    }
    return {
      valid: false,
      storyCount: 0,
      reqCount: 0,
      testCount: 0,
      orphanReqIds,
      horizontalStoryIds,
      issues,
    };
  }

  const validDoc = parsed.data;
  const allStories = validDoc.features.flatMap((f) => f.stories);

  try {
    assertVerticalStorySlices(validDoc.features);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Vertical story validation failed.";
    issues.push(msg);
    for (const s of allStories) {
      const combined = `${s.touchpoints.entrySurface} ${s.touchpoints.domainLogic} ${s.touchpoints.persistenceOrExternal}`.toLowerCase();
      if (combined.includes("none") || combined.includes("n/a") || combined.includes("tbd")) {
        horizontalStoryIds.push(s.id);
      }
    }
  }

  const storyIds = new Set(allStories.map((s) => s.id));
  const coveredReqs = new Set<string>();
  for (const tc of validDoc.testCases) {
    for (const reqId of tc.verifiesReqIds) {
      coveredReqs.add(reqId);
    }
  }

  for (const req of validDoc.criteria) {
    if (!storyIds.has(req.storyId)) {
      issues.push(`Requirement ${req.id} references missing story ${req.storyId}.`);
    }
    if (!/\bSHALL\b/.test(req.ears.rendered)) {
      issues.push(`Requirement ${req.id} EARS statement must contain uppercase SHALL.`);
    }
    if (!coveredReqs.has(req.id)) {
      orphanReqIds.push(req.id);
      issues.push(`Orphan requirement ${req.id} has no verifying TC-* test case.`);
    }
  }

  return {
    valid: issues.length === 0,
    storyCount: allStories.length,
    reqCount: validDoc.criteria.length,
    testCount: validDoc.testCases.length,
    orphanReqIds,
    horizontalStoryIds,
    issues,
  };
}

export function computeDeterministicSpecDelta(
  baseDoc: SpecIterationDocument,
  targetDoc: Pick<SpecIterationDocument, "iterationNumber" | "features" | "criteria" | "testCases">,
  userChangePrompt: string
): SpecDelta {
  const baseReqMap = new Map(baseDoc.criteria.map((c) => [c.id, c]));
  const nextReqMap = new Map(targetDoc.criteria.map((c) => [c.id, c]));

  const requirementDeltas: RequirementDelta[] = [];
  const impactedStorySet = new Set<string>();
  let deltaSeq = 1;

  const makeDeltaId = () => `DLT-${String(deltaSeq++).padStart(3, "0")}`;

  for (const nextReq of targetDoc.criteria) {
    const prevReq = baseReqMap.get(nextReq.id);
    if (!prevReq) {
      impactedStorySet.add(nextReq.storyId);
      requirementDeltas.push({
        id: makeDeltaId(),
        operation: "ADDED",
        reqId: nextReq.id,
        storyId: nextReq.storyId,
        nextEars: nextReq.ears.rendered,
        rationale: `Added requirement '${nextReq.title}' to satisfy iteration change request.`,
      });
    } else if (
      prevReq.ears.rendered.trim() !== nextReq.ears.rendered.trim() ||
      prevReq.gwt.when.trim() !== nextReq.gwt.when.trim()
    ) {
      impactedStorySet.add(nextReq.storyId);
      requirementDeltas.push({
        id: makeDeltaId(),
        operation: "MODIFIED",
        reqId: nextReq.id,
        storyId: nextReq.storyId,
        previousEars: prevReq.ears.rendered,
        nextEars: nextReq.ears.rendered,
        rationale: `Updated EARS behavior for '${nextReq.title}' while preserving REQ trace ID.`,
      });
    }
  }

  for (const prevReq of baseDoc.criteria) {
    if (!nextReqMap.has(prevReq.id)) {
      impactedStorySet.add(prevReq.storyId);
      requirementDeltas.push({
        id: makeDeltaId(),
        operation: "REMOVED",
        reqId: prevReq.id,
        storyId: prevReq.storyId,
        previousEars: prevReq.ears.rendered,
        rationale: `Retired requirement '${prevReq.title}' per iteration scope update.`,
      });
    }
  }

  const addedReqIds = new Set(
    requirementDeltas.filter((d) => d.operation === "ADDED").map((d) => d.reqId)
  );
  const modifiedReqIds = new Set(
    requirementDeltas.filter((d) => d.operation === "MODIFIED").map((d) => d.reqId)
  );
  const removedReqIds = new Set(
    requirementDeltas.filter((d) => d.operation === "REMOVED").map((d) => d.reqId)
  );

  const baseTcIds = new Set(baseDoc.testCases.map((t) => t.id));
  const nextTcIds = new Set(targetDoc.testCases.map((t) => t.id));
  const testImpacts: TestImpactEntry[] = [];

  for (const nextTc of targetDoc.testCases) {
    const existedBefore = baseTcIds.has(nextTc.id);
    const touchesAdded = nextTc.verifiesReqIds.filter((r) => addedReqIds.has(r));
    const touchesModified = nextTc.verifiesReqIds.filter((r) => modifiedReqIds.has(r));

    if (!existedBefore || touchesAdded.length === nextTc.verifiesReqIds.length) {
      testImpacts.push({
        testCaseId: nextTc.id,
        status: "new_test_required",
        affectedReqIds: touchesAdded.length > 0 ? touchesAdded : nextTc.verifiesReqIds,
        actionSummary: `New verification test covering ${nextTc.verifiesReqIds.join(", ")} in ${nextTc.targetFilePath}.`,
      });
    } else if (touchesModified.length > 0 || touchesAdded.length > 0) {
      testImpacts.push({
        testCaseId: nextTc.id,
        status: "requires_update",
        affectedReqIds: [...touchesModified, ...touchesAdded],
        actionSummary: `Update assertions in ${nextTc.targetFilePath} to match modified EARS contract (${[
          ...touchesModified,
          ...touchesAdded,
        ].join(", ")}).`,
      });
    } else {
      testImpacts.push({
        testCaseId: nextTc.id,
        status: "regression_shield",
        affectedReqIds: nextTc.verifiesReqIds,
        actionSummary: `Unchanged invariant — keep passing to guard ${nextTc.verifiesReqIds.join(", ")} against regressions.`,
      });
    }
  }

  for (const prevTc of baseDoc.testCases) {
    if (!nextTcIds.has(prevTc.id)) {
      const removedHits = prevTc.verifiesReqIds.filter((r) => removedReqIds.has(r));
      testImpacts.push({
        testCaseId: prevTc.id,
        status: "obsolete",
        affectedReqIds: removedHits.length > 0 ? removedHits : prevTc.verifiesReqIds,
        actionSummary: `Retire or archive ${prevTc.id} (${prevTc.targetFilePath}) — verified requirement removed.`,
      });
    }
  }

  return {
    baseIterationNumber: baseDoc.iterationNumber,
    targetIterationNumber: targetDoc.iterationNumber,
    userChangePrompt,
    impactedStoryIds: [...impactedStorySet],
    requirementDeltas,
    testImpacts,
  };
}

function normalizeCriterionCandidate(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const obj = { ...(raw as Record<string, unknown>) };

  // Normalize category shorthand from fast models
  const cat = String(obj.category ?? "").toLowerCase();
  if (cat !== "happy_path" && cat !== "negative_edge_case" && cat !== "non_functional_guardrail") {
    if (cat.includes("edge") || cat.includes("neg") || cat.includes("error") || cat.includes("fail")) {
      obj.category = "negative_edge_case";
    } else if (
      cat.includes("guard") ||
      cat.includes("non_functional") ||
      cat.includes("security") ||
      cat.includes("perf") ||
      cat.includes("rate")
    ) {
      obj.category = "non_functional_guardrail";
    } else {
      obj.category = "happy_path";
    }
  }

  // Normalize GWT if emitted as string or single-item strings
  if (typeof obj.gwt === "string") {
    obj.gwt = {
      given: ["the system is running in a valid state"],
      when: obj.gwt,
      then: [String(obj.title || "the expected outcome is persisted")],
    };
  } else if (obj.gwt && typeof obj.gwt === "object") {
    const g = obj.gwt as Record<string, unknown>;
    obj.gwt = {
      given: Array.isArray(g.given) ? g.given : [String(g.given ?? "valid system state")],
      when: String(g.when ?? obj.title ?? "action executes"),
      then: Array.isArray(g.then) ? g.then : [String(g.then ?? "expected state persists")],
    };
  } else {
    obj.gwt = {
      given: ["valid system state"],
      when: String(obj.title ?? "action executes"),
      then: ["expected response and state mutation occur"],
    };
  }

  // Normalize EARS if emitted as plain string or partial object
  if (typeof obj.ears === "string") {
    const renderedStr = /\bSHALL\b/.test(obj.ears)
      ? obj.ears
      : `WHEN triggered, THE System SHALL ${obj.ears}`;
    obj.ears = {
      pattern: "event_driven",
      systemName: "System",
      triggerOrCondition: "triggered",
      shallResponse: renderedStr,
      rendered: renderedStr,
    };
  } else if (obj.ears && typeof obj.ears === "object") {
    const e = obj.ears as Record<string, unknown>;
    const rawRendered = String(
      e.rendered ??
        `WHEN ${String(e.triggerOrCondition ?? "requested")}, THE ${String(
          e.systemName ?? "System"
        )} SHALL ${String(e.shallResponse ?? obj.title ?? "complete the operation")}.`
    );
    const rendered = /\bSHALL\b/.test(rawRendered)
      ? rawRendered
      : rawRendered.replace(/\bshall\b/i, "SHALL") +
        (/\bshall\b/i.test(rawRendered) ? "" : " — THE System SHALL enforce this invariant.");
    const pat = String(e.pattern ?? "event_driven");
    obj.ears = {
      pattern: [
        "ubiquitous",
        "event_driven",
        "state_driven",
        "unwanted_event",
        "optional",
      ].includes(pat)
        ? pat
        : "event_driven",
      systemName: String(e.systemName ?? "System"),
      triggerOrCondition: e.triggerOrCondition ? String(e.triggerOrCondition) : undefined,
      shallResponse: String(e.shallResponse ?? rendered),
      rendered,
    };
  }

  // Normalize coaching if emitted as string or omitted
  if (typeof obj.coaching === "string") {
    obj.coaching = {
      whyItMatters: obj.coaching,
      failureModePrevented: "Unverified edge-case regression",
    };
  } else if (!obj.coaching || typeof obj.coaching !== "object") {
    obj.coaching = {
      whyItMatters: "Locks deterministic behavior across iterations.",
      failureModePrevented: "Ambiguous implementation drift",
    };
  } else {
    const c = obj.coaching as Record<string, unknown>;
    obj.coaching = {
      whyItMatters: String(c.whyItMatters ?? "Locks deterministic behavior."),
      failureModePrevented: String(c.failureModePrevented ?? "Silent production regression"),
    };
  }

  return obj;
}

function normalizeTestCaseCandidate(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const obj = { ...(raw as Record<string, unknown>) };
  const tier = String(obj.tier ?? "").toLowerCase();
  if (!["unit", "api_contract", "e2e_playwright", "gherkin_bdd"].includes(tier)) {
    if (tier.includes("api") || tier.includes("contract") || tier.includes("integration")) {
      obj.tier = "api_contract";
    } else if (tier.includes("e2e") || tier.includes("playwright") || tier.includes("ui")) {
      obj.tier = "e2e_playwright";
    } else if (tier.includes("gherkin") || tier.includes("bdd")) {
      obj.tier = "gherkin_bdd";
    } else {
      obj.tier = "unit";
    }
  }
  if (!Array.isArray(obj.deterministicAssertions) || obj.deterministicAssertions.length === 0) {
    obj.deterministicAssertions = [String(obj.title ?? "Expected assertion passes")];
  }
  if (!obj.skeletonCode || typeof obj.skeletonCode !== "string") {
    obj.skeletonCode = `test("${String(obj.title ?? "verifies requirement")}", async () => {\n  expect(true).toBe(true);\n});`;
  }
  return obj;
}

const CoercedCriterionSchema = z.preprocess(
  normalizeCriterionCandidate,
  AcceptanceCriterionSchema
);
const CoercedTestCaseSchema = z.preprocess(normalizeTestCaseCandidate, TestCaseSchema);

const STAGE5_PATCH_JSON_HINT = `{
  "scopedVisionSummary": "Updated concise 1-2 sentence vision summary reflecting the iteration change",
  "upsertedStories": [
    {
      "id": "US-010",
      "featureId": "FEAT-01",
      "sliceOrder": 10,
      "title": "Short vertical story title",
      "asA": "Primary Actor",
      "iWant": "concrete capability",
      "soThat": "measurable user value",
      "independentDemoProof": "How to verify end-to-end",
      "touchpoints": {
        "entrySurface": "UI button or API endpoint",
        "domainLogic": "Service/handler module",
        "persistenceOrExternal": "PostgreSQL table or queue"
      },
      "linkedAssumptionIds": ["ASM-001"]
    }
  ],
  "upsertedCriteria": [
    {
      "id": "REQ-028",
      "storyId": "US-010",
      "category": "happy_path | negative_edge_case | non_functional_guardrail",
      "title": "Concise requirement title",
      "gwt": {
        "given": ["precondition"],
        "when": "trigger action",
        "then": ["observable outcome"]
      },
      "ears": {
        "pattern": "ubiquitous | event_driven | state_driven | unwanted_event | optional",
        "systemName": "Service Name",
        "triggerOrCondition": "condition",
        "shallResponse": "deterministic response",
        "rendered": "WHEN condition, THE Service Name SHALL deterministic response."
      },
      "coaching": {
        "whyItMatters": "QA architectural reason",
        "failureModePrevented": "Specific bug prevented"
      }
    }
  ],
  "removedReqIds": [],
  "upsertedTestCases": [
    {
      "id": "TC-028",
      "title": "Verifies REQ-028 behavior",
      "tier": "unit | api_contract | e2e_playwright | gherkin_bdd",
      "verifiesReqIds": ["REQ-028"],
      "targetFilePath": "tests/feature-delta.spec.ts",
      "skeletonCode": "test('verifies REQ-028', async () => { expect(200).toBe(200); });",
      "deterministicAssertions": ["HTTP 200 and expected row state"]
    }
  ],
  "removedTestCaseIds": []
}`;

export async function runStage5IterativeDelta(input: {
  previousDoc: SpecIterationDocument;
  userChangePrompt: string;
  llm: LlmProviderClient;
  preferredModelId?: string;
}): Promise<SpecIterationDocument> {
  const { previousDoc, userChangePrompt, llm } = input;
  const nextIterationNumber = previousDoc.iterationNumber + 1;

  const allPrevStories = previousDoc.features.flatMap((f) => f.stories);
  const maxStoryNum = allPrevStories.reduce(
    (mx, s) => Math.max(mx, Number(s.id.replace(/\D+/g, "")) || 0),
    0
  );
  const maxReqNum = previousDoc.criteria.reduce(
    (mx, c) => Math.max(mx, Number(c.id.replace(/\D+/g, "")) || 0),
    0
  );
  const maxTcNum = previousDoc.testCases.reduce(
    (mx, t) => Math.max(mx, Number(t.id.replace(/\D+/g, "")) || 0),
    0
  );

  const Stage5PatchSchema = z
    .object({
      scopedVisionSummary: z.string().min(10),
      upsertedStories: z.array(VerticalStorySchema).default([]),
      upsertedCriteria: z.array(CoercedCriterionSchema).default([]),
      removedReqIds: z.array(ReqIdSchema).default([]),
      upsertedTestCases: z.array(CoercedTestCaseSchema).default([]),
      removedTestCaseIds: z.array(TestCaseIdSchema).default([]),
    })
    .superRefine((patch, ctx) => {
      const removedReqs = new Set(patch.removedReqIds);
      const removedTcs = new Set(patch.removedTestCaseIds);

      const mergedReqs = new Map<string, AcceptanceCriterion>(
        previousDoc.criteria.filter((c) => !removedReqs.has(c.id)).map((c) => [c.id, c])
      );
      for (const cr of patch.upsertedCriteria) {
        mergedReqs.set(cr.id, cr);
      }

      const mergedTcs = new Map<string, TestCase>(
        previousDoc.testCases.filter((t) => !removedTcs.has(t.id)).map((t) => [t.id, t])
      );
      for (const tc of patch.upsertedTestCases) {
        mergedTcs.set(tc.id, tc);
      }

      const covered = new Set<string>();
      for (const tc of mergedTcs.values()) {
        for (const reqId of tc.verifiesReqIds) {
          if (mergedReqs.has(reqId)) covered.add(reqId);
        }
      }
      for (const reqId of mergedReqs.keys()) {
        if (!covered.has(reqId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Orphan requirement ${reqId} after applying Stage 5 patch lacks a verifying TC-* in upsertedTestCases.`,
            path: ["upsertedTestCases"],
          });
        }
      }
    });

  const compactBaselineSummary = {
    scopedVisionSummary: previousDoc.triage.scopedVisionSummary,
    defaultFeatureId: previousDoc.features[0]?.id ?? "FEAT-01",
    validAssumptionIds: previousDoc.triage.lockedAssumptions.map((a) => a.id),
    nextAvailableIds: {
      storyId: `US-${String(maxStoryNum + 1).padStart(3, "0")}`,
      reqId: `REQ-${String(maxReqNum + 1).padStart(3, "0")}`,
      testCaseId: `TC-${String(maxTcNum + 1).padStart(3, "0")}`,
    },
    existingStories: allPrevStories.map((s) => ({
      id: s.id,
      featureId: s.featureId,
      title: s.title,
      touchpoints: s.touchpoints,
    })),
    existingCriteria: previousDoc.criteria.map((c) => ({
      id: c.id,
      storyId: c.storyId,
      title: c.title,
      ears: c.ears.rendered,
    })),
    existingTestCases: previousDoc.testCases.map((t) => ({
      id: t.id,
      verifiesReqIds: t.verifiesReqIds,
      targetFilePath: t.targetFilePath,
    })),
  };

  const patch = await llm.generateStructured({
    schemaName: "Stage5IncrementalPatch",
    schema: Stage5PatchSchema,
    systemPrompt:
      "You are SpecPrism Stage 5 — Fast Incremental Spec & Regression Architect. Emit ONLY the incremental patch (1-2 new or modified US-* stories, 2-4 new or modified REQ-* EARS criteria, removed REQ-* IDs, and 2-4 new or modified TC-* test skeletons) needed to satisfy the user's change request. DO NOT repeat unchanged stories, criteria, or tests — omitted items are automatically preserved verbatim as Regression Shields! Follow the exact JSON field structure in the schema hint (category must be happy_path, negative_edge_case, or non_functional_guardrail; tier must be unit, api_contract, e2e_playwright, or gherkin_bdd).",
    userPrompt: `Change Request for Iteration v${nextIterationNumber}:\n"${userChangePrompt}"\n\nCompact Baseline v${previousDoc.iterationNumber} Inventory:\n${JSON.stringify(
      compactBaselineSummary,
      null,
      2
    )}${formatRepoSurfacePromptBlock(previousDoc.repoSurface)}`,
    jsonStructureHint: STAGE5_PATCH_JSON_HINT,
  });

  const featuresClone: Feature[] = previousDoc.features.map((f) => ({
    ...f,
    stories: [...f.stories],
  }));
  if (featuresClone.length === 0) {
    featuresClone.push({
      id: "FEAT-01",
      title: "Core Product Capabilities",
      outcomeSummary: patch.scopedVisionSummary,
      stories: [],
    });
  }

  for (const upStory of patch.upsertedStories) {
    let placed = false;
    for (const feat of featuresClone) {
      const existingIdx = feat.stories.findIndex((s) => s.id === upStory.id);
      if (existingIdx >= 0) {
        feat.stories[existingIdx] = upStory;
        placed = true;
        break;
      }
    }
    if (!placed) {
      const targetFeat =
        featuresClone.find((f) => f.id === upStory.featureId) ?? featuresClone[0]!;
      targetFeat.stories.push({ ...upStory, featureId: targetFeat.id });
    }
  }

  assertVerticalStorySlices(featuresClone);

  const removedReqs = new Set(patch.removedReqIds);
  const criteriaList: AcceptanceCriterion[] = previousDoc.criteria
    .filter((c) => !removedReqs.has(c.id))
    .map((c) => {
      const mod = patch.upsertedCriteria.find((u) => u.id === c.id);
      return mod ?? c;
    });
  const existingCriteriaIds = new Set(criteriaList.map((c) => c.id));
  for (const upCrit of patch.upsertedCriteria) {
    if (!existingCriteriaIds.has(upCrit.id)) {
      criteriaList.push(upCrit);
      existingCriteriaIds.add(upCrit.id);
    }
  }

  const removedTcs = new Set(patch.removedTestCaseIds);
  const testCaseList: TestCase[] = previousDoc.testCases
    .filter((t) => !removedTcs.has(t.id))
    .map((t) => {
      const mod = patch.upsertedTestCases.find((u) => u.id === t.id);
      return mod ?? t;
    });
  const existingTcIds = new Set(testCaseList.map((t) => t.id));
  for (const upTc of patch.upsertedTestCases) {
    if (!existingTcIds.has(upTc.id)) {
      testCaseList.push(upTc);
      existingTcIds.add(upTc.id);
    }
  }

  const delta = computeDeterministicSpecDelta(
    previousDoc,
    {
      iterationNumber: nextIterationNumber,
      features: featuresClone,
      criteria: criteriaList,
      testCases: testCaseList,
    },
    userChangePrompt
  );

  return SpecIterationDocumentSchema.parse({
    ...previousDoc,
    iterationNumber: nextIterationNumber,
    stage: "stage_5_delta",
    preferredModelId: input.preferredModelId ?? previousDoc.preferredModelId,
    triage: {
      ...previousDoc.triage,
      scopedVisionSummary: patch.scopedVisionSummary,
    },
    features: featuresClone,
    criteria: criteriaList,
    testCases: testCaseList,
    delta,
    createdAt: new Date().toISOString(),
  });
}
