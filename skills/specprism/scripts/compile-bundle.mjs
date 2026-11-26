#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { validateSpecObject } from "./validate-spec.mjs";

function parseArgs(argv) {
  const args = {
    spec: ".specprism/spec.json",
    out: ".",
    dialect: "claude",
    withSkeletons: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--spec" && argv[i + 1]) args.spec = argv[++i];
    else if (argv[i] === "--out" && argv[i + 1]) args.out = argv[++i];
    else if (argv[i] === "--dialect" && argv[i + 1]) args.dialect = argv[++i];
    else if (argv[i] === "--with-skeletons") args.withSkeletons = true;
  }
  return args;
}

const args = parseArgs(process.argv);
const specPath = resolve(process.cwd(), args.spec);
if (!existsSync(specPath)) {
  console.error(`[specprism:compile-bundle] Missing spec file: ${specPath}`);
  process.exit(1);
}

const doc = JSON.parse(readFileSync(specPath, "utf8").replace(/^\uFEFF/, ""));
const errs = validateSpecObject(doc);
if (errs.length > 0) {
  console.error(
    "[specprism:compile-bundle] Refusing to compile invalid spec:\n" +
      errs.map((e) => `  - ${e}`).join("\n")
  );
  process.exit(1);
}

const outDir = resolve(process.cwd(), args.out);
mkdirSync(outDir, { recursive: true });

const allStories = (doc.features ?? []).flatMap((f) => f.stories ?? []);

// 1. SPEC.md
const specMd = [
  `# ${doc.triage.projectTitle || "Verified Software Specification"}`,
  "",
  `> **Scoped Vision:** ${doc.triage.scopedVisionSummary}`,
  `> **Actors:** ${(doc.triage.primaryActors ?? []).join(", ")}`,
  `> **Explicit v1 Out-of-Scope:** ${(doc.triage.explicitOutOfScopeV1 ?? []).join(" · ")}`,
  "",
  "## 1. Locked Scope Assumptions (`ASM-*`)",
  ...(doc.triage.lockedAssumptions ?? []).map(
    (a) => `- **\`${a.id}\`** *(${a.dimension})*: ${a.statement}`
  ),
  "",
  "## 2. Vertical User Stories (`US-*`)",
  ...allStories.map(
    (s) =>
      `### \`${s.id}\` — ${s.title}\n- **Story:** As a ${s.asA}, I want ${s.iWant} so that ${s.soThat}.\n- **Entry Surface:** ${s.touchpoints.entrySurface}\n- **Domain Logic:** ${s.touchpoints.domainLogic}\n- **Persistence / External:** ${s.touchpoints.persistenceOrExternal}\n- **Independent Demo Proof:** ${s.independentDemoProof}`
  ),
  "",
  "## 3. Acceptance Criteria (`REQ-*` — EARS & Given/When/Then)",
  ...(doc.criteria ?? []).map(
    (c) =>
      `### \`${c.id}\` (${c.storyId} · \`${c.category}\`) — ${c.title}\n- **EARS:** \`${c.ears.rendered}\`\n- **Given:** ${(c.gwt.given ?? []).join(" AND ")}\n- **When:** ${c.gwt.when}\n- **Then:** ${(c.gwt.then ?? []).join(" AND ")}\n- **QA Guardrail Rationale:** ${c.coaching.whyItMatters} *(Prevents: ${c.coaching.failureModePrevented})*`
  ),
  "",
].join("\n");

writeFileSync(join(outDir, "SPEC.md"), specMd, "utf8");

// 2. TRACEABILITY.md
const traceLines = [
  "# SpecPrism Bi-Directional Traceability Matrix (`REQ-*` <-> `TC-*`)",
  "",
  "| Story | Requirement | Category | EARS Clause | Verifying Tests (`TC-*`) | Tiers |",
  "| :--- | :--- | :--- | :--- | :--- | :--- |",
];
for (const req of doc.criteria ?? []) {
  const tests = (doc.testCases ?? []).filter((t) => (t.verifiesReqIds ?? []).includes(req.id));
  traceLines.push(
    `| \`${req.storyId}\` | \`${req.id}\` | ${req.category} | ${req.ears.rendered.replace(
      /\|/g,
      "\\|"
    )} | ${tests.map((t) => `\`${t.id}\``).join(", ")} | ${[
      ...new Set(tests.map((t) => t.tier)),
    ].join(", ")} |`
  );
}
writeFileSync(join(outDir, "TRACEABILITY.md"), traceLines.join("\n") + "\n", "utf8");

// 3. Dialect-tuned AGENT_HANDOFF.md
const dialectKey = String(args.dialect || "claude").toLowerCase();
const useXml = dialectKey.startsWith("claude") || dialectKey.startsWith("gemini");
const useCompactJson = dialectKey === "compact" || dialectKey.startsWith("ollama");

const handoff = useCompactJson
  ? [
      "Implement each SpecPrism slice in order. Run tests after each file edit.",
      "",
      "```json",
      JSON.stringify(
        {
          vision: doc.triage.scopedVisionSummary,
          nonGoals: doc.triage.explicitOutOfScopeV1 ?? [],
          stories: allStories.map((s) => ({
            id: s.id,
            title: s.title,
            touchpoints: s.touchpoints,
          })),
          requirements: (doc.criteria ?? []).map((c) => ({
            id: c.id,
            storyId: c.storyId,
            ears: c.ears.rendered,
          })),
          tests: (doc.testCases ?? []).map((t) => ({
            id: t.id,
            verifies: t.verifiesReqIds,
            file: t.targetFilePath,
          })),
        },
        null,
        2
      ),
      "```",
      "",
    ].join("\n")
  : useXml
  ? [
      "Implement each SpecPrism vertical slice using strict Red -> Green -> Refactor TDD.",
      "",
      `<scoped_vision>\n${doc.triage.scopedVisionSummary}\nOut-of-Scope v1: ${(doc.triage.explicitOutOfScopeV1 ?? []).join("; ")}\n</scoped_vision>`,
      "",
      `<vertical_stories>\n${allStories.map((s) => `[${s.id}] ${s.title} (${s.touchpoints.entrySurface} -> ${s.touchpoints.domainLogic} -> ${s.touchpoints.persistenceOrExternal})`).join("\n")}\n</vertical_stories>`,
      "",
      `<acceptance_criteria_ears>\n${(doc.criteria ?? []).map((c) => `[${c.id}] ${c.ears.rendered}`).join("\n")}\n</acceptance_criteria_ears>`,
      "",
      `<traceable_tests>\n${(doc.testCases ?? []).map((t) => `[${t.id}] (${t.tier}) -> Verifies ${t.verifiesReqIds.join(", ")} in ${t.targetFilePath}`).join("\n")}\n</traceable_tests>`,
      "",
    ].join("\n")
  : [
      `# Developer Implementation Contract (${dialectKey.toUpperCase()} · Red -> Green -> Refactor)`,
      "",
      `## Scoped Vision\n${doc.triage.scopedVisionSummary}`,
      "",
      `## Vertical Stories\n${allStories.map((s) => `- **${s.id}** (${s.title}): ${s.touchpoints.entrySurface} -> ${s.touchpoints.domainLogic} -> ${s.touchpoints.persistenceOrExternal}`).join("\n")}`,
      "",
      `## Acceptance Criteria (EARS)\n${(doc.criteria ?? []).map((c) => `- **${c.id}**: ${c.ears.rendered}`).join("\n")}`,
      "",
      `## Verification Suite\n${(doc.testCases ?? []).map((t) => `- **${t.id}** (${t.tier} · \`${t.targetFilePath}\`) -> ${t.verifiesReqIds.join(", ")}`).join("\n")}`,
      "",
    ].join("\n");

writeFileSync(join(outDir, ".specprism", "AGENT_HANDOFF.md"), handoff, "utf8");

let writtenSkeletonCount = 0;
if (args.withSkeletons) {
  const byPath = new Map();
  for (const tc of doc.testCases ?? []) {
    const rel = String(tc.targetFilePath).replace(/^\/+/, "").trim();
    const list = byPath.get(rel) ?? [];
    list.push(tc);
    byPath.set(rel, list);
  }
  for (const [relPath, cases] of byPath.entries()) {
    const dest = join(outDir, relPath);
    mkdirSync(dirname(dest), { recursive: true });
    const merged = cases
      .map(
        (c) =>
          `// [${c.id}] ${c.title} (Verifies: ${c.verifiesReqIds.join(", ")})\n${String(
            c.skeletonCode ?? ""
          ).trim()}`
      )
      .join("\n\n");
    writeFileSync(dest, merged + "\n", "utf8");
    writtenSkeletonCount += 1;
  }
}

console.log(
  `[specprism:compile-bundle] Compiled SPEC.md, TRACEABILITY.md, and .specprism/AGENT_HANDOFF.md (${writtenSkeletonCount} test files written).`
);
