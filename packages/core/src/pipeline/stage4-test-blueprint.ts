import { z } from "zod";
import {
  type AcceptanceCriterion,
  type Feature,
  type RepoSurfaceContext,
  type SocraticTriage,
  type TestCase,
  TestCaseSchema,
} from "../schemas/index.js";
import type { LlmProviderClient } from "../llm/provider-router.js";
import { formatRepoSurfacePromptBlock } from "../surface/repo-surface.js";

const STAGE4_JSON_HINT = `{
  "testCases": [
    {
      "id": "TC-001",
      "title": "Verifies specific REQ behavior",
      "tier": "unit | api_contract | e2e_playwright | gherkin_bdd",
      "verifiesReqIds": ["REQ-001"],
      "targetFilePath": "tests/e2e/feature.spec.ts",
      "gherkinScenario": "Optional Scenario block",
      "skeletonCode": "Runnable Vitest or Playwright TypeScript test skeleton",
      "deterministicAssertions": ["status === 200", "row persisted in DB"]
    }
  ]
}`;

async function generateTestCasesForCriteriaBatch(
  triage: SocraticTriage,
  batchCriteria: AcceptanceCriterion[],
  llm: LlmProviderClient,
  repoSurface?: RepoSurfaceContext
): Promise<TestCase[]> {
  const validReqIds = new Set(batchCriteria.map((c) => c.id));

  const BatchEnvelopeSchema = z
    .object({
      testCases: z.array(TestCaseSchema).min(1),
    })
    .superRefine((val, ctx) => {
      const covered = new Set<string>();
      for (const tc of val.testCases) {
        for (const reqId of tc.verifiesReqIds) {
          if (!validReqIds.has(reqId)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `TestCase ${tc.id} references unknown requirement ${reqId}. Valid batch REQ IDs: ${[
                ...validReqIds,
              ].join(", ")}`,
              path: ["testCases"],
            });
          } else {
            covered.add(reqId);
          }
        }
      }
      for (const reqId of validReqIds) {
        if (!covered.has(reqId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Orphan requirement ${reqId} is not verified by any TC-* testCase.`,
            path: ["testCases"],
          });
        }
      }
    });

  const envelope = await llm.generateStructured({
    schemaName: "Stage4TraceableTests",
    schema: BatchEnvelopeSchema,
    systemPrompt:
      "You are SpecPrism Stage 4 — Principal QA Architect ('Know What to Test'). Map EVERY acceptance criterion (REQ-*) listed below to one or more stable test cases (TC-001, TC-002...) at the right verification tier (unit, api_contract, e2e_playwright, or gherkin_bdd). Zero orphan REQ-* IDs are permitted. Emit clean, idiomatic Vitest or Playwright TypeScript skeletons in skeletonCode.",
    userPrompt: `Scoped Vision: ${triage.scopedVisionSummary}\n\nAcceptance Criteria Requiring 100% TC-* Coverage:\n${batchCriteria
      .map((c) => `- ${c.id} [${c.storyId} | ${c.category}] ${c.title}: ${c.ears.rendered}`)
      .join("\n")}${formatRepoSurfacePromptBlock(repoSurface)}`,
    jsonStructureHint: STAGE4_JSON_HINT,
  });

  return envelope.testCases;
}

function renumberTestCases(batches: Array<TestCase[] | null>): TestCase[] {
  const flat = batches.filter((b): b is TestCase[] => b !== null).flat();
  return flat.map((tc, idx) => ({
    ...tc,
    id: `TC-${String(idx + 1).padStart(3, "0")}`,
  }));
}

export async function runStage4TestBlueprint(input: {
  triage: SocraticTriage;
  features: Feature[];
  criteria: AcceptanceCriterion[];
  llm: LlmProviderClient;
  repoSurface?: RepoSurfaceContext;
  chunkSize?: number;
  onPartialTestCases?: (
    partialTests: TestCase[],
    completedBatches: number,
    totalBatches: number
  ) => void;
}): Promise<TestCase[]> {
  const uniqueStoryIds = [...new Set(input.criteria.map((c) => c.storyId))];
  const effectiveStoryChunk =
    input.chunkSize ??
    (input.onPartialTestCases && uniqueStoryIds.length > 1 ? 1 : uniqueStoryIds.length);

  if (!input.onPartialTestCases || uniqueStoryIds.length <= effectiveStoryChunk) {
    const single = await generateTestCasesForCriteriaBatch(
      input.triage,
      input.criteria,
      input.llm,
      input.repoSurface
    );
    const numbered = renumberTestCases([single]);
    input.onPartialTestCases?.(numbered, 1, 1);
    return numbered;
  }

  const criteriaBatches: AcceptanceCriterion[][] = [];
  for (let i = 0; i < uniqueStoryIds.length; i += effectiveStoryChunk) {
    const sliceStories = new Set(uniqueStoryIds.slice(i, i + effectiveStoryChunk));
    const batch = input.criteria.filter((c) => sliceStories.has(c.storyId));
    if (batch.length > 0) {
      criteriaBatches.push(batch);
    }
  }

  const resultsByBatch: Array<TestCase[] | null> = criteriaBatches.map(() => null);
  let completed = 0;
  const maxConcurrency = 4;
  let nextIdx = 0;

  async function worker() {
    while (nextIdx < criteriaBatches.length) {
      const idx = nextIdx++;
      const res = await generateTestCasesForCriteriaBatch(
        input.triage,
        criteriaBatches[idx]!,
        input.llm,
        input.repoSurface
      );
      resultsByBatch[idx] = res;
      completed += 1;
      input.onPartialTestCases?.(
        renumberTestCases(resultsByBatch),
        completed,
        criteriaBatches.length
      );
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(maxConcurrency, criteriaBatches.length) }, () => worker())
  );

  return renumberTestCases(resultsByBatch);
}
