import { z } from "zod";
import {
  type AcceptanceCriterion,
  AcceptanceCriterionSchema,
  type Feature,
  type SocraticTriage,
} from "../schemas/index.js";
import type { LlmProviderClient } from "../llm/provider-router.js";

const STAGE3_JSON_HINT = `{
  "criteria": [
    {
      "id": "REQ-001",
      "storyId": "US-001",
      "category": "happy_path | negative_edge_case | non_functional_guardrail",
      "title": "Deterministic requirement title",
      "gwt": {
        "given": ["Precondition 1"],
        "when": "Trigger action",
        "then": ["Observable outcome 1"]
      },
      "ears": {
        "pattern": "ubiquitous | event_driven | state_driven | unwanted_event | optional",
        "systemName": "Target Subsystem",
        "triggerOrCondition": "optional trigger/condition",
        "shallResponse": "deterministic behavior",
        "rendered": "WHEN <trigger>, THE <systemName> SHALL <shallResponse>."
      },
      "coaching": {
        "whyItMatters": "Plain-English QA/Security explanation",
        "failureModePrevented": "Specific production outage or vibe-coding bug prevented"
      }
    }
  ]
}`;

export async function runStage3CriteriaCoDesign(input: {
  triage: SocraticTriage;
  features: Feature[];
  llm: LlmProviderClient;
}): Promise<AcceptanceCriterion[]> {
  const allStories = input.features.flatMap((f) => f.stories);
  const validStoryIds = new Set(allStories.map((s) => s.id));

  const Stage3EnvelopeSchema = z
    .object({
      criteria: z.array(AcceptanceCriterionSchema).min(allStories.length),
    })
    .superRefine((val, ctx) => {
      for (const c of val.criteria) {
        if (!validStoryIds.has(c.storyId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Criterion ${c.id} references unknown storyId ${c.storyId}. Valid story IDs: ${[
              ...validStoryIds,
            ].join(", ")}`,
            path: ["criteria"],
          });
        }
      }
    });

  const envelope = await input.llm.generateStructured({
    schemaName: "Stage3AcceptanceCriteria",
    schema: Stage3EnvelopeSchema,
    systemPrompt:
      "You are SpecPrism Stage 3 — Acceptance Criteria & EARS Guardrail Co-Designer. For each vertical story (US-*), generate 2–3 high-signal acceptance criteria (REQ-001, REQ-002...; aim for 8–14 total REQ-* items across the whole spec so every criterion is sharp and non-redundant). Span happy_path, negative_edge_case, and non_functional_guardrail categories with Given/When/Then, canonical EARS ('WHEN ... THE <system> SHALL ...'), and concise QA coaching callouts.",
    userPrompt: `Scoped Vision: ${input.triage.scopedVisionSummary}\nLocked Assumptions:\n${input.triage.lockedAssumptions
      .map((a) => `- ${a.id}: ${a.statement}`)
      .join("\n")}\n\nVertical Stories to Cover:\n${allStories
      .map(
        (s) =>
          `- ${s.id} (${s.title}): As a ${s.asA}, I want ${s.iWant} so that ${s.soThat} [Entry: ${s.touchpoints.entrySurface} | Logic: ${s.touchpoints.domainLogic} | Persistence: ${s.touchpoints.persistenceOrExternal}]`
      )
      .join("\n")}`,
    jsonStructureHint: STAGE3_JSON_HINT,
  });

  return envelope.criteria;
}
