#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

function parseArgs(argv) {
  const args = {
    base: "",
    next: ".specprism/spec.json",
    prompt: "Iterative specification update",
    out: "DELTA.md",
  };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--base" && argv[i + 1]) args.base = argv[++i];
    else if (argv[i] === "--next" && argv[i + 1]) args.next = argv[++i];
    else if (argv[i] === "--prompt" && argv[i + 1]) args.prompt = argv[++i];
    else if (argv[i] === "--out" && argv[i + 1]) args.out = argv[++i];
  }
  return args;
}

const args = parseArgs(process.argv);
if (!args.base) {
  console.error("Usage: node delta-spec.mjs --base <v1-spec.json> --next <v2-spec.json> [--prompt \"...\"] [--out DELTA.md]");
  process.exit(1);
}

const basePath = resolve(process.cwd(), args.base);
const nextPath = resolve(process.cwd(), args.next);
if (!existsSync(basePath) || !existsSync(nextPath)) {
  console.error(`[specprism:delta-spec] Missing spec file(s): ${basePath} or ${nextPath}`);
  process.exit(1);
}

const baseDoc = JSON.parse(readFileSync(basePath, "utf8").replace(/^\uFEFF/, ""));
const nextDoc = JSON.parse(readFileSync(nextPath, "utf8").replace(/^\uFEFF/, ""));

const baseReqs = new Map((baseDoc.criteria ?? []).map((c) => [c.id, c]));
const nextReqs = new Map((nextDoc.criteria ?? []).map((c) => [c.id, c]));

const deltas = [];
const impactedStories = new Set();
let seq = 1;
const nextDeltaId = () => `DLT-${String(seq++).padStart(3, "0")}`;

for (const nr of nextDoc.criteria ?? []) {
  const pr = baseReqs.get(nr.id);
  if (!pr) {
    impactedStories.add(nr.storyId);
    deltas.push({
      id: nextDeltaId(),
      operation: "ADDED",
      reqId: nr.id,
      storyId: nr.storyId,
      nextEars: nr.ears?.rendered ?? "",
    });
  } else if ((pr.ears?.rendered ?? "").trim() !== (nr.ears?.rendered ?? "").trim()) {
    impactedStories.add(nr.storyId);
    deltas.push({
      id: nextDeltaId(),
      operation: "MODIFIED",
      reqId: nr.id,
      storyId: nr.storyId,
      previousEars: pr.ears?.rendered ?? "",
      nextEars: nr.ears?.rendered ?? "",
    });
  }
}

for (const pr of baseDoc.criteria ?? []) {
  if (!nextReqs.has(pr.id)) {
    impactedStories.add(pr.storyId);
    deltas.push({
      id: nextDeltaId(),
      operation: "REMOVED",
      reqId: pr.id,
      storyId: pr.storyId,
      previousEars: pr.ears?.rendered ?? "",
    });
  }
}

const addedSet = new Set(deltas.filter((d) => d.operation === "ADDED").map((d) => d.reqId));
const modSet = new Set(deltas.filter((d) => d.operation === "MODIFIED").map((d) => d.reqId));
const baseTcIds = new Set((baseDoc.testCases ?? []).map((t) => t.id));
const nextTcIds = new Set((nextDoc.testCases ?? []).map((t) => t.id));

const testImpacts = [];
for (const tc of nextDoc.testCases ?? []) {
  const reqs = tc.verifiesReqIds ?? [];
  if (!baseTcIds.has(tc.id) || reqs.every((r) => addedSet.has(r))) {
    testImpacts.push({ id: tc.id, status: "new_test_required", reqs, file: tc.targetFilePath });
  } else if (reqs.some((r) => modSet.has(r) || addedSet.has(r))) {
    testImpacts.push({ id: tc.id, status: "requires_update", reqs, file: tc.targetFilePath });
  } else {
    testImpacts.push({ id: tc.id, status: "regression_shield", reqs, file: tc.targetFilePath });
  }
}
for (const ptc of baseDoc.testCases ?? []) {
  if (!nextTcIds.has(ptc.id)) {
    testImpacts.push({ id: ptc.id, status: "obsolete", reqs: ptc.verifiesReqIds ?? [], file: ptc.targetFilePath });
  }
}

const md = [
  `# SpecPrism Iterative Spec Delta (v${baseDoc.iterationNumber ?? 1} -> v${nextDoc.iterationNumber ?? 2})`,
  "",
  `> **Change Request:** ${args.prompt}`,
  `> **Impacted Stories:** ${[...impactedStories].join(", ") || "None"}`,
  "",
  "## 1. Requirement Deltas (`DLT-*`)",
  ...(deltas.length === 0
    ? ["- No EARS requirement changes detected."]
    : deltas.map((d) =>
        d.operation === "MODIFIED"
          ? `- **\`${d.id}\` [${d.operation}] \`${d.reqId}\` (${d.storyId})**\n  - Before: \`${d.previousEars}\`\n  - After: \`${d.nextEars}\``
          : `- **\`${d.id}\` [${d.operation}] \`${d.reqId}\` (${d.storyId})**: \`${d.nextEars || d.previousEars}\``
      )),
  "",
  "## 2. Test Impact & Regression Shields (`TC-*`)",
  "| Test ID | Impact Classification | Verifies | Target File |",
  "| :--- | :--- | :--- | :--- |",
  ...testImpacts.map(
    (t) => `| \`${t.id}\` | **\`${t.status}\`** | ${t.reqs.join(", ")} | \`${t.file}\` |`
  ),
  "",
].join("\n");

const outPath = resolve(process.cwd(), args.out);
writeFileSync(outPath, md, "utf8");
const shields = testImpacts.filter((t) => t.status === "regression_shield").length;
console.log(
  `[specprism:delta-spec] Wrote ${outPath}: ${deltas.length} DLT-* change(s), ${shields} Regression Shield(s).`
);
