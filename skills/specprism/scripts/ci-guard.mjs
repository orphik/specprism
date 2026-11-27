#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { validateSpecObject } from "./validate-spec.mjs";

function parseArgs(argv) {
  const args = {
    spec: "specprism/spec.json",
    base: "",
    out: "",
  };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--spec" && argv[i + 1]) args.spec = argv[++i];
    else if (argv[i] === "--base" && argv[i + 1]) args.base = argv[++i];
    else if (argv[i] === "--out" && argv[i + 1]) args.out = argv[++i];
  }
  return args;
}

const args = parseArgs(process.argv);
const specPath = resolve(process.cwd(), args.spec);
if (!existsSync(specPath)) {
  console.error(`[specprism:ci-guard] Spec file not found: ${specPath}`);
  process.exit(1);
}

const doc = JSON.parse(readFileSync(specPath, "utf8").replace(/^\uFEFF/, ""));
const errs = validateSpecObject(doc);

const stories = (doc.features ?? []).flatMap((f) => f.stories ?? []);
const criteria = doc.criteria ?? [];
const testCases = doc.testCases ?? [];
const covered = new Set(testCases.flatMap((t) => t.verifiesReqIds ?? []));
const orphans = criteria.filter((c) => !covered.has(c.id)).map((c) => c.id);

let delta = doc.delta ?? null;
if (args.base && existsSync(resolve(process.cwd(), args.base))) {
  const baseDoc = JSON.parse(
    readFileSync(resolve(process.cwd(), args.base), "utf8").replace(/^\uFEFF/, "")
  );
  const baseMap = new Map((baseDoc.criteria ?? []).map((c) => [c.id, c]));
  const nextMap = new Map(criteria.map((c) => [c.id, c]));
  const reqDeltas = [];
  let seq = 1;
  for (const nr of criteria) {
    const pr = baseMap.get(nr.id);
    if (!pr) {
      reqDeltas.push({
        id: `DLT-${String(seq++).padStart(3, "0")}`,
        operation: "ADDED",
        reqId: nr.id,
        storyId: nr.storyId,
        nextEars: nr.ears?.rendered ?? "",
      });
    } else if ((pr.ears?.rendered ?? "").trim() !== (nr.ears?.rendered ?? "").trim()) {
      reqDeltas.push({
        id: `DLT-${String(seq++).padStart(3, "0")}`,
        operation: "MODIFIED",
        reqId: nr.id,
        storyId: nr.storyId,
        nextEars: nr.ears?.rendered ?? "",
      });
    }
  }
  for (const pr of baseDoc.criteria ?? []) {
    if (!nextMap.has(pr.id)) {
      reqDeltas.push({
        id: `DLT-${String(seq++).padStart(3, "0")}`,
        operation: "REMOVED",
        reqId: pr.id,
        storyId: pr.storyId,
        previousEars: pr.ears?.rendered ?? "",
      });
    }
  }
  const changedReqSet = new Set(reqDeltas.map((d) => d.reqId));
  const baseTcIds = new Set((baseDoc.testCases ?? []).map((t) => t.id));
  const testImpacts = testCases.map((tc) => {
    if (!baseTcIds.has(tc.id)) return { status: "new_test_required" };
    if ((tc.verifiesReqIds ?? []).some((r) => changedReqSet.has(r))) {
      return { status: "requires_update" };
    }
    return { status: "regression_shield" };
  });
  delta = {
    baseIterationNumber: baseDoc.iterationNumber ?? 1,
    targetIterationNumber: doc.iterationNumber ?? 2,
    requirementDeltas: reqDeltas,
    testImpacts,
  };
}

const passed = errs.length === 0 && orphans.length === 0;
const shields = delta
  ? (delta.testImpacts ?? []).filter((t) => t.status === "regression_shield").length
  : testCases.length;

const lines = [
  "<!-- specprism-pr-guard -->",
  passed
    ? "## ✅ SpecPrism PR Drift Guard — PASSED"
    : "## ❌ SpecPrism PR Drift Guard — BLOCKED",
  "",
  `> **Project:** ${doc.triage?.projectTitle ?? "SpecPrism Specification"} (\`v${doc.iterationNumber ?? 1}\` · \`${args.spec}\`)`,
  "",
  "| Vertical Stories (`US-*`) | EARS Criteria (`REQ-*`) | Test Blueprint (`TC-*`) | Orphan REQs | Regression Shields |",
  "| :---: | :---: | :---: | :---: | :---: |",
  `| **${stories.length}** | **${criteria.length}** | **${testCases.length}** | **${orphans.length}** | **${shields} 🛡️** |`,
  "",
];

if (!passed) {
  lines.push("### 🚨 Blocking Spec-Drift Violations");
  for (const e of errs) {
    lines.push(`- ❌ ${e}`);
  }
  lines.push("");
}

if (delta && Array.isArray(delta.requirementDeltas) && delta.requirementDeltas.length > 0) {
  lines.push(
    `### 🔄 Iterative Delta Summary (\`v${delta.baseIterationNumber} -> v${delta.targetIterationNumber}\`)`,
    "| Delta | Op | Req ID | Story | EARS Specification |",
    "| :--- | :--- | :--- | :--- | :--- |"
  );
  for (const d of delta.requirementDeltas) {
    const clause = String(d.nextEars ?? d.previousEars ?? "").replace(/\|/g, "\\|");
    lines.push(`| \`${d.id}\` | **${d.operation}** | \`${d.reqId}\` | \`${d.storyId}\` | ${clause} |`);
  }
  lines.push("");
}

lines.push(
  "_Verified deterministically by [SpecPrism](https://spec-prism.app) (`orphik/specprism/action`)._"
);

const markdown = lines.join("\n") + "\n";
if (args.out) {
  const outPath = resolve(process.cwd(), args.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, markdown, "utf8");
}
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown + "\n", "utf8");
}

if (!passed) {
  console.error("[specprism:ci-guard] BLOCKED:\n" + errs.map((e) => `  - ${e}`).join("\n"));
  process.exit(1);
}
console.log(
  `[specprism:ci-guard] PASSED: ${stories.length} US-* · ${criteria.length} REQ-* · ${testCases.length} TC-* · 0 orphans.`
);
