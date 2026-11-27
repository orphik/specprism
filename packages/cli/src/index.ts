#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  applyInlineSpecEdit,
  assertVerticalStorySlices,
  BUILTIN_DIALECT_PROFILES,
  compileFailingBugTickets,
  compileIssueTrackerBacklog,
  compileUatRepairPrompt,
  computeDeterministicSpecDelta,
  exportSpecBundleFiles,
  generateCiSpecDriftReport,
  ingestUatReport,
  MCP_PROTOCOL_VERSION,
  SPECPRISM_CORE_VERSION,
  SpecIterationDocumentSchema,
} from "@specprism/core";
import { runStdioMcpServer } from "@specprism/mcp-server";

export function formatCliBanner(): string {
  return `SpecPrism CLI v${SPECPRISM_CORE_VERSION} (MCP ${MCP_PROTOCOL_VERSION} Stateless Ready)`;
}

export function formatCliHelp(): string {
  return [
    formatCliBanner(),
    "",
    "Usage:",
    "  specprism init                                    Create .specprism/ workspace folder",
    "  specprism validate <path-to-spec.json>            Validate vertical slices & REQ-to-TC coverage",
    "  specprism ci-guard [spec.json] [--base v1.json]   Generate PR Spec-Drift Markdown & gate CI",
    "  specprism verify-run <spec.json> <report.json>    Ingest Vitest/Playwright/JUnit UAT & compile repair prompt",
    "  specprism issues [spec.json] [--out BACKLOG.md]   Export US-* stories to Linear/GitHub Issues & gh CLI",
    "  specprism edit-req <spec.json> <REQ-ID> \"<EARS>\"  Surgically edit an EARS clause & re-verify",
    "  specprism edit-asm <spec.json> <ASM-ID> \"<text>\"  Surgically edit a locked ASM-* assumption",
    "  specprism export <path-to-spec.json> [dir]        Export TRACEABILITY.md, .feature & test files",
    "  specprism delta <v1.json> <v2.json>               Compute DLT-* diffs & Regression Shields",
    "  specprism mcp                                     Start stateless MCP 2026-07-28 stdio server",
    "  specprism --version                               Print CLI & MCP protocol version",
    "",
    "Visual Web Workbench, How-To Guide & Cloud Sync: https://spec-prism.app/guide",
  ].join("\n");
}

export function runCli(argv: string[]): number {
  const [cmd, arg1, arg2, arg3] = argv;

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(formatCliHelp());
    return 0;
  }

  if (cmd === "--version" || cmd === "-v" || cmd === "version") {
    console.log(formatCliBanner());
    return 0;
  }

  if (cmd === "init") {
    const dir = resolve(process.cwd(), ".specprism");
    mkdirSync(dir, { recursive: true });
    console.log(`[specprism] Initialized ${dir}`);
    return 0;
  }

  if (cmd === "mcp") {
    const localSpecPath = resolve(process.cwd(), ".specprism/spec.json");
    runStdioMcpServer({
      async listUserSpecs() {
        if (!existsSync(localSpecPath)) return [];
        const parsed = SpecIterationDocumentSchema.safeParse(
          JSON.parse(readFileSync(localSpecPath, "utf8").replace(/^\uFEFF/, ""))
        );
        return parsed.success
          ? [
              {
                id: parsed.data.projectId,
                title: parsed.data.triage.projectTitle || "Local Workspace Spec",
                stage: parsed.data.stage,
              },
            ]
          : [];
      },
      async loadSpecById(id) {
        if (!existsSync(localSpecPath)) return null;
        const parsed = SpecIterationDocumentSchema.safeParse(
          JSON.parse(readFileSync(localSpecPath, "utf8").replace(/^\uFEFF/, ""))
        );
        return parsed.success && parsed.data.projectId === id ? parsed.data : null;
      },
    });
    return 0;
  }

  if (cmd === "validate") {
    const target = resolve(process.cwd(), arg1 ?? ".specprism/spec.json");
    if (!existsSync(target)) {
      console.error(`[specprism] File not found: ${target}`);
      return 1;
    }
    const raw = JSON.parse(readFileSync(target, "utf8").replace(/^\uFEFF/, "")) as unknown;
    const parsed = SpecIterationDocumentSchema.safeParse(raw);
    if (!parsed.success) {
      console.error(
        "[specprism] Validation failed:\n" +
          parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n")
      );
      return 1;
    }
    try {
      assertVerticalStorySlices(parsed.data.features);
    } catch (err) {
      console.error(`[specprism] ${err instanceof Error ? err.message : "Verticality check failed"}`);
      return 1;
    }
    console.log(
      `[specprism] OK: Verified ${parsed.data.criteria.length} REQ-* -> ${parsed.data.testCases.length} TC-* with 0 orphans.`
    );
    return 0;
  }

  if (cmd === "issues") {
    let specRel = ".specprism/spec.json";
    let outRel = "ISSUES_BACKLOG.md";
    let ghRel = "";
    for (let i = 1; i < argv.length; i += 1) {
      const tok = argv[i]!;
      if (tok === "--out" && argv[i + 1]) outRel = argv[++i]!;
      else if (tok === "--gh-script" && argv[i + 1]) ghRel = argv[++i]!;
      else if (!tok.startsWith("--")) specRel = tok;
    }
    const target = resolve(process.cwd(), specRel);
    if (!existsSync(target)) {
      console.error(`[specprism:issues] File not found: ${target}`);
      return 1;
    }
    const doc = SpecIterationDocumentSchema.parse(
      JSON.parse(readFileSync(target, "utf8").replace(/^\uFEFF/, ""))
    );
    const exported = compileIssueTrackerBacklog(doc);
    const outPath = resolve(process.cwd(), outRel);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, exported.backlogMarkdown, "utf8");
    if (ghRel) {
      const ghPath = resolve(process.cwd(), ghRel);
      mkdirSync(dirname(ghPath), { recursive: true });
      writeFileSync(ghPath, exported.ghCliScript, "utf8");
    }
    console.log(
      `[specprism:issues] Exported ${exported.tickets.length} vertical story ticket(s) to ${outPath}`
    );
    return 0;
  }

  if (cmd === "verify-run") {
    let specRel = "";
    let reportRel = "";
    let outRel = "";
    let repairRel = "";
    let bugsRel = "";
    let dialectReq = "";
    let strict = false;

    for (let i = 1; i < argv.length; i += 1) {
      const tok = argv[i]!;
      if (tok === "--out" && argv[i + 1]) outRel = argv[++i]!;
      else if (tok === "--repair-out" && argv[i + 1]) repairRel = argv[++i]!;
      else if (tok === "--bugs-out" && argv[i + 1]) bugsRel = argv[++i]!;
      else if (tok === "--dialect" && argv[i + 1]) dialectReq = argv[++i]!;
      else if (tok === "--strict") strict = true;
      else if (!tok.startsWith("--")) {
        if (!specRel) specRel = tok;
        else if (!reportRel) reportRel = tok;
      }
    }

    if (!specRel || !reportRel) {
      console.error(
        "Usage: specprism verify-run <spec.json> <vitest-playwright-or-junit-report> [--out UAT_REPORT.md] [--repair-out REPAIR_PROMPT.md] [--bugs-out UAT_BUGS.md] [--strict]"
      );
      return 1;
    }

    const specPath = resolve(process.cwd(), specRel);
    const reportPath = resolve(process.cwd(), reportRel);
    if (!existsSync(specPath) || !existsSync(reportPath)) {
      console.error("[specprism:verify-run] Spec or test report file not found.");
      return 1;
    }

    try {
      const doc = SpecIterationDocumentSchema.parse(
        JSON.parse(readFileSync(specPath, "utf8").replace(/^\uFEFF/, ""))
      );
      const rawReport = readFileSync(reportPath, "utf8");
      const uatRun = ingestUatReport(doc, rawReport);
      const chosenDialectId = dialectReq || doc.targetDialectId || "anthropic-claude";
      const dialect =
        BUILTIN_DIALECT_PROFILES.find((d) => d.id === chosenDialectId) ??
        BUILTIN_DIALECT_PROFILES[0]!;
      const repair = compileUatRepairPrompt(doc, uatRun, dialect);
      const bugs = compileFailingBugTickets(doc, uatRun);

      if (outRel) {
        const p = resolve(process.cwd(), outRel);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, uatRun.summaryMarkdown, "utf8");
      }
      if (repairRel) {
        const p = resolve(process.cwd(), repairRel);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, repair.prompt, "utf8");
      }
      if (bugsRel) {
        const p = resolve(process.cwd(), bugsRel);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, bugs.bugsMarkdown, "utf8");
      }
      if (process.env.GITHUB_STEP_SUMMARY) {
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, uatRun.summaryMarkdown + "\n", "utf8");
      }

      console.log(
        `[specprism:verify-run] ${uatRun.releaseReady ? "READY" : "ITERATION_REQUIRED"}: ${
          uatRun.overallPassRatePct
        }% verified (${uatRun.verifiedReqIds.length}/${doc.criteria.length} REQ-*, ${
          uatRun.failingReqIds.length
        } failing).`
      );
      if (strict && !uatRun.releaseReady) {
        return 1;
      }
      return 0;
    } catch (err) {
      console.error(
        `[specprism:verify-run] ${err instanceof Error ? err.message : "UAT verification failed."}`
      );
      return 1;
    }
  }

  if (cmd === "ci-guard") {
    let specRel = ".specprism/spec.json";
    let baseRel = "";
    let outRel = "";
    for (let i = 1; i < argv.length; i += 1) {
      const tok = argv[i]!;
      if (tok === "--base" && argv[i + 1]) baseRel = argv[++i]!;
      else if (tok === "--out" && argv[i + 1]) outRel = argv[++i]!;
      else if (!tok.startsWith("--")) specRel = tok;
    }
    const target = resolve(process.cwd(), specRel);
    if (!existsSync(target)) {
      console.error(`[specprism:ci-guard] File not found: ${target}`);
      return 1;
    }
    const currentRaw = JSON.parse(readFileSync(target, "utf8").replace(/^\uFEFF/, "")) as unknown;
    const basePath = baseRel ? resolve(process.cwd(), baseRel) : "";
    const baselineRaw =
      basePath && existsSync(basePath)
        ? (JSON.parse(readFileSync(basePath, "utf8").replace(/^\uFEFF/, "")) as unknown)
        : undefined;

    const report = generateCiSpecDriftReport({
      currentDoc: currentRaw,
      baselineDoc: baselineRaw,
      specPath: specRel,
    });

    if (outRel) {
      const outPath = resolve(process.cwd(), outRel);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, report.markdownSummary, "utf8");
    }
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, report.markdownSummary + "\n", "utf8");
    }

    if (!report.passed) {
      console.error(
        `[specprism:ci-guard] BLOCKED (${report.orphanReqIds.length} orphan REQs):\n` +
          report.issues.map((i) => `  - ${i}`).join("\n")
      );
      return 1;
    }
    console.log(
      `[specprism:ci-guard] PASSED: ${report.storyCount} US-* · ${report.reqCount} REQ-* · ${report.testCount} TC-* · 0 orphans.`
    );
    return 0;
  }

  if (cmd === "edit-req") {
    if (!arg1 || !arg2 || !arg3) {
      console.error('Usage: specprism edit-req <spec.json> <REQ-ID> "<new EARS clause>"');
      return 1;
    }
    const target = resolve(process.cwd(), arg1);
    if (!existsSync(target)) {
      console.error(`[specprism] File not found: ${target}`);
      return 1;
    }
    try {
      const doc = SpecIterationDocumentSchema.parse(
        JSON.parse(readFileSync(target, "utf8").replace(/^\uFEFF/, ""))
      );
      const existing = doc.criteria.find((c) => c.id === arg2);
      if (!existing) {
        console.error(`[specprism] Acceptance criterion ${arg2} not found.`);
        return 1;
      }
      const { document: nextDoc, audit } = applyInlineSpecEdit(doc, {
        kind: "criterion",
        reqId: arg2,
        title: existing.title,
        category: existing.category,
        earsRendered: arg3,
        gwtGiven: existing.gwt.given,
        gwtWhen: existing.gwt.when,
        gwtThen: existing.gwt.then,
      });
      writeFileSync(target, JSON.stringify(nextDoc, null, 2) + "\n", "utf8");
      console.log(
        `[specprism] Updated ${arg2} EARS clause (${audit.orphanReqIds.length} orphan REQs).`
      );
      return 0;
    } catch (err) {
      console.error(`[specprism] ${err instanceof Error ? err.message : "Inline edit failed"}`);
      return 1;
    }
  }

  if (cmd === "edit-asm") {
    if (!arg1 || !arg2 || !arg3) {
      console.error('Usage: specprism edit-asm <spec.json> <ASM-ID> "<new statement>"');
      return 1;
    }
    const target = resolve(process.cwd(), arg1);
    if (!existsSync(target)) {
      console.error(`[specprism] File not found: ${target}`);
      return 1;
    }
    try {
      const doc = SpecIterationDocumentSchema.parse(
        JSON.parse(readFileSync(target, "utf8").replace(/^\uFEFF/, ""))
      );
      const { document: nextDoc } = applyInlineSpecEdit(doc, {
        kind: "assumption",
        assumptionId: arg2,
        statement: arg3,
      });
      writeFileSync(target, JSON.stringify(nextDoc, null, 2) + "\n", "utf8");
      console.log(`[specprism] Updated locked assumption ${arg2}.`);
      return 0;
    } catch (err) {
      console.error(`[specprism] ${err instanceof Error ? err.message : "Inline edit failed"}`);
      return 1;
    }
  }

  if (cmd === "delta") {
    if (!arg1 || !arg2) {
      console.error("Usage: specprism delta <v1-spec.json> <v2-spec.json>");
      return 1;
    }
    const basePath = resolve(process.cwd(), arg1);
    const nextPath = resolve(process.cwd(), arg2);
    if (!existsSync(basePath) || !existsSync(nextPath)) {
      console.error("[specprism] Base or target spec.json not found.");
      return 1;
    }
    const baseDoc = SpecIterationDocumentSchema.parse(
      JSON.parse(readFileSync(basePath, "utf8").replace(/^\uFEFF/, ""))
    );
    const nextDoc = SpecIterationDocumentSchema.parse(
      JSON.parse(readFileSync(nextPath, "utf8").replace(/^\uFEFF/, ""))
    );
    const delta = computeDeterministicSpecDelta(baseDoc, nextDoc, "CLI Iterative Delta");
    const shields = delta.testImpacts.filter((t) => t.status === "regression_shield").length;
    console.log(
      `[specprism] Delta v${baseDoc.iterationNumber} -> v${nextDoc.iterationNumber}: ${delta.requirementDeltas.length} DLT-* change(s), ${shields} Regression Shield(s).`
    );
    return 0;
  }

  if (cmd === "export") {
    const target = resolve(process.cwd(), arg1 ?? ".specprism/spec.json");
    const outRoot = resolve(process.cwd(), arg2 ?? "./specprism-out");
    if (!existsSync(target)) {
      console.error(`[specprism] File not found: ${target}`);
      return 1;
    }
    const doc = SpecIterationDocumentSchema.parse(
      JSON.parse(readFileSync(target, "utf8").replace(/^\uFEFF/, ""))
    );
    const dialect =
      BUILTIN_DIALECT_PROFILES.find((d) => d.id === doc.targetDialectId) ??
      BUILTIN_DIALECT_PROFILES[0]!;
    const files = exportSpecBundleFiles(doc, dialect);
    for (const file of files) {
      const dest = join(outRoot, file.path);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, file.content, "utf8");
    }
    console.log(`[specprism] Exported ${files.length} verified bundle files to ${outRoot}`);
    return 0;
  }

  console.error(`Unknown command '${cmd}'. Run 'specprism --help' for usage.`);
  return 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  process.exitCode = runCli(process.argv.slice(2));
}
