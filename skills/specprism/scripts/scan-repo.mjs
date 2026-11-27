#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

function parseArgs(argv) {
  const args = { repo: ".", out: ".specprism/surface.json" };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--repo" && argv[i + 1]) args.repo = argv[++i];
    else if (argv[i] === "--out" && argv[i + 1]) args.out = argv[++i];
  }
  return args;
}

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  ".turbo",
  ".venv",
  "venv",
  "__pycache__",
  "target",
  ".specprism",
]);

const SECRET_FILE_RX = /^\.env(\..+)?$|\.(pem|key|p12|pfx)$/i;

function scanTopFiles(rootDir, maxDepth = 3, depth = 0, acc = []) {
  if (depth > maxDepth || !existsSync(rootDir)) return acc;
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    if (IGNORED_DIRS.has(entry.name) || SECRET_FILE_RX.test(entry.name)) continue;
    const rel = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      scanTopFiles(rel, maxDepth, depth + 1, acc);
    } else {
      acc.push(rel);
    }
    if (acc.length >= 400) break;
  }
  return acc;
}

const { repo, out } = parseArgs(process.argv);
const repoRoot = resolve(process.cwd(), repo);
const files = scanTopFiles(repoRoot);

const frameworks = new Set();
const orms = new Set();
const testRunners = new Set();
let packageManager = "unknown";

if (existsSync(join(repoRoot, "pnpm-lock.yaml"))) packageManager = "pnpm";
else if (existsSync(join(repoRoot, "yarn.lock"))) packageManager = "yarn";
else if (existsSync(join(repoRoot, "bun.lockb")) || existsSync(join(repoRoot, "bun.lock"))) packageManager = "bun";
else if (existsSync(join(repoRoot, "package-lock.json"))) packageManager = "npm";
else if (existsSync(join(repoRoot, "pyproject.toml"))) packageManager = "python/uv/pip";
else if (existsSync(join(repoRoot, "Cargo.toml"))) packageManager = "cargo";

const pkgPaths = files.filter((f) => f.endsWith("package.json")).slice(0, 15);
for (const pkgFile of pkgPaths) {
  try {
    const pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps.next) frameworks.add("nextjs");
    if (deps.react) frameworks.add("react");
    if (deps.express) frameworks.add("express");
    if (deps.fastify) frameworks.add("fastify");
    if (deps.hono) frameworks.add("hono");
    if (deps["drizzle-orm"]) orms.add("drizzle");
    if (deps.prisma || deps["@prisma/client"]) orms.add("prisma");
    if (deps.vitest) testRunners.add("vitest");
    if (deps["@playwright/test"] || deps.playwright) testRunners.add("playwright");
    if (deps.jest) testRunners.add("jest");
  } catch {
    // Ignore malformed JSON
  }
}

if (existsSync(join(repoRoot, "pyproject.toml"))) {
  const py = readFileSync(join(repoRoot, "pyproject.toml"), "utf8");
  if (/fastapi/i.test(py)) frameworks.add("fastapi");
  if (/django/i.test(py)) frameworks.add("django");
  if (/sqlalchemy/i.test(py)) orms.add("sqlalchemy");
  if (/pytest/i.test(py)) testRunners.add("pytest");
}

const codeFileCount = files.filter((f) => /\.(ts|tsx|js|jsx|py|rs|go|java|rb)$/i.test(f)).length;
const surface = {
  scannedAt: new Date().toISOString(),
  mode: codeFileCount > 0 ? "brownfield" : "greenfield",
  codeFileCount,
  packageManager,
  frameworks: [...frameworks],
  orms: [...orms],
  testRunners: [...testRunners],
  samplePaths: files
    .map((f) => f.slice(repoRoot.length + 1).replace(/\\/g, "/"))
    .slice(0, 40),
};

const outPath = resolve(process.cwd(), out);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(surface, null, 2) + "\n", "utf8");
console.log(
  `[specprism:scan-repo] mode=${surface.mode} files=${codeFileCount} runners=[${surface.testRunners.join(", ") || "none"}] -> ${out}`
);
