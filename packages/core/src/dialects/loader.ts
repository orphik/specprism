import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { type DialectProfile, DialectProfileSchema } from "../schemas/index.js";

export const BUILTIN_DIALECT_PROFILES: DialectProfile[] = [
  {
    id: "anthropic-claude",
    displayName: "Anthropic Claude Family (XML + Native Adaptive Thinking)",
    version: "2026.11.1",
    lastVerifiedAt: "2026-11-26T00:00:00.000Z",
    modelMatchers: ["anthropic/claude-*", "claude-*"],
    structuralFormat: "xml_tags",
    reasoningStrategy: "native_reasoning_no_manual_cot",
    rules: {
      avoidPhrases: ["think step by step", "take a deep breath"],
      systemFramingTemplate:
        "You are implementing a verified SpecPrism vertical slice. Follow every EARS acceptance criterion and execute tests red-to-green.",
      handoffSectionOrder: [
        "<scoped_vision>",
        "<locked_assumptions>",
        "<vertical_story>",
        "<acceptance_criteria_ears>",
        "<traceable_test_plan>",
        "<recommended_mcp_tools>",
      ],
      toolUseGuidance:
        "Batch independent file reads and searches in parallel turns. Run the linked TC-* verification suite immediately after edits.",
    },
    coachAnnotations: [
      {
        ruleKey: "xml_tags",
        badgeLabel: "Semantic XML Boundaries",
        explanation:
          "Claude models parse nested specification contracts most reliably when assumptions, EARS rules, and test IDs are isolated in distinct XML tags.",
      },
      {
        ruleKey: "native_reasoning_no_manual_cot",
        badgeLabel: "Native Adaptive Thinking",
        explanation:
          "Omits manual 'think step-by-step' filler so Claude's native reasoning budget focuses directly on REQ-* to TC-* invariants.",
      },
    ],
  },
  {
    id: "openai-gpt-reasoning",
    displayName: "OpenAI GPT & o-Series Reasoning (Markdown Developer Contract)",
    version: "2026.11.1",
    lastVerifiedAt: "2026-11-26T00:00:00.000Z",
    modelMatchers: ["openai/gpt-*", "openai/o*", "gpt-*", "o1*", "o3*", "o4*"],
    structuralFormat: "markdown_headings",
    reasoningStrategy: "native_reasoning_no_manual_cot",
    rules: {
      avoidPhrases: ["think step by step", "explain your reasoning first"],
      systemFramingTemplate:
        "Developer Contract: Implement each vertical slice strictly to satisfy all EARS acceptance criteria and pass the mapped TC-* suites.",
      handoffSectionOrder: [
        "## Scoped Vision & Non-Goals",
        "## Locked Assumptions",
        "## Vertical Stories",
        "## Acceptance Criteria (EARS)",
        "## Verification Matrix (REQ -> TC)",
      ],
      toolUseGuidance:
        "Prefer parallel tool calls for codebase exploration and run deterministic test commands before completion.",
    },
    coachAnnotations: [
      {
        ruleKey: "markdown_headings",
        badgeLabel: "Flat Markdown Hierarchy",
        explanation:
          "OpenAI reasoning models adhere cleanly to flat Markdown developer contracts with explicit non-goal checklists.",
      },
    ],
  },
  {
    id: "google-gemini",
    displayName: "Google Gemini Family (Context-First + Constraint-Last Grounding)",
    version: "2026.11.1",
    lastVerifiedAt: "2026-11-26T00:00:00.000Z",
    modelMatchers: ["google/gemini-*", "gemini-*"],
    structuralFormat: "xml_tags",
    reasoningStrategy: "native_reasoning_no_manual_cot",
    rules: {
      avoidPhrases: ["think step by step"],
      systemFramingTemplate:
        "Ground your implementation strictly in the specification artifacts below, placing highest priority on the final execution checklist.",
      handoffSectionOrder: [
        "<scoped_vision>",
        "<locked_assumptions>",
        "<vertical_story>",
        "<acceptance_criteria_ears>",
        "<traceable_test_plan>",
      ],
      toolUseGuidance:
        "Issue parallel read/search calls upfront and verify all TC-* assertions in one consolidated test run.",
    },
    coachAnnotations: [
      {
        ruleKey: "context_first_directive_last",
        badgeLabel: "Context-First Ordering",
        explanation:
          "Places full reference context before the final TDD execution directive to maximize Gemini long-context recall.",
      },
    ],
  },
  {
    id: "deepseek-reasoning",
    displayName: "DeepSeek R-Series Reasoning (Minimal System + Direct User Contract)",
    version: "2026.11.1",
    lastVerifiedAt: "2026-11-26T00:00:00.000Z",
    modelMatchers: ["deepseek/*", "deepseek-*"],
    structuralFormat: "markdown_headings",
    reasoningStrategy: "native_reasoning_no_manual_cot",
    rules: {
      avoidPhrases: ["think step by step", "let's think", "act as an expert"],
      systemFramingTemplate:
        "Implement the specification below with strict Red-Green-Refactor test verification. Rely on native <think> deliberation without repeating reasoning in code output.",
      handoffSectionOrder: [
        "## Scoped Vision & Non-Goals",
        "## Locked Assumptions",
        "## Vertical Stories",
        "## Acceptance Criteria (EARS)",
        "## Verification Matrix (REQ -> TC)",
      ],
      toolUseGuidance:
        "Keep system instructions minimal and place all constraints directly in the task body. Run all TC-* assertions before finishing.",
    },
    coachAnnotations: [
      {
        ruleKey: "minimal_system_role",
        badgeLabel: "Minimal System Preamble",
        explanation:
          "DeepSeek R-series reasoning models perform best when heavy persona prompts are omitted and constraints live directly in the user contract.",
      },
    ],
  },
  {
    id: "qwen-coder",
    displayName: "Qwen Coder Family (File-Scoped Blocks + Deterministic Tooling)",
    version: "2026.11.1",
    lastVerifiedAt: "2026-11-26T00:00:00.000Z",
    modelMatchers: ["qwen/*", "qwen-*"],
    structuralFormat: "markdown_headings",
    reasoningStrategy: "guided_stepwise_plan",
    rules: {
      avoidPhrases: [],
      systemFramingTemplate:
        "Repository Implementation Plan: Execute one vertical story slice at a time, aligning exact targetFilePath test files with each REQ-* EARS criterion.",
      handoffSectionOrder: [
        "## Scoped Vision & Non-Goals",
        "## Locked Assumptions",
        "## Vertical Stories",
        "## Acceptance Criteria (EARS)",
        "## Verification Matrix (REQ -> TC)",
      ],
      toolUseGuidance:
        "Group edits by explicit repository file paths and run Vitest/Playwright immediately after completing each slice.",
    },
    coachAnnotations: [
      {
        ruleKey: "file_path_grounding",
        badgeLabel: "Explicit File-Path Anchoring",
        explanation:
          "Qwen Coder models excel when target repository paths and verification commands are foregrounded alongside each story slice.",
      },
    ],
  },
  {
    id: "local-ollama-default",
    displayName: "Local / Compact Open-Weight Models (Concise Hybrid JSON + Checklist)",
    version: "2026.11.1",
    lastVerifiedAt: "2026-11-26T00:00:00.000Z",
    modelMatchers: ["ollama/*", "*"],
    structuralFormat: "hybrid_json_fence",
    reasoningStrategy: "compact_direct_execution",
    rules: {
      avoidPhrases: [],
      systemFramingTemplate:
        "Implement one vertical story at a time using the compact JSON contract and checklist below.",
      handoffSectionOrder: [
        "### Vision & Guardrails",
        "### Compact REQ -> TC Contract",
        "### Red-Green Execution Steps",
      ],
      toolUseGuidance: "Implement files incrementally and run unit tests after each file change.",
    },
    coachAnnotations: [
      {
        ruleKey: "compact_direct_execution",
        badgeLabel: "Compact Token Budget",
        explanation:
          "Compresses prose overhead into a dense JSON-fenced checklist so smaller local models keep attention on test IDs.",
      },
    ],
  },
];

function globMatches(pattern: string, target: string): boolean {
  if (pattern === "*") return true;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(target);
}

export function loadDialectProfiles(dialectsDir?: string): DialectProfile[] {
  if (!dialectsDir || !existsSync(dialectsDir)) {
    return BUILTIN_DIALECT_PROFILES;
  }

  const files = readdirSync(dialectsDir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
  if (files.length === 0) {
    return BUILTIN_DIALECT_PROFILES;
  }

  const byId = new Map<string, DialectProfile>(
    BUILTIN_DIALECT_PROFILES.map((d) => [d.id, d])
  );
  for (const file of files) {
    const raw = parse(readFileSync(join(dialectsDir, file), "utf8"));
    const parsed = DialectProfileSchema.parse(raw);
    byId.set(parsed.id, parsed);
  }
  return [...byId.values()];
}

export function selectDialectForModel(
  modelId: string,
  profiles: DialectProfile[] = BUILTIN_DIALECT_PROFILES
): DialectProfile {
  for (const profile of profiles) {
    for (const matcher of profile.modelMatchers) {
      if (matcher !== "*" && globMatches(matcher, modelId)) {
        return profile;
      }
    }
  }
  return (
    profiles.find((p) => p.id === "anthropic-claude") ??
    profiles[0] ??
    BUILTIN_DIALECT_PROFILES[0]!
  );
}
