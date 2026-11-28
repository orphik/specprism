import { z } from "zod";
import {
  type Assumption,
  ClarifyingQuestionSchema,
  type RepoSurfaceContext,
  type SocraticTriage,
  SocraticTriageSchema,
} from "../schemas/index.js";
import type { LlmProviderClient } from "../llm/provider-router.js";
import { formatRepoSurfacePromptBlock } from "../surface/repo-surface.js";
import { STAGE1_MALICIOUS_COMPLIANCE_DIRECTIVE } from "./loophole-taxonomy.js";

const Stage1LlmOutputSchema = SocraticTriageSchema.extend({
  questions: z.array(ClarifyingQuestionSchema).min(3).max(4),
});

const STAGE1_JSON_HINT = `{
  "projectTitle": "3-6 word crisp product title (no trailing punctuation)",
  "rawPrompt": "string",
  "scopedVisionSummary": "1-2 sentence crisp product summary",
  "primaryActors": ["Actor 1", "Actor 2"],
  "explicitOutOfScopeV1": ["Explicit non-goal 1", "Explicit non-goal 2"],
  "questions": [
    {
      "id": "q-1",
      "dimension": "actors_and_roles | v1_out_of_scope_boundary | failure_and_recovery_states | security_auth_and_rate_limits | data_ownership_and_retention",
      "exploitClass": "optional: orphaned_state | partial_mutation | auth_boundary_leak | concurrency_race | blast_radius_scale | silent_fallback",
      "detectedAmbiguity": "What was unstated in the prompt",
      "question": "Sharp clarifying question?",
      "options": [
        { "id": "opt-1", "label": "Recommended concrete choice", "tradeoffNote": "Why & trade-off", "recommended": true },
        { "id": "opt-2", "label": "Alternative choice", "tradeoffNote": "Why & trade-off", "recommended": false }
      ]
    }
  ],
  "lockedAssumptions": []
}`;

export async function runStage1SocraticTriage(input: {
  rawPrompt: string;
  llm: LlmProviderClient;
  repoSurface?: RepoSurfaceContext;
}): Promise<SocraticTriage> {
  const cleanPrompt = input.rawPrompt.trim();
  const surfaceBlock = formatRepoSurfacePromptBlock(input.repoSurface);
  const result = await input.llm.generateStructured({
    schemaName: "Stage1SocraticTriage",
    schema: Stage1LlmOutputSchema,
    systemPrompt: `You are SpecPrism Stage 1 — a principal product & QA co-architect. Analyze rough software prompts, expose hidden ambiguity forks, propose explicit v1 non-goals to prevent scope creep, and ask 3 to 4 sharp multiple-choice clarifying questions covering actors, out-of-scope boundaries, failure recovery, and security/rate-limits.\n\n${STAGE1_MALICIOUS_COMPLIANCE_DIRECTIVE}`,
    userPrompt: `Analyze this raw product idea and generate Stage 1 Socratic Triage:\n\n"${cleanPrompt}"\n\nSet rawPrompt to the exact input above and leave lockedAssumptions as [].${surfaceBlock}`,
    jsonStructureHint: STAGE1_JSON_HINT,
  });

  return {
    ...result,
    rawPrompt: cleanPrompt,
  };
}

export interface TriageQuestionAnswer {
  questionId: string;
  selectedOptionId?: string;
  customUserOverride?: string;
}

export function lockStage1Assumptions(
  triage: SocraticTriage,
  answers: TriageQuestionAnswer[]
): SocraticTriage {
  const answerMap = new Map(answers.map((a) => [a.questionId, a]));
  const lockedAssumptions: Assumption[] = [];

  const updatedQuestions = triage.questions.map((q, index) => {
    const ans = answerMap.get(q.id);
    const asmId = `ASM-${String(index + 1).padStart(3, "0")}`;
    const customText = ans?.customUserOverride?.trim();

    if (customText) {
      lockedAssumptions.push({
        id: asmId,
        dimension: q.dimension,
        statement: customText,
        source: "user_edited",
      });
      return { ...q, customUserOverride: customText, selectedOptionId: undefined };
    }

    if (ans?.selectedOptionId) {
      const picked = q.options.find((o) => o.id === ans.selectedOptionId) ?? q.options[0];
      lockedAssumptions.push({
        id: asmId,
        dimension: q.dimension,
        statement: `${q.question} -> ${picked?.label ?? ""}`.trim(),
        source: "user_confirmed",
      });
      return { ...q, selectedOptionId: picked?.id, customUserOverride: undefined };
    }

    const recommended = q.options.find((o) => o.recommended) ?? q.options[0];
    lockedAssumptions.push({
      id: asmId,
      dimension: q.dimension,
      statement: `${q.question} -> ${recommended?.label ?? ""}`.trim(),
      source: "defaulted_explicit",
    });
    return { ...q, selectedOptionId: recommended?.id, customUserOverride: undefined };
  });

  return SocraticTriageSchema.parse({
    ...triage,
    questions: updatedQuestions,
    lockedAssumptions,
  });
}
