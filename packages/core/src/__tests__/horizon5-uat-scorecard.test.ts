import { describe, expect, it } from "vitest";
import {
  BUILTIN_DIALECT_PROFILES,
  compileFailingBugTickets,
  compileIssueTrackerBacklog,
  compileUatRepairPrompt,
  ingestUatReport,
  SpecIterationDocumentSchema,
} from "../index.js";

const SAMPLE_SPEC = SpecIterationDocumentSchema.parse({
  projectId: "55555555-5555-4555-8555-555555555555",
  iterationNumber: 1,
  stage: "stage_4_tests",
  targetDialectId: "anthropic-claude",
  recommendedMcps: [],
  createdAt: "2026-11-27T04:00:00.000Z",
  triage: {
    projectTitle: 'Team Invites \\" $(whoami) `id` \'single\'',
    rawPrompt: "Build team workspace invites with expiring magic links and Stripe seat caps",
    scopedVisionSummary: "Invite teammates safely within Stripe seat limits.",
    primaryActors: ["Workspace Admin", "Invited Member"],
    explicitOutOfScopeV1: ["SAML SCIM provisioning"],
    questions: [],
    lockedAssumptions: [
      {
        id: "ASM-001",
        dimension: "security_auth_and_rate_limits",
        statement: "Expire invite tokens after 48h and invalidate prior tokens on resend.",
        source: "user_confirmed",
      },
    ],
  },
  features: [
    {
      id: "FEAT-01",
      title: "Workspace Invites",
      outcomeSummary: "Manage magic-link invites.",
      stories: [
        {
          id: "US-001",
          featureId: "FEAT-01",
          sliceOrder: 1,
          title: 'Send & Validate Invite \\" $(cmd) \'quote\'',
          asA: "Workspace Admin",
          iWant: "to invite teammates with 48h expiry and seat checks",
          soThat: "unauthorized or over-quota joins are blocked",
          independentDemoProof: "Send invite and test expired token.",
          touchpoints: {
            entrySurface: "POST /api/invites",
            domainLogic: "InviteService",
            persistenceOrExternal: "PostgreSQL workspace_invites",
          },
          linkedAssumptionIds: ["ASM-001"],
        },
      ],
    },
  ],
  criteria: [
    {
      id: "REQ-001",
      storyId: "US-001",
      category: "happy_path",
      title: "Valid Invite Creation",
      gwt: {
        given: ["workspace has available seats"],
        when: "admin invites alice@example.com",
        then: ["48h token is persisted"],
      },
      ears: {
        pattern: "event_driven",
        systemName: "InviteService",
        triggerOrCondition: "admin submits valid invite",
        shallResponse: "create single-use 48h invite token",
        rendered: "WHEN admin submits valid invite, THE InviteService SHALL create single-use 48h invite token.",
      },
      coaching: {
        whyItMatters: "Baseline happy path.",
        failureModePrevented: "Broken invite flow",
      },
    },
    {
      id: "REQ-002",
      storyId: "US-001",
      category: "negative_edge_case",
      title: "Reject Expired 48h Magic Link",
      gwt: {
        given: ["invite token is 49 hours old"],
        when: "invitee clicks magic link",
        then: ["HTTP 410 Gone is returned"],
      },
      ears: {
        pattern: "unwanted_event",
        systemName: "InviteService",
        triggerOrCondition: "an invite token exceeds 48 hours",
        shallResponse: "reject redemption with HTTP 410 Gone",
        rendered: "IF an invite token exceeds 48 hours, THEN THE InviteService SHALL reject redemption with HTTP 410 Gone.",
      },
      coaching: {
        whyItMatters: "Closes stale link replay window.",
        failureModePrevented: "Indefinite magic link validity",
      },
    },
    {
      id: "REQ-003",
      storyId: "US-001",
      category: "non_functional_guardrail",
      title: "Enforce Stripe Seat Cap Concurrency Lock",
      gwt: {
        given: ["1 seat remains"],
        when: "two invites redeem concurrently",
        then: ["second redemption returns HTTP 409 Seat Limit Reached"],
      },
      ears: {
        pattern: "state_driven",
        systemName: "InviteService",
        triggerOrCondition: "workspace seats are full",
        shallResponse: "serialize redemptions and reject over-cap joins with HTTP 409",
        rendered: "WHILE workspace seats are full, THE InviteService SHALL serialize redemptions and reject over-cap joins with HTTP 409.",
      },
      coaching: {
        whyItMatters: "Prevents billing leakage.",
        failureModePrevented: "TOCTOU seat over-allocation",
      },
    },
  ],
  testCases: [
    {
      id: "TC-001",
      title: "[TC-001] Creates valid 48h invite token",
      tier: "api_contract",
      verifiesReqIds: ["REQ-001"],
      targetFilePath: "tests/invites-happy.spec.ts",
      skeletonCode: "expect(res.status).toBe(201);",
      deterministicAssertions: ["HTTP 201"],
    },
    {
      id: "TC-002",
      title: "[TC-002] Rejects expired 49h invite token with 410",
      tier: "api_contract",
      verifiesReqIds: ["REQ-002"],
      targetFilePath: "tests/invites-edge.spec.ts",
      skeletonCode: "expect(res.status).toBe(410);",
      deterministicAssertions: ["HTTP 410 Gone"],
    },
    {
      id: "TC-003",
      title: "[TC-003] Blocks concurrent over-cap redemption with 409",
      tier: "e2e_playwright",
      verifiesReqIds: ["REQ-003"],
      targetFilePath: "tests/invites-guardrail.spec.ts",
      skeletonCode: "expect(second.status).toBe(409);",
      deterministicAssertions: ["HTTP 409 Conflict"],
    },
  ],
});

describe("Horizon 5 (v1.5.0) — Post-Code UAT Ingest, Category Split, Repair Prompt & Shell Safety", () => {
  it("ingests Vitest JSON reports, computes Category Readiness Split, and compiles Dialect Repair Prompts + Bug Tickets", () => {
    const vitestJson = JSON.stringify({
      numTotalTests: 3,
      testResults: [
        {
          name: "/repo/tests/invites-happy.spec.ts",
          assertionResults: [
            {
              fullName: "Invites > [TC-001] Creates valid 48h invite token",
              status: "passed",
              duration: 18,
            },
          ],
        },
        {
          name: "/repo/tests/invites-edge.spec.ts",
          assertionResults: [
            {
              fullName: "Invites > [TC-002] Rejects expired 49h invite token with 410",
              status: "failed",
              duration: 42,
              failureMessages: ["AssertionError: expected 200 to be 410 // token expiry check missing"],
            },
          ],
        },
        {
          name: "/repo/tests/invites-guardrail.spec.ts",
          assertionResults: [
            {
              fullName: "Invites > [TC-003] Blocks concurrent over-cap redemption with 409",
              status: "passed",
              duration: 95,
            },
          ],
        },
      ],
    });

    const scorecard = ingestUatReport(SAMPLE_SPEC, vitestJson);
    expect(scorecard.runnerFormat).toBe("vitest_json");
    expect(scorecard.releaseReady).toBe(false);
    expect(scorecard.overallPassRatePct).toBe(67);
    expect(scorecard.verifiedReqIds).toEqual(["REQ-001", "REQ-003"]);
    expect(scorecard.failingReqIds).toEqual(["REQ-002"]);

    const happy = scorecard.categoryBreakdown.find((c) => c.category === "happy_path")!;
    const edge = scorecard.categoryBreakdown.find((c) => c.category === "negative_edge_case")!;
    const guard = scorecard.categoryBreakdown.find((c) => c.category === "non_functional_guardrail")!;
    expect(happy.passRatePct).toBe(100);
    expect(edge.passRatePct).toBe(0);
    expect(edge.failedReqs).toBe(1);
    expect(guard.passRatePct).toBe(100);

    // 1-Click Dialect-Tuned Repair Prompt (Claude XML vs OpenAI Markdown)
    const claudeDialect = BUILTIN_DIALECT_PROFILES.find((d) => d.id === "anthropic-claude")!;
    const repair = compileUatRepairPrompt(SAMPLE_SPEC, scorecard, claudeDialect);
    expect(repair.prompt).toContain("REQ-002");
    expect(repair.prompt).toContain("expected 200 to be 410");
    expect(repair.prompt).toContain("TC-001"); // Locked as Regression Shield!
    expect(repair.prompt).toContain("<failing_acceptance_criteria>");

    // Deferred Bug Ticket Export + POSIX single-quote shell safety
    const bugs = compileFailingBugTickets(SAMPLE_SPEC, scorecard);
    expect(bugs.tickets).toHaveLength(1);
    expect(bugs.tickets[0]!.reqId).toBe("REQ-002");
    expect(bugs.ghCliScript).not.toContain('"$(cmd)"');
    expect(bugs.ghCliScript).toContain("--label 'bug,specprism'");
  });

  it("ingests Playwright JSON and JUnit XML test reports accurately", () => {
    const playwrightJson = JSON.stringify({
      suites: [
        {
          title: "invites.spec.ts",
          specs: [
            {
              title: "TC-001 happy invite",
              file: "tests/invites-happy.spec.ts",
              tests: [{ results: [{ status: "passed", duration: 120 }] }],
            },
            {
              title: "TC-002 expired link",
              file: "tests/invites-edge.spec.ts",
              tests: [{ results: [{ status: "passed", duration: 135 }] }],
            },
            {
              title: "TC-003 seat cap lock",
              file: "tests/invites-guardrail.spec.ts",
              tests: [{ results: [{ status: "passed", duration: 210 }] }],
            },
          ],
        },
      ],
    });

    const pwRun = ingestUatReport(SAMPLE_SPEC, playwrightJson);
    expect(pwRun.runnerFormat).toBe("playwright_json");
    expect(pwRun.releaseReady).toBe(true);
    expect(pwRun.overallPassRatePct).toBe(100);

    const junitXml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="InviteSuite" tests="3">
    <testcase classname="tests/invites-happy.spec.ts" name="[TC-001] happy" time="0.02"/>
    <testcase classname="tests/invites-edge.spec.ts" name="[TC-002] expired" time="0.04"/>
    <testcase classname="tests/invites-guardrail.spec.ts" name="[TC-003] concurrency" time="0.09">
      <failure message="Expected 409 Conflict, got 200 OK">Race condition in seat counter</failure>
    </testcase>
  </testsuite>
</testsuites>`;

    const junitRun = ingestUatReport(SAMPLE_SPEC, junitXml);
    expect(junitRun.runnerFormat).toBe("junit_xml");
    expect(junitRun.releaseReady).toBe(false);
    expect(junitRun.failingReqIds).toEqual(["REQ-003"]);
  });

  it("POSIX single-quotes hostile backslashes, command substitutions, and quotes in issue-tracker-exporter", () => {
    const issues = compileIssueTrackerBacklog(SAMPLE_SPEC);
    expect(issues.ghCliScript).toContain("gh issue create --title '[US-001]");
    expect(issues.ghCliScript).not.toContain('--title "');
    expect(issues.ghCliScript).toContain("'\\''quote'\\''");
  });
});
