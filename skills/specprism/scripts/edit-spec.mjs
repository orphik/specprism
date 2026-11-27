#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateSpecObject } from "./validate-spec.mjs";

const HORIZONTAL_STUBS = /^(n\/?a|none|null|tbd|todo|db\s*only|ui\s*only|api\s*only|not\s+applicable)$/i;

function parseArgs(argv) {
  const args = {
    spec: ".specprism/spec.json",
    asm: "",
    statement: "",
    story: "",
    title: "",
    entry: "",
    domain: "",
    persistence: "",
    demo: "",
    req: "",
    ears: "",
    when: "",
  };
  for (let i = 2; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === "--spec" && next) args.spec = argv[++i];
    else if (flag === "--asm" && next) args.asm = argv[++i];
    else if (flag === "--statement" && next) args.statement = argv[++i];
    else if (flag === "--story" && next) args.story = argv[++i];
    else if (flag === "--title" && next) args.title = argv[++i];
    else if (flag === "--entry" && next) args.entry = argv[++i];
    else if (flag === "--domain" && next) args.domain = argv[++i];
    else if (flag === "--persistence" && next) args.persistence = argv[++i];
    else if (flag === "--demo" && next) args.demo = argv[++i];
    else if (flag === "--req" && next) args.req = argv[++i];
    else if (flag === "--ears" && next) args.ears = argv[++i];
    else if (flag === "--when" && next) args.when = argv[++i];
  }
  return args;
}

const args = parseArgs(process.argv);
if (!args.asm && !args.story && !args.req) {
  console.error(
    [
      "Usage:",
      '  node edit-spec.mjs --spec .specprism/spec.json --req REQ-001 --ears "WHEN ... THE SYSTEM SHALL ..."',
      '  node edit-spec.mjs --spec .specprism/spec.json --asm ASM-001 --statement "Updated boundary..."',
      '  node edit-spec.mjs --spec .specprism/spec.json --story US-001 [--title "..."] [--entry "..."] [--domain "..."] [--persistence "..."]',
    ].join("\n")
  );
  process.exit(1);
}

const specPath = resolve(process.cwd(), args.spec);
if (!existsSync(specPath)) {
  console.error(`[specprism:edit-spec] File not found: ${specPath}`);
  process.exit(1);
}

const doc = JSON.parse(readFileSync(specPath, "utf8").replace(/^\uFEFF/, ""));
const editedTargets = [];

if (args.asm) {
  if (!args.statement || args.statement.trim().length < 5) {
    console.error("[specprism:edit-spec] --statement must be at least 5 characters.");
    process.exit(1);
  }
  const targetAsm = (doc.triage?.lockedAssumptions ?? []).find((a) => a.id === args.asm);
  if (!targetAsm) {
    console.error(`[specprism:edit-spec] Locked assumption '${args.asm}' not found.`);
    process.exit(1);
  }
  targetAsm.statement = args.statement.trim();
  targetAsm.source = "user_edited";
  editedTargets.push(args.asm);
}

if (args.story) {
  let targetStory = null;
  for (const feat of doc.features ?? []) {
    for (const st of feat.stories ?? []) {
      if (st.id === args.story) targetStory = st;
    }
  }
  if (!targetStory) {
    console.error(`[specprism:edit-spec] Vertical story '${args.story}' not found.`);
    process.exit(1);
  }
  if (args.title) targetStory.title = args.title.trim();
  if (args.demo) targetStory.independentDemoProof = args.demo.trim();
  targetStory.touchpoints = targetStory.touchpoints ?? {};
  if (args.entry) targetStory.touchpoints.entrySurface = args.entry.trim();
  if (args.domain) targetStory.touchpoints.domainLogic = args.domain.trim();
  if (args.persistence) targetStory.touchpoints.persistenceOrExternal = args.persistence.trim();

  for (const key of ["entrySurface", "domainLogic", "persistenceOrExternal"]) {
    const val = String(targetStory.touchpoints[key] ?? "").trim();
    if (val.length < 3 || HORIZONTAL_STUBS.test(val)) {
      console.error(
        `[specprism:edit-spec] Horizontal slice rejected on ${args.story}: touchpoints.${key} ('${val}') must be concrete.`
      );
      process.exit(1);
    }
  }
  editedTargets.push(args.story);
}

if (args.req) {
  const targetReq = (doc.criteria ?? []).find((c) => c.id === args.req);
  if (!targetReq) {
    console.error(`[specprism:edit-spec] Criterion '${args.req}' not found.`);
    process.exit(1);
  }
  if (args.ears) {
    const trimmedEars = args.ears.trim();
    if (!/\bSHALL\b/.test(trimmedEars)) {
      console.error(
        `[specprism:edit-spec] Invalid EARS clause for ${args.req}: must include uppercase 'SHALL'.`
      );
      process.exit(1);
    }
    targetReq.ears = {
      ...(targetReq.ears ?? {}),
      shallResponse: trimmedEars,
      rendered: trimmedEars,
    };
  }
  if (args.title) targetReq.title = args.title.trim();
  if (args.when) {
    targetReq.gwt = { ...(targetReq.gwt ?? {}), when: args.when.trim() };
  }
  editedTargets.push(args.req);
}

if (Array.isArray(doc.testCases) && doc.testCases.length > 0) {
  const errs = validateSpecObject(doc);
  if (errs.length > 0) {
    console.error("[specprism:edit-spec] Traceability check failed:\n" + errs.map((e) => `  - ${e}`).join("\n"));
    process.exit(1);
  }
}

writeFileSync(specPath, JSON.stringify(doc, null, 2) + "\n", "utf8");
console.log(
  `[specprism:edit-spec] OK: Surgically updated ${editedTargets.join(", ")} in ${specPath}.`
);
