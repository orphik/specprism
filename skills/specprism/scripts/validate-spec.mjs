#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const HORIZONTAL_STUBS = /^(n\/?a|none|null|tbd|todo|db\s*only|ui\s*only|api\s*only|not\s+applicable)$/i;

export function validateSpecObject(doc) {
  const errors = [];
  if (!doc || typeof doc !== "object") {
    return ["Root document must be a JSON object."];
  }

  if (!doc.triage?.scopedVisionSummary?.trim()) {
    errors.push("Missing triage.scopedVisionSummary.");
  }
  if (!Array.isArray(doc.triage?.lockedAssumptions) || doc.triage.lockedAssumptions.length === 0) {
    errors.push("triage.lockedAssumptions must contain at least one locked ASM-* assumption.");
  }

  const storyIds = new Set();
  for (const feat of doc.features ?? []) {
    if (!/^FEAT-\d{2,}$/.test(feat.id ?? "")) {
      errors.push(`Invalid feature ID '${feat.id}' (expected FEAT-01+).`);
    }
    for (const story of feat.stories ?? []) {
      if (!/^US-\d{3,}$/.test(story.id ?? "")) {
        errors.push(`Invalid story ID '${story.id}' (expected US-001+).`);
      }
      storyIds.add(story.id);
      const tp = story.touchpoints ?? {};
      for (const key of ["entrySurface", "domainLogic", "persistenceOrExternal"]) {
        const val = String(tp[key] ?? "").trim();
        if (val.length < 3 || HORIZONTAL_STUBS.test(val)) {
          errors.push(
            `Horizontal slice rejected on ${story.id}: touchpoints.${key} ('${val}') must be a concrete architectural touchpoint.`
          );
        }
      }
    }
  }

  if (storyIds.size === 0) {
    errors.push("At least one vertical story (US-001+) is required.");
  }

  const reqIds = new Set();
  for (const req of doc.criteria ?? []) {
    if (!/^REQ-\d{3,}$/.test(req.id ?? "")) {
      errors.push(`Invalid criterion ID '${req.id}' (expected REQ-001+).`);
    }
    reqIds.add(req.id);
    if (!storyIds.has(req.storyId)) {
      errors.push(`Criterion ${req.id} references unknown storyId '${req.storyId}'.`);
    }
    const earsRendered = String(req.ears?.rendered ?? "");
    if (!/\bSHALL\b/.test(earsRendered)) {
      errors.push(`Criterion ${req.id} ears.rendered must contain an uppercase 'SHALL' clause.`);
    }
    if (!req.coaching?.whyItMatters?.trim()) {
      errors.push(`Criterion ${req.id} is missing coaching.whyItMatters.`);
    }
  }

  if (reqIds.size === 0) {
    errors.push("At least one acceptance criterion (REQ-001+) is required.");
  }

  const coveredReqs = new Set();
  for (const tc of doc.testCases ?? []) {
    if (!/^TC-\d{3,}$/.test(tc.id ?? "")) {
      errors.push(`Invalid testCase ID '${tc.id}' (expected TC-001+).`);
    }
    if (!Array.isArray(tc.verifiesReqIds) || tc.verifiesReqIds.length === 0) {
      errors.push(`TestCase ${tc.id} must verify at least one REQ-* ID.`);
    }
    for (const rid of tc.verifiesReqIds ?? []) {
      if (!reqIds.has(rid)) {
        errors.push(`TestCase ${tc.id} references unknown requirement '${rid}'.`);
      } else {
        coveredReqs.add(rid);
      }
    }
    if (!String(tc.targetFilePath ?? "").trim()) {
      errors.push(`TestCase ${tc.id} is missing targetFilePath.`);
    }
  }

  for (const rid of reqIds) {
    if (!coveredReqs.has(rid)) {
      errors.push(`Orphan requirement ${rid} has zero verifying TC-* test cases.`);
    }
  }

  return errors;
}

const isDirectRun =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectRun) {
  let specArg = ".specprism/spec.json";
  for (let i = 2; i < process.argv.length; i += 1) {
    if (process.argv[i] === "--spec" && process.argv[i + 1]) specArg = process.argv[++i];
  }
  const specPath = resolve(process.cwd(), specArg);
  if (!existsSync(specPath)) {
    console.error(`[specprism:validate-spec] File not found: ${specPath}`);
    process.exit(1);
  }
  const doc = JSON.parse(readFileSync(specPath, "utf8").replace(/^\uFEFF/, ""));
  const errs = validateSpecObject(doc);
  if (errs.length > 0) {
    console.error("[specprism:validate-spec] FAILED:\n" + errs.map((e) => `  - ${e}`).join("\n"));
    process.exit(1);
  }
  console.log(
    `[specprism:validate-spec] OK: Verified ${doc.criteria.length} REQ-* -> ${doc.testCases.length} TC-* with 0 orphans.`
  );
}
