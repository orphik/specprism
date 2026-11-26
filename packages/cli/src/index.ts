#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertVerticalStorySlices,
  BUILTIN_DIALECT_PROFILES,
  computeDeterministicSpecDelta,
  exportSpecBundleFiles,
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
    "  specprism init                              Create .specprism/ workspace folder",
    "  specprism validate <path-to-spec.json>      Validate vertical slices & REQ-to-TC coverage",
    "  specprism export <path-to-spec.json> [dir]  Export TRACEABILITY.md, .feature & test files",
    "  specprism delta <v1.json> <v2.json>         Compute DLT-* diffs & Regression Shields",
    "  specprism mcp                               Start stateless MCP 2026-07-28 stdio server",
    "  specprism --version                         Print CLI & MCP protocol version",
    "",
    "Visual Web Workbench, How-To Guide & Cloud Sync: https://spec-prism.app/guide",
  ].join("\n");
}

export function runCli(argv: string[]): number {
  const [cmd, arg1, arg2] = argv;

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
