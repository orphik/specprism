#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { validateSpecObject } from "./validate-spec.mjs";

function parseArgs(argv) {
  const args = {
    spec: ".specprism/spec.json",
    report: "",
    out: "UAT_REPORT.md",
    repairOut: ".specprism/REPAIR_PROMPT.md",
    bugsOut: "",
    dialect: "claude",
    strict: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--spec" && argv[i + 1]) args.spec = argv[++i];
    else if (argv[i] === "--report" && argv[i + 1]) args.report = argv[++i];
    else if (argv[i] === "--out" && argv[i + 1]) args.out = argv[++i];
    else if (argv[i] === "--repair-out" && argv[i + 1]) args.repairOut = argv[++i];
    else if (argv[i] === "--bugs-out" && argv[i + 1]) args.bugsOut = argv[++i];
    else if (argv[i] === "--dialect" && argv[i + 1]) args.dialect = argv[++i];
    else if (argv[i] === "--strict") args.strict = true;
  }
  return args;
}

function normalizeStatus(raw) {
  const s = String(raw ?? "").toLowerCase().trim();
  if (s === "passed" || s === "expected" || s === "ok" || s === "pass") return "passed";
  if (["failed", "unexpected", "error", "timedout", "fail", "flaky"].includes(s)) return "failed";
  if (["skipped", "pending", "todo", "disabled"].includes(s)) return "skipped";
  return "not_run";
}

function parseJunit(xml) {
  const out = [];
  const rx = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/gi;
  let m;
  while ((m = rx.exec(xml)) !== null) {
    const attrs = m[1] || "";
    const inner = m[2] || "";
    const getAttr = (n) => {
      const hit = new RegExp(`\\b${n}\\s*=\\s*["']([^"']*)["']`, "i").exec(attrs);
      return hit ? hit[1] : "";
    };
    const name = getAttr("name");
    const cls = getAttr("classname") || getAttr("file");
    const fail = /<(?:failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:failure|error)>)/i.exec(inner);
    if (fail) {
      const msgHit = /\bmessage\s*=\s*["']([^"']*)["']/i.exec(fail[1] || "");
      out.push({
        title: `${cls} ${name}`.trim(),
        filePath: cls,
        status: "failed",
        failureMessage: [msgHit ? msgHit[1] : "", (fail[2] || "").trim()].filter(Boolean).join(" — "),
      });
    } else if (/<skipped\b/i.test(inner)) {
      out.push({ title: `${cls} ${name}`.trim(), filePath: cls, status: "skipped" });
    } else {
      out.push({ title: `${cls} ${name}`.trim(), filePath: cls, status: "passed" });
    }
  }
  return out;
}

function walkPlaywright(suites, out, parentTitle = "", parentFile = "") {
  for (const s of suites || []) {
    const title = [parentTitle, s.title || ""].filter(Boolean).join(" > ");
    const file = s.file || parentFile || "";
    for (const sp of s.specs || []) {
      const spTitle = [title, sp.title || ""].filter(Boolean).join(" > ");
      const spFile = sp.file || file;
      const tests = sp.tests || [];
      if (tests.length === 0) {
        out.push({ title: spTitle, filePath: spFile, status: sp.ok === false ? "failed" : "passed" });
      }
      for (const t of tests) {
        const results = t.results || [];
        const last = results[results.length - 1] || t;
        const st = normalizeStatus(last.status ?? t.status ?? (sp.ok === false ? "failed" : "passed"));
        const err = last.error || (last.errors && last.errors[0]);
        out.push({
          title: spTitle,
          filePath: spFile,
          status: st,
          failureMessage: st === "failed" ? (err?.message || "Playwright test failed") : undefined,
        });
      }
    }
    if (s.suites) walkPlaywright(s.suites, out, title, file);
  }
}

const args = parseArgs(process.argv);
const specPath = resolve(process.cwd(), args.spec);
if (!existsSync(specPath) || !args.report) {
  console.error("Usage: node verify-uat.mjs --spec <spec.json> --report <vitest-playwright-or-junit-file>");
  process.exit(1);
}
const reportPath = resolve(process.cwd(), args.report);
if (!existsSync(reportPath)) {
  console.error(`[specprism:verify-uat] Report file not found: ${reportPath}`);
  process.exit(1);
}

const doc = JSON.parse(readFileSync(specPath, "utf8").replace(/^\uFEFF/, ""));
const errs = validateSpecObject(doc);
if (errs.length > 0) {
  console.error("[specprism:verify-uat] Invalid spec.json:\n" + errs.map((e) => `  - ${e}`).join("\n"));
  process.exit(1);
}

const rawText = readFileSync(reportPath, "utf8").trim();
let format = "vitest_json";
let executions = [];
let explicitMap = new Map();

if (rawText.startsWith("<")) {
  format = "junit_xml";
  executions = parseJunit(rawText);
} else {
  const json = JSON.parse(rawText.replace(/^\uFEFF/, ""));
  if (Array.isArray(json.results) && json.results.some((r) => r && r.testCaseId)) {
    format = "specprism_native";
    for (const r of json.results) {
      explicitMap.set(String(r.testCaseId).toUpperCase(), {
        status: normalizeStatus(r.status),
        failureMessage: r.failureMessage,
      });
    }
  } else if (Array.isArray(json.testResults)) {
    format = "vitest_json";
    for (const suite of json.testResults) {
      const fp = suite.name || suite.testFilePath || "";
      for (const a of suite.assertionResults || []) {
        const st = normalizeStatus(a.status);
        executions.push({
          title: a.fullName || a.title || "",
          filePath: fp,
          status: st,
          failureMessage: st === "failed" ? (a.failureMessages || []).join("\n").slice(0, 500) : undefined,
        });
      }
    }
  } else if (Array.isArray(json.suites)) {
    format = "playwright_json";
    walkPlaywright(json.suites, executions);
  } else {
    console.error("[specprism:verify-uat] Unsupported report format.");
    process.exit(1);
  }
}

const normTail = (p) => String(p || "").replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase().trim();
const tcStatusMap = new Map();

for (const tc of doc.testCases || []) {
  if (explicitMap.has(tc.id.toUpperCase())) {
    tcStatusMap.set(tc.id, explicitMap.get(tc.id.toUpperCase()));
    continue;
  }
  const byId = executions.filter((ex) => new RegExp(`\\b${tc.id}\\b`, "i").test(ex.title));
  const tail = normTail(tc.targetFilePath);
  const hits =
    byId.length > 0
      ? byId
      : tail
      ? executions.filter((ex) => {
          const et = normTail(ex.filePath);
          return et && (et.endsWith(tail) || tail.endsWith(et));
        })
      : [];
  if (hits.length === 0) tcStatusMap.set(tc.id, { status: "not_run" });
  else if (hits.some((h) => h.status === "failed")) {
    const f = hits.find((h) => h.status === "failed");
    tcStatusMap.set(tc.id, { status: "failed", failureMessage: f.failureMessage || "Test failed" });
  } else if (hits.some((h) => h.status === "passed")) {
    tcStatusMap.set(tc.id, { status: "passed" });
  } else {
    tcStatusMap.set(tc.id, { status: "skipped" });
  }
}

const verifiedReqs = [];
const failingReqs = [];
const unrunReqs = [];
const reqState = new Map();

for (const req of doc.criteria || []) {
  const tcs = (doc.testCases || []).filter((tc) => (tc.verifiesReqIds || []).includes(req.id));
  const sts = tcs.map((t) => tcStatusMap.get(t.id)?.status || "not_run");
  if (sts.some((s) => s === "failed")) {
    failingReqs.push(req.id);
    reqState.set(req.id, "failed");
  } else if (sts.length > 0 && sts.every((s) => s === "passed")) {
    verifiedReqs.push(req.id);
    reqState.set(req.id, "verified");
  } else {
    unrunReqs.push(req.id);
    reqState.set(req.id, "unrun");
  }
}

const cats = [
  ["happy_path", "Happy Path"],
  ["negative_edge_case", "Negative / Edge Cases"],
  ["non_functional_guardrail", "Security & Perf Guardrails"],
];
const totalReqs = (doc.criteria || []).length;
const pct = totalReqs === 0 ? 0 : Math.round((verifiedReqs.length / totalReqs) * 100);
const ready = totalReqs > 0 && failingReqs.length === 0 && unrunReqs.length === 0;

const summaryMd = [
  "<!-- specprism-uat-report -->",
  `### SpecPrism Post-Code UAT Scorecard — ${ready ? "✅ 100% Release Ready" : `⚠️ ${pct}% Verified`}`,
  "",
  "| Category | Verified | Failing | Unexecuted | Readiness |",
  "| :--- | :---: | :---: | :---: | :---: |",
  ...cats.map(([key, label]) => {
    const sub = (doc.criteria || []).filter((c) => c.category === key);
    const v = sub.filter((c) => reqState.get(c.id) === "verified").length;
    const f = sub.filter((c) => reqState.get(c.id) === "failed").length;
    const u = sub.filter((c) => reqState.get(c.id) === "unrun").length;
    const cp = sub.length === 0 ? 100 : Math.round((v / sub.length) * 100);
    return `| **${label}** | ${v}/${sub.length} | ${f} | ${u} | **${cp}%** |`;
  }),
  "",
].join("\n");

const outFile = resolve(process.cwd(), args.out);
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, summaryMd, "utf8");
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryMd + "\n", "utf8");
}

const useXml = args.dialect.toLowerCase().startsWith("claude") || args.dialect.toLowerCase().startsWith("gemini");
const targetReqs = (doc.criteria || []).filter((c) => failingReqs.includes(c.id) || unrunReqs.includes(c.id));
const shieldTcs = (doc.testCases || []).filter((t) => tcStatusMap.get(t.id)?.status === "passed");
const repairMd = useXml
  ? `<uat_repair_objective>\nReadiness: ${pct}%. Fix ${targetReqs.length} failing/unrun REQ-* items while keeping ${shieldTcs.length} Regression Shields green.\n</uat_repair_objective>\n<failing_acceptance_criteria>\n${targetReqs.map((c) => `[${c.id}] ${c.ears.rendered}`).join("\n")}\n</failing_acceptance_criteria>\n<locked_regression_shields>\n${shieldTcs.map((t) => `[${t.id}] ${t.targetFilePath}`).join("\n")}\n</locked_regression_shields>\n`
  : `# Post-Code UAT Repair Contract\nReadiness: **${pct}%**.\n\n## Failing Criteria\n${targetReqs.map((c) => `- **${c.id}**: ${c.ears.rendered}`).join("\n")}\n\n## Locked Regression Shields\n${shieldTcs.map((t) => `- **${t.id}** (${t.targetFilePath})`).join("\n")}\n`;

if (args.repairOut) {
  const rp = resolve(process.cwd(), args.repairOut);
  mkdirSync(dirname(rp), { recursive: true });
  writeFileSync(rp, repairMd, "utf8");
}
if (args.bugsOut) {
  const bp = resolve(process.cwd(), args.bugsOut);
  mkdirSync(dirname(bp), { recursive: true });
  const bugs = targetReqs.map((r) => `## [UAT Bug] ${r.id} — ${r.title}\n- EARS: \`${r.ears.rendered}\``).join("\n\n---\n\n");
  writeFileSync(bp, `# Post-Code UAT Bugs\n\n${bugs}\n`, "utf8");
}

console.log(`[specprism:verify-uat] format=${format} readiness=${pct}% (${verifiedReqs.length}/${totalReqs} REQ-*) -> ${outFile}`);
if (args.strict && !ready) process.exit(1);
