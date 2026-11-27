#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { validateSpecObject } from "./validate-spec.mjs";

function parseArgs(argv) {
  const args = {
    spec: ".specprism/spec.json",
    out: "ISSUES_BACKLOG.md",
    ghScript: "",
  };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--spec" && argv[i + 1]) args.spec = argv[++i];
    else if (argv[i] === "--out" && argv[i + 1]) args.out = argv[++i];
    else if (argv[i] === "--gh-script" && argv[i + 1]) args.ghScript = argv[++i];
  }
  return args;
}

const args = parseArgs(process.argv);
const specPath = resolve(process.cwd(), args.spec);
if (!existsSync(specPath)) {
  console.error(`[specprism:export-issues] Spec file not found: ${specPath}`);
  process.exit(1);
}

const doc = JSON.parse(readFileSync(specPath, "utf8").replace(/^\uFEFF/, ""));
const errs = validateSpecObject(doc);
if (errs.length > 0) {
  console.error("[specprism:export-issues] Fix spec validation errors first:\n" + errs.map((e) => `  - ${e}`).join("\n"));
  process.exit(1);
}

const stories = (doc.features ?? [])
  .flatMap((f) => (f.stories ?? []).map((s) => ({ story: s, featureTitle: f.title ?? f.id })))
  .sort((a, b) => (a.story.sliceOrder ?? 1) - (b.story.sliceOrder ?? 1));

const tickets = stories.map(({ story, featureTitle }) => {
  const reqs = (doc.criteria ?? []).filter((c) => c.storyId === story.id);
  const reqSet = new Set(reqs.map((r) => r.id));
  const tests = (doc.testCases ?? []).filter((tc) =>
    (tc.verifiesReqIds ?? []).some((id) => reqSet.has(id))
  );

  const body = [
    `## ${story.id} — ${story.title}`,
    "",
    `> **Feature:** \`${story.featureId}\` (${featureTitle}) · **Vertical Slice Order:** #${story.sliceOrder}`,
    "",
    `As a **${story.asA}**, I want ${story.iWant} so that ${story.soThat}.`,
    "",
    "### Touchpoints",
    `- **Entry Surface:** ${story.touchpoints?.entrySurface}`,
    `- **Domain Logic:** ${story.touchpoints?.domainLogic}`,
    `- **Persistence / External:** ${story.touchpoints?.persistenceOrExternal}`,
    "",
    "### Acceptance Criteria (`REQ-*` EARS)",
    ...reqs.map((r) => `- [ ] **\`${r.id}\`** — ${r.title}: \`${r.ears?.rendered}\``),
    "",
    "### Verification Tests (`TC-*`)",
    ...tests.map(
      (t) => `- [ ] **\`${t.id}\`** (\`${t.tier}\` -> \`${t.targetFilePath}\`) — ${t.title}`
    ),
    "",
    `**Demo Proof:** ${story.independentDemoProof}`,
  ].join("\n");

  return { id: story.id, title: `[${story.id}] ${story.title}`, body };
});

const backlogMd = [
  `# SpecPrism Vertical Story Backlog — ${doc.triage?.projectTitle ?? "Project"} (v${doc.iterationNumber ?? 1})`,
  "",
  ...tickets.flatMap((t) => [t.body, "", "---", ""]),
].join("\n");

const outPath = resolve(process.cwd(), args.out);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, backlogMd, "utf8");

if (args.ghScript) {
  const posixSingleQuote = (val) => "'" + String(val).replace(/'/g, "'\\''") + "'";
  const pickMarker = (body) => {
    let m = "SPECPRISM_EOF";
    let n = 1;
    while (String(body).includes(m)) m = `SPECPRISM_EOF_${n++}`;
    return m;
  };
  const ghLines = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    ...tickets.flatMap((t) => {
      const marker = pickMarker(t.body);
      return [
        `gh issue create --title ${posixSingleQuote(t.title)} --body-file - <<'${marker}'`,
        t.body,
        marker,
        "",
      ];
    }),
  ];
  const ghPath = resolve(process.cwd(), args.ghScript);
  mkdirSync(dirname(ghPath), { recursive: true });
  writeFileSync(ghPath, ghLines.join("\n"), "utf8");
}

console.log(`[specprism:export-issues] Wrote ${tickets.length} vertical story ticket(s) to ${outPath}.`);
