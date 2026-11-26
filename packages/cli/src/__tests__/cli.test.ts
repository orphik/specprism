import { describe, expect, it } from "vitest";
import { formatCliBanner, formatCliHelp, runCli } from "../index.js";

describe("specprism CLI", () => {
  it("prints version and MCP 2026-07-28 readiness banner", () => {
    expect(formatCliBanner()).toContain("2026-07-28");
    expect(formatCliHelp()).toContain("specprism validate");
    expect(runCli(["--version"])).toBe(0);
    expect(runCli(["--help"])).toBe(0);
  });
});
