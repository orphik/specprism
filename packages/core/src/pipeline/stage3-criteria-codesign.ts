import { z } from "zod";
import {
  type AcceptanceCriterion,
  AcceptanceCriterionSchema,
  type Feature,
  type RepoSurfaceContext,
  type SocraticTriage,
  type VerticalStory,
} from "../schemas/index.js";
import type { LlmProviderClient } from "../llm/provider-router.js";
import { formatRepoSurfacePromptBlock } from "../surface/repo-surface.js";
import { STAGE3_MALICIOUS_COMPLIANCE_DIRECTIVE } from "./loophole-taxonomy.js";

const STAGE3_JSON_HINT = `{
  "criteria": [
    {
      "id": "REQ-001",
      "storyId": "US-001",
      "category": "happy_path | negative_edge_case | non_functional_guardrail",
      "exploitClass": "optional: orphaned_state | partial_mutation | auth_boundary_leak | concurrency_race | blast_radius_scale | silent_fallback",
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

async function generateCriteriaForStorySlice(
  triage: SocraticTriage,
  storySlice: VerticalStory[],
  llm: LlmProviderClient,
  repoSurface?: RepoSurfaceContext
): Promise<AcceptanceCriterion[]> {
  const validStoryIds = new Set(storySlice.map((s) => s.id));

  const SliceEnvelopeSchema = z
    .object({
      criteria: z.array(AcceptanceCriterionSchema).min(storySlice.length),
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

  const envelope = await llm.generateStructured({
    schemaName: "Stage3AcceptanceCriteria",
    schema: SliceEnvelopeSchema,
    systemPrompt: `You are SpecPrism Stage 3 — Acceptance Criteria & EARS Guardrail Co-Designer. For each vertical story (US-*) provided below, generate 2–3 high-signal acceptance criteria (REQ-001, REQ-002...) spanning happy_path, negative_edge_case, and non_functional_guardrail categories with Given/When/Then, canonical EARS ('WHEN ... THE <system> SHALL ...'), and concise QA coaching callouts.\n\n${STAGE3_MALICIOUS_COMPLIANCE_DIRECTIVE}`,
    userPrompt: `Scoped Vision: ${triage.scopedVisionSummary}\nLocked Assumptions:\n${triage.lockedAssumptions
      .map((a) => `- ${a.id}: ${a.statement}`)
      .join("\n")}\n\nVertical Stories to Cover:\n${storySlice
      .map(
        (s) =>
          `- ${s.id} (${s.title}): As a ${s.asA}, I want ${s.iWant} so that ${s.soThat} [Entry: ${s.touchpoints.entrySurface} | Logic: ${s.touchpoints.domainLogic} | Persistence: ${s.touchpoints.persistenceOrExternal}]`
      )
      .join("\n")}${formatRepoSurfacePromptBlock(repoSurface)}`,
    jsonStructureHint: STAGE3_JSON_HINT,
  });

  return envelope.criteria;
}

function renumberCriteriaByStoryOrder(
  storyOrder: Map<string, number>,
  rawCriteria: AcceptanceCriterion[]
): AcceptanceCriterion[] {
  const sorted = [...rawCriteria].sort(
    (a, b) => (storyOrder.get(a.storyId) ?? 999) - (storyOrder.get(b.storyId) ?? 999)
  );
  return sorted.map((c, idx) => ({
    ...c,
    id: `REQ-${String(idx + 1).padStart(3, "0")}`,
  }));
}

export async function runStage3CriteriaCoDesign(input: {
  triage: SocraticTriage;
  features: Feature[];
  llm: LlmProviderClient;
  repoSurface?: RepoSurfaceContext;
  chunkSize?: number;
  onPartialCriteria?: (
    partialCriteria: AcceptanceCriterion[],
    completedChunks: number,
    totalChunks: number
  ) => void;
}): Promise<AcceptanceCriterion[]> {
  const allStories = input.features.flatMap((f) => f.stories);
  const storyOrder = new Map(allStories.map((s, idx) => [s.id, idx]));

  const effectiveChunkSize =
    input.chunkSize ?? (input.onPartialCriteria && allStories.length > 1 ? 1 : allStories.length);

  if (!input.onPartialCriteria || allStories.length <= effectiveChunkSize) {
    const single = await generateCriteriaForStorySlice(
      input.triage,
      allStories,
      input.llm,
      input.repoSurface
    );
    const numbered = renumberCriteriaByStoryOrder(storyOrder, single);
    input.onPartialCriteria?.(numbered, 1, 1);
    return numbered;
  }

  const chunks: VerticalStory[][] = [];
  for (let i = 0; i < allStories.length; i += effectiveChunkSize) {
    chunks.push(allStories.slice(i, i + effectiveChunkSize));
  }

  const collectedByChunk: Array<AcceptanceCriterion[] | null> = chunks.map(() => null);
  let completed = 0;
  const maxConcurrency = 4;
  let nextIdx = 0;

  async function worker() {
    while (nextIdx < chunks.length) {
      const idx = nextIdx++;
      const res = await generateCriteriaForStorySlice(
        input.triage,
        chunks[idx]!,
        input.llm,
        input.repoSurface
      );
      collectedByChunk[idx] = res;
      completed += 1;
      const flattened = collectedByChunk
        .filter((item): item is AcceptanceCriterion[] => item !== null)
        .flat();
      input.onPartialCriteria?.(
        renumberCriteriaByStoryOrder(storyOrder, flattened),
        completed,
        chunks.length
      );
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(maxConcurrency, chunks.length) }, () => worker())
  );

  const finalFlat = collectedByChunk
    .filter((item): item is AcceptanceCriterion[] => item !== null)
    .flat();
  return renumberCriteriaByStoryOrder(storyOrder, finalFlat);
}
