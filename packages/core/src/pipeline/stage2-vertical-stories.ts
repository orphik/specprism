import { z } from "zod";
import {
  type Feature,
  FeatureSchema,
  type SocraticTriage,
  type VerticalStory,
} from "../schemas/index.js";
import type { LlmProviderClient } from "../llm/provider-router.js";

const HORIZONTAL_PLACEHOLDER_PATTERNS = [
  /^n\/?a$/i,
  /^none$/i,
  /^null$/i,
  /^tbd$/i,
  /^todo$/i,
  /^db\s*only$/i,
  /^ui\s*only$/i,
  /^api\s*only$/i,
  /^not\s+applicable$/i,
];

function isHorizontalStub(value: string): boolean {
  const clean = value.trim();
  if (clean.length < 3) return true;
  return HORIZONTAL_PLACEHOLDER_PATTERNS.some((rx) => rx.test(clean));
}

export function assertVerticalStorySlices(
  items: ReadonlyArray<Feature | VerticalStory>
): void {
  const stories: VerticalStory[] = items.flatMap((item) =>
    "stories" in item && Array.isArray(item.stories) ? item.stories : [item as VerticalStory]
  );
  for (const story of stories) {
    const { entrySurface, domainLogic, persistenceOrExternal } = story.touchpoints;
    if (
      isHorizontalStub(entrySurface) ||
      isHorizontalStub(domainLogic) ||
      isHorizontalStub(persistenceOrExternal)
    ) {
      throw new Error(
        `Horizontal slice rejected on ${story.id} ("${story.title}"): every story must exercise a concrete entrySurface, domainLogic, and persistenceOrExternal boundary.`
      );
    }
  }
}

const Stage2EnvelopeSchema = z
  .object({
    features: z.array(FeatureSchema).min(1),
  })
  .superRefine((val, ctx) => {
    try {
      assertVerticalStorySlices(val.features);
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: err instanceof Error ? err.message : "Horizontal slice violation",
        path: ["features"],
      });
    }
  });

const STAGE2_JSON_HINT = `{
  "features": [
    {
      "id": "FEAT-01",
      "title": "Feature Name",
      "outcomeSummary": "Measurable user outcome",
      "stories": [
        {
          "id": "US-001",
          "featureId": "FEAT-01",
          "sliceOrder": 1,
          "title": "End-to-end vertical capability",
          "asA": "Primary Actor",
          "iWant": "concrete capability",
          "soThat": "verifiable value",
          "independentDemoProof": "Exact end-to-end action proving this slice works standalone",
          "touchpoints": {
            "entrySurface": "Concrete UI/API/CLI entrypoint",
            "domainLogic": "Concrete validation/business rule",
            "persistenceOrExternal": "Concrete DB table or external integration"
          },
          "linkedAssumptionIds": ["ASM-001"]
        }
      ]
    }
  ]
}`;

export async function runStage2VerticalStories(input: {
  triage: SocraticTriage;
  llm: LlmProviderClient;
}): Promise<Feature[]> {
  const validAsmIds = new Set(input.triage.lockedAssumptions.map((a) => a.id));

  const envelope = await input.llm.generateStructured({
    schemaName: "Stage2VerticalFeatures",
    schema: Stage2EnvelopeSchema,
    systemPrompt:
      "You are SpecPrism Stage 2 — Vertical-Slice Story Architect. Decompose the scoped vision and locked assumptions into 1–2 cohesive features (FEAT-01, FEAT-02) containing 3–5 total high-leverage vertical user stories (US-001..US-005 max). Keep v1 tight and actionable. NEVER create horizontal tasks like 'Set up database schema' or 'Build frontend shell'. Every US-* MUST traverse entrySurface, domainLogic, and persistenceOrExternal.",
    userPrompt: `Scoped Vision: ${input.triage.scopedVisionSummary}\nActors: ${input.triage.primaryActors.join(
      ", "
    )}\nOut-of-Scope v1: ${input.triage.explicitOutOfScopeV1.join(
      "; "
    )}\nLocked Assumptions:\n${input.triage.lockedAssumptions
      .map((a) => `- ${a.id} (${a.dimension}): ${a.statement}`)
      .join("\n")}`,
    jsonStructureHint: STAGE2_JSON_HINT,
  });

  // Sanitize linkedAssumptionIds to known ASM-* IDs
  const normalized = envelope.features.map((feat) => ({
    ...feat,
    stories: feat.stories.map((story) => ({
      ...story,
      featureId: feat.id,
      linkedAssumptionIds: story.linkedAssumptionIds.filter((id) => validAsmIds.has(id)),
    })),
  }));

  assertVerticalStorySlices(normalized);
  return normalized;
}
