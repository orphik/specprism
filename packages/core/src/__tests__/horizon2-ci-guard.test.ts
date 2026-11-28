import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildGitHubActionWorkflowYaml,
  BUILTIN_DIALECT_PROFILES,
  exportSpecBundleFiles,
  generateCiSpecDriftReport,
  SpecIterationDocumentSchema,
} from "../index.js";

describe("Horizon 2 (v1.2.0) — PR Spec-Drift Guard & GitHub Action Exporter", () => {
  const dogfoodSpec = SpecIterationDocumentSchema.parse(
    JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../../specprism/spec.json"), "utf8"))
  );

  it("generates a passing PR Drift Guard Markdown report with Regression Shields & idempotent comment marker", () => {
    const report = generateCiSpecDriftReport({
      currentDoc: dogfoodSpec,
      specPath: "specprism/spec.json",
    });

    expect(report.passed).toBe(true);
    expect(report.orphanReqIds).toHaveLength(0);
    expect(report.issues).toHaveLength(0);
    expect(report.deltaSummary?.regressionShieldCount).toBeGreaterThanOrEqual(3);
    expect(report.markdownSummary).toContain("<!-- specprism-pr-guard -->");
    expect(report.markdownSummary).toContain("PASSED");
    expect(report.markdownSummary).toContain("Regression Shields");
    expect(report.markdownSummary).toContain("DLT-001");
  });

  it("blocks PRs when an orphan REQ-* or missing uppercase SHALL clause is introduced", () => {
    const drifted = structuredClone(dogfoodSpec) as Record<string, unknown>;
    const criteria = [
      ...dogfoodSpec.criteria,
      {
        ...dogfoodSpec.criteria[0]!,
        id: "REQ-099",
        title: "Untested silent requirement",
        ears: {
          ...dogfoodSpec.criteria[0]!.ears,
          rendered: "When a request arrives, the system should log it.",
        },
      },
    ];
    drifted.criteria = criteria;

    const report = generateCiSpecDriftReport({
      currentDoc: drifted,
      specPath: "specprism/spec.json",
    });

    expect(report.passed).toBe(false);
    expect(report.orphanReqIds).toContain("REQ-099");
    expect(report.markdownSummary).toContain("BLOCKED");
    expect(report.markdownSummary).toContain("REQ-099");
  });

  it("exports .github/workflows/specprism-guard.yml inside every exported spec bundle", () => {
    const wf = buildGitHubActionWorkflowYaml("specprism/spec.json");
    expect(wf).toContain("orphik/specprism/action@main");
    expect(wf).toContain("specprism/spec.json");

    const bundle = exportSpecBundleFiles(dogfoodSpec, BUILTIN_DIALECT_PROFILES[0]!);
    const ciFile = bundle.find((f) => f.path === ".github/workflows/specprism-guard.yml");
    expect(ciFile).toBeDefined();
    expect(ciFile?.kind).toBe("ci_workflow");
    expect(ciFile?.content).toContain("pull_request");
  });
});
