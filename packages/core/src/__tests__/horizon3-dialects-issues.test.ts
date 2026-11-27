import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUILTIN_DIALECT_PROFILES,
  compileIssueTrackerBacklog,
  exportSpecBundleFiles,
  loadDialectProfiles,
  selectDialectForModel,
  SpecIterationDocumentSchema,
} from "../index.js";

describe("Horizon 3 — 9-Family Dialect Coverage & Issue Tracker Exporter", () => {
  const dialectsDir = resolve(import.meta.dirname, "../../../../dialects");
  const dogfoodSpec = SpecIterationDocumentSchema.parse(
    JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../../specprism/spec.json"), "utf8"))
  );

  it("loads all 9 vendor dialect profiles and maps Grok, Codestral, Llama, and Gemini without fallback", () => {
    const loaded = loadDialectProfiles(dialectsDir);
    expect(loaded.length).toBeGreaterThanOrEqual(9);
    expect(BUILTIN_DIALECT_PROFILES.length).toBeGreaterThanOrEqual(9);

    expect(selectDialectForModel("x-ai/grok-4", loaded).id).toBe("xai-grok");
    expect(selectDialectForModel("mistralai/codestral-2508", loaded).id).toBe("mistral-codestral");
    expect(selectDialectForModel("meta-llama/llama-4-maverick", loaded).id).toBe("meta-llama");
    expect(selectDialectForModel("google/gemini-2.5-pro", loaded).id).toBe("google-gemini");
    expect(selectDialectForModel("google/gemma-3-27b-it", loaded).id).toBe("google-gemini");
  });

  it("compiles vertical stories into GitHub Issues / Linear backlog Markdown and safe gh CLI script", () => {
    const issues = compileIssueTrackerBacklog(dogfoodSpec);
    expect(issues.tickets.length).toBeGreaterThanOrEqual(4);
    expect(issues.tickets[0]?.storyId).toBe("US-001");
    expect(issues.tickets[0]?.markdownBody).toContain("REQ-001");
    expect(issues.tickets[0]?.markdownBody).toContain("TC-001");
    expect(issues.backlogMarkdown).toContain("# SpecPrism Vertical Story Backlog");
    expect(issues.ghCliScript).toContain("gh issue create");
    expect(issues.ghCliScript).toContain("SPECPRISM_EOF");

    const bundle = exportSpecBundleFiles(dogfoodSpec, BUILTIN_DIALECT_PROFILES[0]!);
    const paths = bundle.map((f) => f.path);
    expect(paths).toContain("specprism/ISSUES_BACKLOG.md");
    expect(paths).toContain("specprism/create-github-issues.sh");
  });
});
