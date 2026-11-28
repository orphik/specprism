#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

function parseArgs(argv) {
  const args = {
    item: "",
    category: "phase-2",
    reason: "Deferred out of v1 scope",
    out: "PARKING-LOT.md",
  };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--item" && argv[i + 1]) args.item = argv[++i];
    else if (argv[i] === "--category" && argv[i + 1]) args.category = argv[++i];
    else if (argv[i] === "--reason" && argv[i + 1]) args.reason = argv[++i];
    else if (argv[i] === "--out" && argv[i + 1]) args.out = argv[++i];
  }
  return args;
}

const args = parseArgs(process.argv);
if (!args.item.trim()) {
  console.error("[specprism:park-tangent] Missing required --item argument.");
  process.exit(1);
}

const outPath = resolve(process.cwd(), args.out);
let existing = existsSync(outPath)
  ? readFileSync(outPath, "utf8")
  : "# SpecPrism Scope Parking Lot (`PARKING-LOT.md`)\n\n| ID | Category | Deferred Item | Rationale / Revisit Trigger |\n| :--- | :--- | :--- | :--- |\n";

const matches = [...existing.matchAll(/\|\s*`?PL-(\d{3,})`?\s*\|/g)];
const nextNum =
  matches.reduce((max, m) => Math.max(max, Number(m[1] || 0)), 0) + 1;
const id = `PL-${String(nextNum).padStart(3, "0")}`;

const esc = (s) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
const row = `| \`${id}\` | \`${esc(args.category)}\` | ${esc(args.item)} | ${esc(args.reason)} |\n`;

if (!existing.endsWith("\n")) existing += "\n";
writeFileSync(outPath, existing + row, "utf8");
console.log(`[specprism:park-tangent] Parked ${id} in ${args.out}`);
