import type { DialectProfile, SpecIterationDocument, TestCase } from "../schemas/index.js";
import { compileAgentHandoffPrompt } from "../dialects/compiler.js";

export interface ExportedSpecFile {
  path: string;
  content: string;
  kind: "spec_json" | "traceability_md" | "handoff_prompt" | "gherkin_feature" | "test_skeleton";
  testCaseIds?: string[];
}

function mergeTestCasesForSingleFile(
  filePath: string,
  cases: TestCase[],
  reqTitleMap: Map<string, string>
): string {
  const allTestIds = cases.map((c) => c.id).join(", ");
  const tiers = [...new Set(cases.map((c) => c.tier))].join(", ");
  const allVerified = [...new Set(cases.flatMap((c) => c.verifiesReqIds))]
    .map((id) => `${id}: ${reqTitleMap.get(id) ?? ""}`.trim())
    .join(" | ");

  const header = [
    `/**`,
    ` * @file ${filePath}`,
    ` * @specprismTestIds ${allTestIds}`,
    ` * @tier ${tiers}`,
    ` * @verifies ${allVerified}`,
    ` */`,
    "",
  ].join("\n");

  if (cases.length === 1) {
    return header + cases[0]!.skeletonCode.trim() + "\n";
  }

  // Deduplicate top-level ES import lines when merging multiple TC-* skeletons into one file
  const seenImports = new Set<string>();
  const bodySections: string[] = [];

  for (const tc of cases) {
    const lines = tc.skeletonCode.trim().split(/\r?\n/);
    const nonImportLines: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (/^import\s+.+from\s+['"][^'"]+['"];?$/.test(trimmed)) {
        seenImports.add(trimmed);
      } else {
        nonImportLines.push(line);
      }
    }
    bodySections.push(
      [
        `// ---------------------------------------------------------------------------`,
        `// [${tc.id}] ${tc.title} (Verifies: ${tc.verifiesReqIds.join(", ")})`,
        `// ---------------------------------------------------------------------------`,
        nonImportLines.join("\n").trim(),
      ].join("\n")
    );
  }

  const importBlock = seenImports.size > 0 ? [...seenImports].join("\n") + "\n\n" : "";
  return header + importBlock + bodySections.join("\n\n") + "\n";
}

export function exportSpecBundleFiles(
  doc: SpecIterationDocument,
  dialect: DialectProfile
): ExportedSpecFile[] {
  const files: ExportedSpecFile[] = [];

  // 1. Canonical spec.json
  files.push({
    path: "specprism/spec.json",
    content: JSON.stringify(doc, null, 2) + "\n",
    kind: "spec_json",
  });

  // 2. Human & PR-reviewable TRACEABILITY.md
  const reqById = new Map(doc.criteria.map((c) => [c.id, c.title]));
  const rows: string[] = [
    "# SpecPrism Traceability Matrix (`REQ-*` <-> `TC-*`)",
    "",
    `> **Scoped Vision:** ${doc.triage.scopedVisionSummary}`,
    "",
    "| Story | Requirement | Category | EARS Specification | Verifying Tests (`TC-*`) | Tier |",
    "| :--- | :--- | :--- | :--- | :--- | :--- |",
  ];

  for (const req of doc.criteria) {
    const matchingTests = doc.testCases.filter((tc) => tc.verifiesReqIds.includes(req.id));
    const tcIds = matchingTests.map((t) => `\`${t.id}\``).join(", ") || "UNCOVERED";
    const tiers = [...new Set(matchingTests.map((t) => t.tier))].join(", ");
    rows.push(
      `| \`${req.storyId}\` | \`${req.id}\` | ${req.category} | ${req.ears.rendered.replace(
        /\|/g,
        "\\|"
      )} | ${tcIds} | ${tiers} |`
    );
  }

  files.push({
    path: "specprism/TRACEABILITY.md",
    content: rows.join("\n") + "\n",
    kind: "traceability_md",
  });

  // 3. Dialect-compiled coding-agent handoff prompt
  const { prompt } = compileAgentHandoffPrompt(doc, dialect);
  files.push({
    path: "specprism/AGENT_HANDOFF.md",
    content: prompt + "\n",
    kind: "handoff_prompt",
  });

  // 4. Runnable Gherkin .feature files per Vertical Story
  const allStories = doc.features.flatMap((f) => f.stories);
  for (const story of allStories) {
    const storyCriteria = doc.criteria.filter((c) => c.storyId === story.id);
    if (storyCriteria.length === 0) continue;

    const featureLines: string[] = [
      `@${story.featureId} @${story.id}`,
      `Feature: ${story.id} — ${story.title}`,
      `  As a ${story.asA}`,
      `  I want ${story.iWant}`,
      `  So that ${story.soThat}`,
      "",
    ];

    for (const crit of storyCriteria) {
      const linkedTestTags = doc.testCases
        .filter((tc) => tc.verifiesReqIds.includes(crit.id))
        .map((tc) => `@${tc.id}`)
        .join(" ");

      featureLines.push(
        `  @${crit.id} @${crit.category}${linkedTestTags ? ` ${linkedTestTags}` : ""}`
      );
      featureLines.push(`  Scenario: ${crit.id} — ${crit.title}`);
      crit.gwt.given.forEach((g, idx) => {
        featureLines.push(`    ${idx === 0 ? "Given" : "And"} ${g}`);
      });
      featureLines.push(`    When ${crit.gwt.when}`);
      crit.gwt.then.forEach((t, idx) => {
        featureLines.push(`    ${idx === 0 ? "Then" : "And"} ${t}`);
      });
      featureLines.push("");
    }

    files.push({
      path: `features/${story.id}.feature`,
      content: featureLines.join("\n"),
      kind: "gherkin_feature",
    });
  }

  // 5. Consolidated Test Skeleton files (merging multiple TC-* targeting the same file path!)
  const groupedTests = new Map<string, TestCase[]>();
  for (const tc of doc.testCases) {
    const cleanPath = tc.targetFilePath.replace(/^\/+/, "").trim();
    const existing = groupedTests.get(cleanPath) ?? [];
    existing.push(tc);
    groupedTests.set(cleanPath, existing);
  }

  for (const [cleanPath, cases] of groupedTests.entries()) {
    files.push({
      path: cleanPath,
      content: mergeTestCasesForSingleFile(cleanPath, cases, reqById),
      kind: "test_skeleton",
      testCaseIds: cases.map((c) => c.id),
    });
  }

  return files;
}
