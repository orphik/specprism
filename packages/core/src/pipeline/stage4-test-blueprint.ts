import { z } from "zod";
import {
  type AcceptanceCriterion,
  type Feature,
  type SocraticTriage,
  type TestCase,
  TestCaseSchema,
} from "../schemas/index.js";
import type { LlmProviderClient } from "../llm/provider-router.js";

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

export async function runStage4TestBlueprint(input: {
  triage: SocraticTriage;
  features: Feature[];
  criteria: AcceptanceCriterion[];
  llm: LlmProviderClient;
}): Promise<TestCase[]> {
  const validReqIds = new Set(input.criteria.map((c) => c.id));

  const Stage4EnvelopeSchema = z
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
              message: `TestCase ${tc.id} references unknown requirement ${reqId}.`,
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

  const envelope = await input.llm.generateStructured({
    schemaName: "Stage4TraceableTests",
    schema: Stage4EnvelopeSchema,
    systemPrompt:
      "You are SpecPrism Stage 4 — Principal QA Architect ('Know What to Test'). Map EVERY acceptance criterion (REQ-*) to one or more stable test cases (TC-001, TC-002...) at the right verification tier (unit, api_contract, e2e_playwright, or gherkin_bdd). Zero orphan REQ-* IDs are permitted. Emit clean, idiomatic Vitest or Playwright TypeScript skeletons in skeletonCode.",
    userPrompt: `Scoped Vision: ${input.triage.scopedVisionSummary}\n\nAcceptance Criteria Requiring 100% TC-* Coverage:\n${input.criteria
      .map((c) => `- ${c.id} [${c.storyId} | ${c.category}] ${c.title}: ${c.ears.rendered}`)
      .join("\n")}`,
    jsonStructureHint: STAGE4_JSON_HINT,
  });

  return envelope.testCases;
}
