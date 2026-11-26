import { z } from "zod";

export const AssumptionIdSchema = z.string().regex(/^ASM-\d{3,}$/);
export const FeatureIdSchema = z.string().regex(/^FEAT-\d{2,}$/);
export const StoryIdSchema = z.string().regex(/^US-\d{3,}$/);
export const ReqIdSchema = z.string().regex(/^REQ-\d{3,}$/);
export const TestCaseIdSchema = z.string().regex(/^TC-\d{3,}$/);
export const DeltaIdSchema = z.string().regex(/^DLT-\d{3,}$/);

export const PipelineStageSchema = z.enum([
  "stage_1_triage",
  "stage_2_stories",
  "stage_3_criteria",
  "stage_4_tests",
  "stage_5_delta",
]);

export const AmbiguityDimensionSchema = z.enum([
  "actors_and_roles",
  "v1_out_of_scope_boundary",
  "failure_and_recovery_states",
  "security_auth_and_rate_limits",
  "data_ownership_and_retention",
]);

export const ClarifyingOptionSchema = z.object({
  id: z.string(),
  label: z.string().min(3).max(160),
  tradeoffNote: z.string().max(240),
  recommended: z.boolean().default(false),
});

export const ClarifyingQuestionSchema = z.object({
  id: z.string(),
  dimension: AmbiguityDimensionSchema,
  detectedAmbiguity: z.string(),
  question: z.string(),
  options: z.array(ClarifyingOptionSchema).min(2).max(4),
  selectedOptionId: z.string().optional(),
  customUserOverride: z.string().optional(),
});

export const AssumptionSchema = z.object({
  id: AssumptionIdSchema,
  dimension: AmbiguityDimensionSchema,
  statement: z.string(),
  source: z.enum(["user_confirmed", "user_edited", "defaulted_explicit"]),
});

export const SocraticTriageSchema = z.object({
  projectTitle: z.string().min(3).max(80).optional(),
  rawPrompt: z.string().min(5).max(8_000),
  scopedVisionSummary: z.string(),
  primaryActors: z.array(z.string()).min(1),
  explicitOutOfScopeV1: z.array(z.string()).min(1),
  questions: z.array(ClarifyingQuestionSchema).max(6).default([]),
  lockedAssumptions: z.array(AssumptionSchema),
});

export const VerticalTouchpointsSchema = z.object({
  entrySurface: z.string().min(2),
  domainLogic: z.string().min(2),
  persistenceOrExternal: z.string().min(2),
});

export const VerticalStorySchema = z.object({
  id: StoryIdSchema,
  featureId: FeatureIdSchema,
  sliceOrder: z.number().int().positive(),
  title: z.string(),
  asA: z.string(),
  iWant: z.string(),
  soThat: z.string(),
  independentDemoProof: z.string(),
  touchpoints: VerticalTouchpointsSchema,
  linkedAssumptionIds: z.array(AssumptionIdSchema),
});

export const FeatureSchema = z.object({
  id: FeatureIdSchema,
  title: z.string(),
  outcomeSummary: z.string(),
  stories: z.array(VerticalStorySchema).min(1),
});

export const CriterionCategorySchema = z.enum([
  "happy_path",
  "negative_edge_case",
  "non_functional_guardrail",
]);

export const EarsPatternSchema = z.enum([
  "ubiquitous",
  "event_driven",
  "state_driven",
  "unwanted_event",
  "optional",
]);

export const GivenWhenThenSchema = z.object({
  given: z.array(z.string()).min(1),
  when: z.string(),
  then: z.array(z.string()).min(1),
});

export const EarsStatementSchema = z.object({
  pattern: EarsPatternSchema,
  systemName: z.string(),
  triggerOrCondition: z.string().optional(),
  shallResponse: z.string(),
  rendered: z.string(),
});

export const CoachingCalloutSchema = z.object({
  whyItMatters: z.string(),
  failureModePrevented: z.string(),
});

export const AcceptanceCriterionSchema = z.object({
  id: ReqIdSchema,
  storyId: StoryIdSchema,
  category: CriterionCategorySchema,
  title: z.string(),
  gwt: GivenWhenThenSchema,
  ears: EarsStatementSchema,
  coaching: CoachingCalloutSchema,
});

export const VerificationTierSchema = z.enum([
  "unit",
  "api_contract",
  "e2e_playwright",
  "gherkin_bdd",
]);

export const TestCaseSchema = z.object({
  id: TestCaseIdSchema,
  title: z.string(),
  tier: VerificationTierSchema,
  verifiesReqIds: z.array(ReqIdSchema).min(1),
  targetFilePath: z.string(),
  gherkinScenario: z.string().optional(),
  skeletonCode: z.string(),
  deterministicAssertions: z.array(z.string()).min(1),
});

export const DeltaOperationSchema = z.enum(["ADDED", "MODIFIED", "REMOVED"]);

export const TestImpactStatusSchema = z.enum([
  "regression_shield",
  "requires_update",
  "new_test_required",
  "obsolete",
]);

export const RequirementDeltaSchema = z.object({
  id: DeltaIdSchema,
  operation: DeltaOperationSchema,
  reqId: ReqIdSchema,
  storyId: StoryIdSchema,
  previousEars: z.string().optional(),
  nextEars: z.string().optional(),
  rationale: z.string(),
});

export const TestImpactEntrySchema = z.object({
  testCaseId: TestCaseIdSchema,
  status: TestImpactStatusSchema,
  affectedReqIds: z.array(ReqIdSchema),
  actionSummary: z.string(),
});

export const SpecDeltaSchema = z.object({
  baseIterationNumber: z.number().int().positive(),
  targetIterationNumber: z.number().int().positive(),
  userChangePrompt: z.string(),
  impactedStoryIds: z.array(StoryIdSchema),
  requirementDeltas: z.array(RequirementDeltaSchema),
  testImpacts: z.array(TestImpactEntrySchema),
});

export const DialectProfileSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  version: z.string(),
  lastVerifiedAt: z.string().datetime(),
  modelMatchers: z.array(z.string()).min(1),
  structuralFormat: z.enum(["xml_tags", "markdown_headings", "hybrid_json_fence"]),
  reasoningStrategy: z.enum([
    "native_reasoning_no_manual_cot",
    "guided_stepwise_plan",
    "compact_direct_execution",
  ]),
  rules: z.object({
    avoidPhrases: z.array(z.string()).default([]),
    systemFramingTemplate: z.string(),
    handoffSectionOrder: z.array(z.string()).min(1),
    toolUseGuidance: z.string(),
  }),
  coachAnnotations: z.array(
    z.object({
      ruleKey: z.string(),
      badgeLabel: z.string(),
      explanation: z.string(),
    })
  ),
});

export const McpRecommendationSchema = z.object({
  registryId: z.string(),
  displayName: z.string(),
  transport: z.enum(["stdio", "streamable_http"]),
  serverUrlOrCommand: z.string(),
  whyRecommended: z.string(),
  matchedStoryIds: z.array(StoryIdSchema),
});

export const SpecIterationDocumentSchema = z
  .object({
    projectId: z.string().uuid(),
    iterationNumber: z.number().int().positive(),
    stage: PipelineStageSchema,
    triage: SocraticTriageSchema,
    features: z.array(FeatureSchema),
    criteria: z.array(AcceptanceCriterionSchema),
    testCases: z.array(TestCaseSchema),
    recommendedMcps: z.array(McpRecommendationSchema),
    targetDialectId: z.string(),
    preferredModelId: z.string().optional(),
    delta: SpecDeltaSchema.optional(),
    createdAt: z.string().datetime(),
  })
  .superRefine((doc, ctx) => {
    if (doc.stage === "stage_4_tests" || doc.stage === "stage_5_delta") {
      const coveredReqs = new Set(doc.testCases.flatMap((tc) => tc.verifiesReqIds));
      for (const req of doc.criteria) {
        if (!coveredReqs.has(req.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Orphan requirement ${req.id} has no verifying TC-* test case.`,
            path: ["criteria"],
          });
        }
      }
    }
  });

export const StatelessMcpRequestStateSchema = z.object({
  protocolVersion: z.literal("2026-07-28"),
  projectId: z.string().uuid(),
  iterationNumber: z.number().int().positive(),
  pendingStage: PipelineStageSchema,
  elicitationRound: z.number().int().min(0).max(5),
  draftTriageHash: z.string(),
  expiresAtEpochMs: z.number().int(),
  signature: z.string().min(16),
});

export type PipelineStage = z.infer<typeof PipelineStageSchema>;
export type AmbiguityDimension = z.infer<typeof AmbiguityDimensionSchema>;
export type ClarifyingQuestion = z.infer<typeof ClarifyingQuestionSchema>;
export type Assumption = z.infer<typeof AssumptionSchema>;
export type SocraticTriage = z.infer<typeof SocraticTriageSchema>;
export type VerticalStory = z.infer<typeof VerticalStorySchema>;
export type Feature = z.infer<typeof FeatureSchema>;
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;
export type VerificationTier = z.infer<typeof VerificationTierSchema>;
export type TestCase = z.infer<typeof TestCaseSchema>;
export type RequirementDelta = z.infer<typeof RequirementDeltaSchema>;
export type TestImpactEntry = z.infer<typeof TestImpactEntrySchema>;
export type SpecDelta = z.infer<typeof SpecDeltaSchema>;
export type McpRecommendation = z.infer<typeof McpRecommendationSchema>;
export type SpecIterationDocument = z.infer<typeof SpecIterationDocumentSchema>;
export type DialectProfile = z.infer<typeof DialectProfileSchema>;
export type StatelessMcpRequestState = z.infer<typeof StatelessMcpRequestStateSchema>;
