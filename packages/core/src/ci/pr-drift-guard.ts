import {
  type RequirementDelta,
  type SpecDelta,
  SpecIterationDocumentSchema,
} from "../schemas/index.js";
import {
  computeDeterministicSpecDelta,
  verifySpecTraceability,
} from "../pipeline/stage5-iterative-delta.js";

export interface CiDeltaSummary {
  baseIterationNumber: number;
  targetIterationNumber: number;
  addedCount: number;
  modifiedCount: number;
  removedCount: number;
  regressionShieldCount: number;
  requiresUpdateCount: number;
  newTestCount: number;
  obsoleteCount: number;
  requirementDeltas: RequirementDelta[];
}

export interface CiSpecDriftReport {
  passed: boolean;
  specPath: string;
  projectTitle: string;
  iterationNumber: number;
  stage: string;
  storyCount: number;
  reqCount: number;
  testCount: number;
  orphanReqIds: string[];
  horizontalStoryIds: string[];
  issues: string[];
  deltaSummary?: CiDeltaSummary;
  markdownSummary: string;
}

export function buildGitHubActionWorkflowYaml(specPath = "specprism/spec.json"): string {
  return [
    "name: SpecPrism PR Spec-Drift Guard",
    "",
    "on:",
    "  pull_request:",
    "    branches: [main]",
    "  push:",
    "    branches: [main]",
    "",
    "permissions:",
    "  contents: read",
    "  pull-requests: write",
    "",
    "jobs:",
    "  spec-drift-guard:",
    "    name: Verify REQ-to-TC Traceability & Spec Deltas",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "        with:",
    "          fetch-depth: 0",
    "      - name: Run SpecPrism PR Spec-Drift Guard",
    "        uses: orphik/specprism/action@main",
    "        with:",
    `          spec-path: ${specPath}`,
    "          post-pr-comment: 'true'",
    "",
  ].join("\n");
}

function summarizeSpecDelta(delta: SpecDelta): CiDeltaSummary {
  return {
    baseIterationNumber: delta.baseIterationNumber,
    targetIterationNumber: delta.targetIterationNumber,
    addedCount: delta.requirementDeltas.filter((d) => d.operation === "ADDED").length,
    modifiedCount: delta.requirementDeltas.filter((d) => d.operation === "MODIFIED").length,
    removedCount: delta.requirementDeltas.filter((d) => d.operation === "REMOVED").length,
    regressionShieldCount: delta.testImpacts.filter((t) => t.status === "regression_shield").length,
    requiresUpdateCount: delta.testImpacts.filter((t) => t.status === "requires_update").length,
    newTestCount: delta.testImpacts.filter((t) => t.status === "new_test_required").length,
    obsoleteCount: delta.testImpacts.filter((t) => t.status === "obsolete").length,
    requirementDeltas: delta.requirementDeltas,
  };
}

export function generateCiSpecDriftReport(options: {
  currentDoc: unknown;
  baselineDoc?: unknown;
  specPath?: string;
  pullRequestTitle?: string;
}): CiSpecDriftReport {
  const specPath = options.specPath ?? "specprism/spec.json";
  const audit = verifySpecTraceability(options.currentDoc);

  // Extract raw metadata & orphan REQs even if Zod superRefine rejected the document
  const rawObj =
    options.currentDoc && typeof options.currentDoc === "object"
      ? (options.currentDoc as Record<string, unknown>)
      : {};
  const rawTriage =
    rawObj.triage && typeof rawObj.triage === "object"
      ? (rawObj.triage as Record<string, unknown>)
      : {};
  const rawFeatures = Array.isArray(rawObj.features)
    ? (rawObj.features as Array<Record<string, unknown>>)
    : [];
  const rawStories = rawFeatures.flatMap((f) =>
    Array.isArray(f.stories) ? (f.stories as Array<Record<string, unknown>>) : []
  );
  const rawCriteria = Array.isArray(rawObj.criteria)
    ? (rawObj.criteria as Array<Record<string, unknown>>)
    : [];
  const rawTests = Array.isArray(rawObj.testCases)
    ? (rawObj.testCases as Array<Record<string, unknown>>)
    : [];

  const coveredSet = new Set<string>();
  for (const tc of rawTests) {
    if (Array.isArray(tc.verifiesReqIds)) {
      for (const id of tc.verifiesReqIds) {
        if (typeof id === "string") coveredSet.add(id);
      }
    }
  }

  const detectedOrphans = new Set<string>(audit.orphanReqIds);
  const extraIssues = [...audit.issues];

  for (const req of rawCriteria) {
    const reqId = typeof req.id === "string" ? req.id : "";
    if (reqId && !coveredSet.has(reqId)) {
      detectedOrphans.add(reqId);
    }
    const earsObj =
      req.ears && typeof req.ears === "object" ? (req.ears as Record<string, unknown>) : {};
    const rendered = typeof earsObj.rendered === "string" ? earsObj.rendered : "";
    if (reqId && rendered && !/\bSHALL\b/.test(rendered)) {
      const msg = `Requirement ${reqId} EARS clause is missing uppercase SHALL.`;
      if (!extraIssues.some((i) => i.includes(reqId) && i.includes("SHALL"))) {
        extraIssues.push(msg);
      }
    }
  }

  const projectTitle =
    typeof rawTriage.projectTitle === "string" && rawTriage.projectTitle.trim()
      ? rawTriage.projectTitle.trim()
      : "SpecPrism Specification";
  const iterationNumber =
    typeof rawObj.iterationNumber === "number" ? rawObj.iterationNumber : 1;
  const stage = typeof rawObj.stage === "string" ? rawObj.stage : "unknown";
  const storyCount = audit.storyCount || rawStories.length;
  const reqCount = audit.reqCount || rawCriteria.length;
  const testCount = audit.testCount || rawTests.length;
  const orphanReqIds = [...detectedOrphans];
  const passed = audit.valid && orphanReqIds.length === 0 && extraIssues.length === 0;

  let deltaSummary: CiDeltaSummary | undefined;
  const parsedCurrent = SpecIterationDocumentSchema.safeParse(options.currentDoc);
  const parsedBaseline = options.baselineDoc
    ? SpecIterationDocumentSchema.safeParse(options.baselineDoc)
    : null;

  if (parsedCurrent.success && parsedBaseline?.success) {
    const computed = computeDeterministicSpecDelta(
      parsedBaseline.data,
      parsedCurrent.data,
      options.pullRequestTitle ?? "Pull Request Spec Delta"
    );
    deltaSummary = summarizeSpecDelta(computed);
  } else if (parsedCurrent.success && parsedCurrent.data.delta) {
    deltaSummary = summarizeSpecDelta(parsedCurrent.data.delta);
  }

  const statusLine = passed
    ? "## ✅ SpecPrism PR Drift Guard — PASSED"
    : "## ❌ SpecPrism PR Drift Guard — BLOCKED";

  const shieldCell = deltaSummary
    ? `${deltaSummary.regressionShieldCount} 🛡️`
    : `${testCount} baseline`;

  const lines: string[] = [
    "<!-- specprism-pr-guard -->",
    statusLine,
    "",
    `> **Project:** ${projectTitle} (\`v${iterationNumber}\` · \`${specPath}\`)`,
    "",
    "| Vertical Stories (`US-*`) | EARS Criteria (`REQ-*`) | Test Blueprint (`TC-*`) | Orphan REQs | Regression Shields |",
    "| :---: | :---: | :---: | :---: | :---: |",
    `| **${storyCount}** | **${reqCount}** | **${testCount}** | **${orphanReqIds.length}** | **${shieldCell}** |`,
    "",
  ];

  if (!passed) {
    lines.push("### 🚨 Blocking Spec-Drift Violations");
    for (const issue of extraIssues) {
      lines.push(`- ❌ ${issue}`);
    }
    lines.push("");
  }

  if (deltaSummary) {
    lines.push(
      `### 🔄 Iterative Delta Summary (\`v${deltaSummary.baseIterationNumber} -> v${deltaSummary.targetIterationNumber}\`)`,
      `- **Requirement Changes:** \`+${deltaSummary.addedCount} ADDED\` · \`~${deltaSummary.modifiedCount} MODIFIED\` · \`-${deltaSummary.removedCount} REMOVED\``,
      `- **Test Suite Impact:** \`🛡️ ${deltaSummary.regressionShieldCount} Regression Shields\` · \`🔧 ${deltaSummary.requiresUpdateCount} Requires Update\` · \`✨ ${deltaSummary.newTestCount} New Tests\``,
      ""
    );
    if (deltaSummary.requirementDeltas.length > 0) {
      lines.push("| Delta | Op | Req ID | Story | EARS Specification |");
      lines.push("| :--- | :--- | :--- | :--- | :--- |");
      for (const d of deltaSummary.requirementDeltas) {
        const clause = (d.nextEars ?? d.previousEars ?? "").replace(/\|/g, "\\|");
        lines.push(`| \`${d.id}\` | **${d.operation}** | \`${d.reqId}\` | \`${d.storyId}\` | ${clause} |`);
      }
      lines.push("");
    }
  }

  lines.push(
    "_Verified deterministically by [SpecPrism](https://spec-prism.app) (`orphik/specprism/action`)._"
  );

  return {
    passed,
    specPath,
    projectTitle,
    iterationNumber,
    stage,
    storyCount,
    reqCount,
    testCount,
    orphanReqIds,
    horizontalStoryIds: audit.horizontalStoryIds,
    issues: extraIssues,
    deltaSummary,
    markdownSummary: lines.join("\n") + "\n",
  };
}
