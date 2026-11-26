import type { DialectProfile, SpecIterationDocument } from "../schemas/index.js";

function stripAvoidedPhrases(input: string, avoidPhrases: string[]): string {
  let out = input;
  for (const phrase of avoidPhrases) {
    if (!phrase.trim()) continue;
    const rx = new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    out = out.replace(rx, "");
  }
  return out;
}

export function compileAgentHandoffPrompt(
  doc: SpecIterationDocument,
  dialect: DialectProfile
): {
  prompt: string;
  appliedAnnotations: DialectProfile["coachAnnotations"];
} {
  const allStories = doc.features.flatMap((f) => f.stories);

  const visionLines = [
    `Vision: ${doc.triage.scopedVisionSummary}`,
    `Primary Actors: ${doc.triage.primaryActors.join(", ")}`,
    `Explicit v1 Out-of-Scope Boundaries: ${doc.triage.explicitOutOfScopeV1.join("; ")}`,
  ].join("\n");

  const assumptionLines = doc.triage.lockedAssumptions
    .map((a) => `- [${a.id}] (${a.dimension}): ${a.statement}`)
    .join("\n");

  const storyLines = allStories
    .map(
      (s) =>
        `- [${s.id}] ${s.title}\n  As a ${s.asA}, I want ${s.iWant} so that ${s.soThat}\n  Vertical Slice: Entry=${s.touchpoints.entrySurface} | Domain=${s.touchpoints.domainLogic} | Persistence=${s.touchpoints.persistenceOrExternal}\n  Demo Proof: ${s.independentDemoProof}`
    )
    .join("\n\n");

  const criteriaLines = doc.criteria
    .map(
      (c) =>
        `- [${c.id}] (${c.storyId} · ${c.category}) ${c.title}\n  EARS: ${c.ears.rendered}\n  Guardrail Rationale: ${c.coaching.whyItMatters}`
    )
    .join("\n\n");

  const testLines = doc.testCases
    .map(
      (tc) =>
        `- [${tc.id}] (${tc.tier}) -> Verifies ${tc.verifiesReqIds.join(", ")}\n  File: ${
          tc.targetFilePath
        }\n  Assertions: ${tc.deterministicAssertions.join("; ")}`
    )
    .join("\n\n");

  const mcpLines =
    doc.recommendedMcps.length > 0
      ? doc.recommendedMcps
          .map((m) => `- ${m.displayName} (${m.registryId}): ${m.whyRecommended}`)
          .join("\n")
      : "- No external MCP servers required beyond standard workspace filesystem & test runner.";

  let body: string;
  if (dialect.structuralFormat === "xml_tags") {
    body = [
      dialect.rules.systemFramingTemplate.trim(),
      "",
      `<scoped_vision>\n${visionLines}\n</scoped_vision>`,
      "",
      `<locked_assumptions>\n${assumptionLines}\n</locked_assumptions>`,
      "",
      `<vertical_story>\n${storyLines}\n</vertical_story>`,
      "",
      `<acceptance_criteria_ears>\n${criteriaLines}\n</acceptance_criteria_ears>`,
      "",
      `<traceable_test_plan>\n${testLines}\n</traceable_test_plan>`,
      "",
      `<recommended_mcp_tools>\n${mcpLines}\n</recommended_mcp_tools>`,
      "",
      `<execution_directive>\n${dialect.rules.toolUseGuidance.trim()}\nImplement each US-* slice using strict Red -> Green -> Refactor TDD: write/enable the mapped TC-* tests first, implement the vertical slice, and verify zero failing assertions.\n</execution_directive>`,
    ].join("\n");
  } else if (dialect.structuralFormat === "hybrid_json_fence") {
    const compactContract = {
      vision: doc.triage.scopedVisionSummary,
      nonGoals: doc.triage.explicitOutOfScopeV1,
      stories: allStories.map((s) => ({ id: s.id, title: s.title, touchpoints: s.touchpoints })),
      requirements: doc.criteria.map((c) => ({ id: c.id, storyId: c.storyId, ears: c.ears.rendered })),
      tests: doc.testCases.map((t) => ({
        id: t.id,
        verifies: t.verifiesReqIds,
        file: t.targetFilePath,
      })),
    };
    body = [
      dialect.rules.systemFramingTemplate.trim(),
      "",
      "```json",
      JSON.stringify(compactContract, null, 2),
      "```",
      "",
      dialect.rules.toolUseGuidance.trim(),
    ].join("\n");
  } else {
    body = [
      `# ${dialect.displayName}`,
      dialect.rules.systemFramingTemplate.trim(),
      "",
      `## Scoped Vision & Non-Goals\n${visionLines}`,
      "",
      `## Locked Assumptions\n${assumptionLines}`,
      "",
      `## Vertical Stories\n${storyLines}`,
      "",
      `## Acceptance Criteria (EARS)\n${criteriaLines}`,
      "",
      `## Verification Matrix (REQ -> TC)\n${testLines}`,
      "",
      `## Recommended MCP Servers\n${mcpLines}`,
      "",
      `## Execution Protocol\n${dialect.rules.toolUseGuidance.trim()}`,
    ].join("\n");
  }

  return {
    prompt: stripAvoidedPhrases(body, dialect.rules.avoidPhrases),
    appliedAnnotations: dialect.coachAnnotations,
  };
}

export interface DialectDiffHighlight {
  aspect: string;
  primaryValue: string;
  comparisonValue: string;
  whyItMatters: string;
}

export interface AnnotatedDialectDiffResult {
  primaryDialectId: string;
  comparisonDialectId: string;
  primaryPrompt: string;
  comparisonPrompt: string;
  highlights: DialectDiffHighlight[];
}

function formatFormatLabel(fmt: DialectProfile["structuralFormat"]): string {
  if (fmt === "xml_tags") return "Semantic XML Tags (<scoped_vision>, <acceptance_criteria_ears>)";
  if (fmt === "hybrid_json_fence") return "Compact JSON Contract Fence (```json)";
  return "Flat Markdown Headings (## Developer Contract)";
}

function formatReasoningLabel(rs: DialectProfile["reasoningStrategy"]): string {
  if (rs === "native_reasoning_no_manual_cot") return "Native Reasoning (Zero Manual CoT)";
  if (rs === "compact_direct_execution") return "Compact Direct Execution (Low Token Overhead)";
  return "Guided Stepwise File Plan";
}

export function compileAnnotatedDialectDiff(
  doc: SpecIterationDocument,
  primaryDialect: DialectProfile,
  comparisonDialect: DialectProfile
): AnnotatedDialectDiffResult {
  const primary = compileAgentHandoffPrompt(doc, primaryDialect);
  const comparison = compileAgentHandoffPrompt(doc, comparisonDialect);

  const highlights: DialectDiffHighlight[] = [
    {
      aspect: "Prompt Structural Framing",
      primaryValue: formatFormatLabel(primaryDialect.structuralFormat),
      comparisonValue: formatFormatLabel(comparisonDialect.structuralFormat),
      whyItMatters:
        primaryDialect.structuralFormat === comparisonDialect.structuralFormat
          ? "Both model families share the same top-level delimiter preference, differing in framing order and tool guidance."
          : "Matching a vendor's native training delimiters (XML tags for Claude/Gemini vs. Markdown sections for GPT/DeepSeek vs. JSON fences for local models) prevents boundary bleed between assumptions and EARS rules.",
    },
    {
      aspect: "Reasoning & Deliberation Policy",
      primaryValue: formatReasoningLabel(primaryDialect.reasoningStrategy),
      comparisonValue: formatReasoningLabel(comparisonDialect.reasoningStrategy),
      whyItMatters:
        "Frontier reasoning models degrade when forced to 'think step by step' in visible text, whereas compact/coder models benefit from explicit file-by-file sequencing.",
    },
    {
      aspect: "Filtered Anti-Pattern Phrases",
      primaryValue:
        primaryDialect.rules.avoidPhrases.length > 0
          ? primaryDialect.rules.avoidPhrases.map((p) => `"${p}"`).join(", ")
          : "None stripped",
      comparisonValue:
        comparisonDialect.rules.avoidPhrases.length > 0
          ? comparisonDialect.rules.avoidPhrases.map((p) => `"${p}"`).join(", ")
          : "None stripped",
      whyItMatters:
        "Automatically strips legacy prompt-engineering clichés that waste reasoning tokens or trigger verbose preamble filler.",
    },
  ];

  return {
    primaryDialectId: primaryDialect.id,
    comparisonDialectId: comparisonDialect.id,
    primaryPrompt: primary.prompt,
    comparisonPrompt: comparison.prompt,
    highlights,
  };
}
