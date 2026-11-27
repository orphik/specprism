import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatCliBanner, formatCliHelp, runCli } from "../index.js";

function buildSampleSpecJson() {
  return {
    projectId: "11111111-1111-4111-8111-111111111111",
    iterationNumber: 1,
    stage: "stage_4_tests",
    targetDialectId: "anthropic-claude",
    createdAt: "2026-11-26T19:00:00.000Z",
    triage: {
      rawPrompt: "Build webhook dispatcher",
      projectTitle: "Webhook Dispatcher",
      scopedVisionSummary: "Reliable signed webhook delivery with retries.",
      primaryActors: ["Merchant Developer"],
      explicitOutOfScopeV1: ["Custom scripting"],
      questions: [],
      lockedAssumptions: [
        {
          id: "ASM-001",
          dimension: "failure_and_recovery_states",
          statement: "Retry failed webhook deliveries 3 times with exponential backoff.",
          source: "user_confirmed",
        },
      ],
    },
    features: [
      {
        id: "FEAT-01",
        title: "Signed Delivery",
        outcomeSummary: "Delivers HMAC-signed webhooks end-to-end.",
        stories: [
          {
            id: "US-001",
            featureId: "FEAT-01",
            sliceOrder: 1,
            title: "Dispatch signed webhook",
            asA: "Merchant Developer",
            iWant: "events signed with HMAC-SHA256",
            soThat: "receivers verify authenticity",
            touchpoints: {
              entrySurface: "POST /api/webhooks/dispatch",
              domainLogic: "signPayloadHmacSha256",
              persistenceOrExternal: "PostgreSQL webhook_deliveries table",
            },
            independentDemoProof: "POST /api/webhooks/dispatch stores delivery row and header.",
            linkedAssumptionIds: ["ASM-001"],
          },
        ],
      },
    ],
    recommendedMcps: [],
    criteria: [
      {
        id: "REQ-001",
        storyId: "US-001",
        category: "happy_path",
        title: "Attach HMAC signature header",
        gwt: {
          given: ["an active webhook endpoint"],
          when: "an event is dispatched",
          then: ["X-Webhook-Signature header is attached"],
        },
        ears: {
          pattern: "event_driven",
          triggerOrCondition: "an event is dispatched",
          systemName: "Webhook Dispatcher",
          shallResponse: "attach an HMAC-SHA256 X-Webhook-Signature header",
          rendered:
            "WHEN an event is dispatched, THE Webhook Dispatcher SHALL attach an HMAC-SHA256 X-Webhook-Signature header.",
        },
        coaching: {
          whyItMatters: "Prevents forged webhook payloads.",
          failureModePrevented: "Spoofed event injection.",
        },
      },
    ],
    testCases: [
      {
        id: "TC-001",
        title: "Verifies HMAC signature header on dispatch",
        tier: "api_contract",
        verifiesReqIds: ["REQ-001"],
        targetFilePath: "tests/webhooks.contract.test.ts",
        deterministicAssertions: ["Asserts X-Webhook-Signature header is present"],
        skeletonCode: "expect(res.headers['x-webhook-signature']).toBeDefined();",
      },
    ],
  };
}

describe("specprism CLI", () => {
  it("prints v1.5.1 banner, verify-run, ci-guard, issues & edit-req help, and MCP 2026-07-28 readiness", () => {
    expect(formatCliBanner()).toContain("1.5.1");
    expect(formatCliBanner()).toContain("2026-07-28");
    expect(formatCliHelp()).toContain("specprism ci-guard");
    expect(formatCliHelp()).toContain("specprism verify-run");
    expect(formatCliHelp()).toContain("specprism issues");
    expect(formatCliHelp()).toContain("specprism edit-req");
    expect(runCli(["--version"])).toBe(0);
    expect(runCli(["--help"])).toBe(0);
  });

  it("ingests post-code Vitest JSON via verify-run and emits UAT scorecard, repair prompt, and bug backlog", () => {
    const dir = mkdtempSync(join(tmpdir(), "specprism-cli-uat-"));
    try {
      const specPath = join(dir, "spec.json");
      const repPath = join(dir, "vitest.json");
      const outMd = join(dir, "UAT.md");
      const repairMd = join(dir, "REPAIR.md");
      const bugsMd = join(dir, "BUGS.md");
      writeFileSync(specPath, JSON.stringify(buildSampleSpecJson(), null, 2), "utf8");
      writeFileSync(
        repPath,
        JSON.stringify({
          testResults: [
            {
              name: "tests/webhooks.contract.test.ts",
              assertionResults: [
                {
                  fullName: "[TC-001] Verifies HMAC signature header on dispatch",
                  status: "failed",
                  failureMessages: ["Expected header x-webhook-signature to be defined"],
                },
              ],
            },
          ],
        }),
        "utf8"
      );

      expect(
        runCli([
          "verify-run",
          specPath,
          repPath,
          "--out",
          outMd,
          "--repair-out",
          repairMd,
          "--bugs-out",
          bugsMd,
        ])
      ).toBe(0);
      expect(readFileSync(outMd, "utf8")).toContain("<!-- specprism-uat-report -->");
      expect(readFileSync(repairMd, "utf8")).toContain("REQ-001");
      expect(readFileSync(bugsMd, "utf8")).toContain("[UAT Bug] REQ-001");

      // --strict exits 1 when releaseReady is false
      expect(runCli(["verify-run", specPath, repPath, "--strict"])).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exports vertical story issues backlog and gh issue create script", () => {
    const dir = mkdtempSync(join(tmpdir(), "specprism-cli-issues-"));
    try {
      const specPath = join(dir, "spec.json");
      const outMd = join(dir, "ISSUES.md");
      const outSh = join(dir, "create-issues.sh");
      writeFileSync(specPath, JSON.stringify(buildSampleSpecJson(), null, 2), "utf8");

      expect(runCli(["issues", specPath, "--out", outMd, "--gh-script", outSh])).toBe(0);
      expect(readFileSync(outMd, "utf8")).toContain("US-001");
      expect(readFileSync(outSh, "utf8")).toContain("gh issue create");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs ci-guard Markdown generation and blocks drifted orphan REQs", () => {
    const dir = mkdtempSync(join(tmpdir(), "specprism-cli-ciguard-"));
    try {
      const specPath = join(dir, "spec.json");
      const outMd = join(dir, "PR_GUARD.md");
      const sample = buildSampleSpecJson();
      writeFileSync(specPath, JSON.stringify(sample, null, 2), "utf8");

      expect(runCli(["ci-guard", specPath, "--out", outMd])).toBe(0);
      expect(readFileSync(outMd, "utf8")).toContain("<!-- specprism-pr-guard -->");

      // Introduce an orphan REQ-002
      sample.criteria.push({
        ...sample.criteria[0]!,
        id: "REQ-002",
        title: "Orphan requirement",
      });
      writeFileSync(specPath, JSON.stringify(sample, null, 2), "utf8");
      expect(runCli(["ci-guard", specPath, "--out", outMd])).toBe(1);
      expect(readFileSync(outMd, "utf8")).toContain("BLOCKED");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("surgically edits REQ-* EARS clauses and ASM-* assumptions while rejecting invalid SHALL edits", () => {
    const dir = mkdtempSync(join(tmpdir(), "specprism-cli-110-"));
    try {
      const specPath = join(dir, "spec.json");
      writeFileSync(specPath, JSON.stringify(buildSampleSpecJson(), null, 2), "utf8");

      // Reject missing uppercase SHALL
      expect(
        runCli([
          "edit-req",
          specPath,
          "REQ-001",
          "When an event is dispatched, the system should maybe sign it.",
        ])
      ).toBe(1);

      // Valid EARS edit
      expect(
        runCli([
          "edit-req",
          specPath,
          "REQ-001",
          "WHEN an event is dispatched, THE Webhook Dispatcher SHALL attach X-Webhook-Signature and X-Webhook-Timestamp headers.",
        ])
      ).toBe(0);

      // Valid ASM edit
      expect(
        runCli([
          "edit-asm",
          specPath,
          "ASM-001",
          "Retry failed webhook deliveries 5 times with jittered exponential backoff.",
        ])
      ).toBe(0);

      const saved = JSON.parse(readFileSync(specPath, "utf8"));
      expect(saved.criteria[0].ears.rendered).toContain("X-Webhook-Timestamp");
      expect(saved.triage.lockedAssumptions[0].statement).toContain("5 times with jittered");
      expect(saved.triage.lockedAssumptions[0].source).toBe("user_edited");
      expect(runCli(["validate", specPath])).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
