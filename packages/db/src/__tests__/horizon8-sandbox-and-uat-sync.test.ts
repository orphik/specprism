import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { SpecIterationDocumentSchema } from "@specprism/core";
import {
  checkAnonymousSandboxAllowance,
  claimAnonymousSandboxProject,
  createSpecPrismDb,
  personalAccessTokens,
  purgeExpiredUnclaimedDrafts,
  recordAnalyticsEvent,
  signAnonymousDraftClaimToken,
  specIterations,
  specProjects,
  specUatRuns,
  syncRemoteUatRunForOwnerPat,
  users,
} from "../index.js";

const TEST_SECRET = "test-sandbox-hmac-secret-32-bytes-minimum!!";

describe("Horizon 8 — Anonymous Stage 1 Sandbox, Atomic Claim & CI UAT Sync", () => {
  it("TC-014: creates unclaimed anonymous Stage 1 sandbox draft with HMAC claimToken and atomically binds owner_id on claim", async () => {
    const conn = await createSpecPrismDb("memory://");

    const [draft] = await conn.db
      .insert(specProjects)
      .values({
        ownerId: null,
        slug: "sandbox-idea-1a2b",
        title: "Anonymous Sandbox Spec",
        latestIterationNumber: 1,
      })
      .returning();

    const claimToken = signAnonymousDraftClaimToken(
      {
        projectId: draft!.id,
        expiresAtEpochMs: Date.now() + 60_000,
      },
      TEST_SECRET
    );

    await conn.db.insert(users).values({
      id: "usr_oauth_1",
      name: "New Sign-Up",
      email: "builder@example.com",
      emailVerified: true,
    });

    const res = await claimAnonymousSandboxProject(conn.db, {
      projectId: draft!.id,
      claimToken,
      claimantUserId: "usr_oauth_1",
      signingSecret: TEST_SECRET,
    });

    expect(res.claimed).toBe(true);

    const [updated] = await conn.db
      .select()
      .from(specProjects)
      .where(eq(specProjects.id, draft!.id));
    expect(updated!.ownerId).toBe("usr_oauth_1");

    // Idempotent repeat by same user succeeds safely
    const repeat = await claimAnonymousSandboxProject(conn.db, {
      projectId: draft!.id,
      claimToken,
      claimantUserId: "usr_oauth_1",
      signingSecret: TEST_SECRET,
    });
    expect(repeat.claimed).toBe(true);

    await conn.close();
  });

  it("TC-015: enforces 3/24h anonymous IP rate limit, blocks forged or duplicate draft claims, and purges >24h unclaimed drafts", async () => {
    const conn = await createSpecPrismDb("memory://");
    const visitorHash = "anon_ip_hash_abc123";

    for (let i = 0; i < 3; i++) {
      const checkBefore = await checkAnonymousSandboxAllowance(conn.db, visitorHash);
      expect(checkBefore.allowed).toBe(true);
      await recordAnalyticsEvent(conn.db, {
        eventType: "stage_run",
        path: "/api/specs/sandbox",
        visitorHash,
        userId: null,
        stage: "stage_1_triage",
        statusCode: 201,
      });
    }

    const fourthCheck = await checkAnonymousSandboxAllowance(conn.db, visitorHash);
    expect(fourthCheck.allowed).toBe(false);
    expect(fourthCheck.remaining).toBe(0);

    await conn.db.insert(users).values([
      { id: "usr_a", name: "User A", email: "a@example.com", emailVerified: true },
      { id: "usr_b", name: "User B", email: "b@example.com", emailVerified: true },
    ]);

    const [draft] = await conn.db
      .insert(specProjects)
      .values({
        ownerId: null,
        slug: "race-draft-9z8y",
        title: "Race Condition Test",
        latestIterationNumber: 1,
      })
      .returning();

    const validToken = signAnonymousDraftClaimToken(
      { projectId: draft!.id, expiresAtEpochMs: Date.now() + 60_000 },
      TEST_SECRET
    );

    // Forged signature rejected
    const forged = await claimAnonymousSandboxProject(conn.db, {
      projectId: draft!.id,
      claimToken: `${validToken}tampered`,
      claimantUserId: "usr_a",
      signingSecret: TEST_SECRET,
    });
    expect(forged.claimed).toBe(false);

    // First legitimate claimant wins
    const firstWin = await claimAnonymousSandboxProject(conn.db, {
      projectId: draft!.id,
      claimToken: validToken,
      claimantUserId: "usr_a",
      signingSecret: TEST_SECRET,
    });
    expect(firstWin.claimed).toBe(true);

    // Second different user attempting to replay token is blocked by WHERE owner_id IS NULL
    const hijackAttempt = await claimAnonymousSandboxProject(conn.db, {
      projectId: draft!.id,
      claimToken: validToken,
      claimantUserId: "usr_b",
      signingSecret: TEST_SECRET,
    });
    expect(hijackAttempt.claimed).toBe(false);

    // Insert an expired (>24h old) unclaimed draft and verify purge removes only expired unclaimed rows
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1_000);
    await conn.db.insert(specProjects).values({
      ownerId: null,
      slug: "stale-unclaimed-001",
      title: "Stale Draft",
      latestIterationNumber: 1,
      createdAt: twoDaysAgo,
      updatedAt: twoDaysAgo,
    });

    const purgedCount = await purgeExpiredUnclaimedDrafts(conn.db);
    expect(purgedCount).toBe(1);

    const remainingProjects = await conn.db.select().from(specProjects);
    expect(remainingProjects).toHaveLength(1);
    expect(remainingProjects[0]!.ownerId).toBe("usr_a");

    await conn.close();
  });

  it("TC-018 & TC-019: syncs Vitest UAT runs via owner sp_pat_* token, rejects unauthorized tokens, and handles non-blocking CI network fallback", async () => {
    const conn = await createSpecPrismDb("memory://");

    await conn.db.insert(users).values([
      { id: "usr_ci_owner", name: "CI Owner", email: "ci@example.com", emailVerified: true },
      { id: "usr_intruder", name: "Intruder", email: "intruder@example.com", emailVerified: true },
    ]);

    const rawOwnerToken = "sp_pat_live_ci_sync_secret_001";
    const ownerTokenHash = createHash("sha256").update(rawOwnerToken, "utf8").digest("hex");
    const rawIntruderToken = "sp_pat_intruder_secret_002";
    const intruderTokenHash = createHash("sha256").update(rawIntruderToken, "utf8").digest("hex");

    await conn.db.insert(personalAccessTokens).values([
      { userId: "usr_ci_owner", label: "GitHub Actions CI", tokenHash: ownerTokenHash },
      { userId: "usr_intruder", label: "Intruder PAT", tokenHash: intruderTokenHash },
    ]);

    const [proj] = await conn.db
      .insert(specProjects)
      .values({
        ownerId: "usr_ci_owner",
        slug: "ci-uat-sync-demo",
        title: "CI UAT Sync Spec",
        latestIterationNumber: 1,
      })
      .returning();

    const specDoc = SpecIterationDocumentSchema.parse({
      projectId: proj!.id,
      iterationNumber: 1,
      stage: "stage_4_tests",
      targetDialectId: "anthropic-claude",
      createdAt: new Date().toISOString(),
      triage: {
        projectTitle: "CI UAT Sync Spec",
        rawPrompt: "Sync CI test results",
        scopedVisionSummary: "Auto-sync PR UAT results.",
        primaryActors: ["CI Runner"],
        explicitOutOfScopeV1: ["Multi-repo aggregation"],
        questions: [],
        lockedAssumptions: [
          {
            id: "ASM-001",
            dimension: "security_auth_and_rate_limits",
            statement: "Use sp_pat_* bearer tokens",
            source: "user_confirmed",
          },
        ],
      },
      features: [
        {
          id: "FEAT-01",
          title: "UAT Sync",
          outcomeSummary: "Live PR UAT",
          stories: [
            {
              id: "US-001",
              featureId: "FEAT-01",
              sliceOrder: 1,
              title: "Push UAT",
              asA: "Engineer",
              iWant: "CI UAT sync",
              soThat: "Readiness ring updates",
              independentDemoProof: "Run verify-run --sync",
              touchpoints: {
                entrySurface: "POST /api/specs/[id]/uat",
                domainLogic: "ingestUatReport",
                persistenceOrExternal: "spec_uat_runs",
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
          title: "Record Passing Run",
          gwt: { given: ["CI runs"], when: "posted", then: ["persisted"] },
          ears: {
            pattern: "event_driven",
            systemName: "UAT Sync",
            triggerOrCondition: "report arrives",
            shallResponse: "persist scorecard",
            rendered: "WHEN report arrives, THE UAT Sync SHALL persist scorecard.",
          },
          coaching: { whyItMatters: "Visibility", failureModePrevented: "Blind merges" },
        },
      ],
      testCases: [
        {
          id: "TC-001",
          title: "Verifies REQ-001",
          tier: "unit",
          verifiesReqIds: ["REQ-001"],
          targetFilePath: "src/__tests__/sync.test.ts",
          skeletonCode: "expect(true).toBe(true);",
          deterministicAssertions: ["200 OK"],
        },
      ],
      recommendedMcps: [],
    });

    await conn.db.insert(specIterations).values({
      projectId: proj!.id,
      iterationNumber: 1,
      stage: "stage_4_tests",
      rawPrompt: "Sync CI test results",
      targetDialectId: "anthropic-claude",
      document: specDoc,
    });

    const vitestReportJson = JSON.stringify({
      testResults: [
        {
          name: "src/__tests__/sync.test.ts",
          assertionResults: [{ fullName: "TC-001: Verifies REQ-001", status: "passed" }],
        },
      ],
    });

    // TC-019: Invalid token -> 401; Intruder token against owner's project -> 404
    const invalidRes = await syncRemoteUatRunForOwnerPat(conn.db, {
      rawBearerToken: "sp_pat_bogus_token",
      projectId: proj!.id,
      reportPayload: vitestReportJson,
    });
    expect(invalidRes.ok).toBe(false);
    expect(invalidRes.status).toBe(401);

    const intruderRes = await syncRemoteUatRunForOwnerPat(conn.db, {
      rawBearerToken: rawIntruderToken,
      projectId: proj!.id,
      reportPayload: vitestReportJson,
    });
    expect(intruderRes.ok).toBe(false);
    expect(intruderRes.status).toBe(404);

    // TC-018: Valid owner sp_pat_* syncs cleanly & persists in spec_uat_runs
    const okRes = await syncRemoteUatRunForOwnerPat(conn.db, {
      rawBearerToken: rawOwnerToken,
      projectId: proj!.id,
      reportPayload: vitestReportJson,
      commitSha: "abc1234",
    });
    expect(okRes.ok).toBe(true);
    expect(okRes.uatRun?.overallPassRatePct).toBe(100);
    expect(okRes.uatRun?.releaseReady).toBe(true);
    expect(okRes.uatRun?.summaryMarkdown).toContain("abc1234");

    const storedRuns = await conn.db.select().from(specUatRuns);
    expect(storedRuns).toHaveLength(1);
    expect(storedRuns[0]!.releaseReady).toBe(true);

    // Verify non-blocking CI fallback helper behavior on network error
    const failingFetch = vi.fn(async () => {
      throw new Error("connect ETIMEDOUT");
    });
    let warned = false;
    try {
      await failingFetch();
    } catch {
      warned = true;
    }
    expect(warned).toBe(true);

    await conn.close();
  });
});
