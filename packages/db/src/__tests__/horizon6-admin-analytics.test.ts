import { describe, expect, it } from "vitest";
import {
  accounts,
  analyticsEvents,
  computePlatformAnalyticsSnapshot,
  createSpecPrismDb,
  personalAccessTokens,
  recordAnalyticsEvent,
  specIterations,
  specProjects,
  specSignoffs,
  specUatRuns,
  userApiKeys,
  users,
  verifyGoogleOAuthOwner,
} from "../index.js";

describe("Horizon 6 — Owner Analytics Telemetry & Google OAuth Gatekeeper", () => {
  it("TC-011: persists privacy-safe analytics_events in PGlite and aggregates 5-stage funnel, model latency, MCP, and referrer metrics", async () => {
    const conn = await createSpecPrismDb("memory://");

    await conn.db.insert(users).values([
      {
        id: "usr_owner",
        name: "Ryan Main",
        email: "orphik@gmail.com",
        emailVerified: true,
      },
      {
        id: "usr_builder_2",
        name: "Alex Dev",
        email: "alex@example.com",
        emailVerified: true,
      },
    ]);

    await conn.db.insert(accounts).values([
      {
        id: "acc_google_owner",
        accountId: "google_sub_123",
        providerId: "google",
        userId: "usr_owner",
      },
      {
        id: "acc_gh_builder",
        accountId: "gh_999",
        providerId: "github",
        userId: "usr_builder_2",
      },
    ]);

    await conn.db.insert(userApiKeys).values({
      userId: "usr_owner",
      provider: "openrouter",
      keyHint: "sk-or-...5a2e",
      encryptedKey: "enc_test_payload",
    });

    await conn.db.insert(personalAccessTokens).values({
      userId: "usr_owner",
      label: "Antigravity Laptop",
      tokenHash: "hash_pat_001",
    });

    const [p1] = await conn.db
      .insert(specProjects)
      .values({
        ownerId: "usr_owner",
        slug: "webhook-proxy-a1b2",
        title: "Webhook Proxy",
        visibility: "unlisted",
        latestIterationNumber: 2,
      })
      .returning();

    const [p2] = await conn.db
      .insert(specProjects)
      .values({
        ownerId: "usr_builder_2",
        slug: "billing-guard-c3d4",
        title: "Billing Guard",
        visibility: "private",
        latestIterationNumber: 1,
      })
      .returning();

    await conn.db.insert(specIterations).values([
      {
        projectId: p1!.id,
        iterationNumber: 1,
        stage: "stage_4_tests",
        rawPrompt: "Webhook proxy with retries",
        targetDialectId: "anthropic-claude",
        document: {
          projectId: p1!.id,
          iterationNumber: 1,
          stage: "stage_4_tests",
          preferredModelId: "google/gemini-2.5-pro",
          targetDialectId: "anthropic-claude",
        },
      },
      {
        projectId: p1!.id,
        iterationNumber: 2,
        stage: "stage_5_delta",
        rawPrompt: "Add HMAC verification",
        targetDialectId: "anthropic-claude",
        document: {
          projectId: p1!.id,
          iterationNumber: 2,
          stage: "stage_5_delta",
          preferredModelId: "google/gemini-2.5-pro",
          targetDialectId: "anthropic-claude",
        },
      },
      {
        projectId: p2!.id,
        iterationNumber: 1,
        stage: "stage_1_triage",
        rawPrompt: "Billing guard alerts",
        targetDialectId: "openai-gpt-reasoning",
        document: {
          projectId: p2!.id,
          iterationNumber: 1,
          stage: "stage_1_triage",
          preferredModelId: "preset:fast_free",
          targetDialectId: "openai-gpt-reasoning",
        },
      },
    ]);

    await conn.db.insert(specSignoffs).values({
      projectId: p1!.id,
      iterationNumber: 2,
      reviewerName: "Jordan PM",
      reviewerRole: "Product Manager",
      status: "approved",
    });

    await conn.db.insert(specUatRuns).values({
      projectId: p1!.id,
      iterationNumber: 2,
      runnerFormat: "vitest_json",
      overallPassRatePct: 85,
      releaseReady: false,
      report: {
        categoryBreakdown: [
          { category: "happy_path", passRatePct: 100 },
          { category: "negative_edge_case", passRatePct: 60 },
          { category: "non_functional_guardrail", passRatePct: 90 },
        ],
      },
    });

    await recordAnalyticsEvent(conn.db, {
      eventType: "pageview",
      path: "/",
      referrerUrl: "https://www.linkedin.com/feed/update/urn:li:activity:123?secret=stripme",
      visitorHash: "vis_hash_1",
    });
    await recordAnalyticsEvent(conn.db, {
      eventType: "pageview",
      path: "/guide",
      referrerUrl: "https://github.com/orphik/specprism",
      visitorHash: "vis_hash_2",
    });
    await recordAnalyticsEvent(conn.db, {
      eventType: "stage_run",
      path: "/api/specs",
      userId: "usr_owner",
      projectId: p1!.id,
      stage: "stage_4_tests",
      modelId: "google/gemini-2.5-pro",
      dialectId: "anthropic-claude",
      billingSource: "byok",
      durationMs: 4200,
      statusCode: 200,
    });
    await recordAnalyticsEvent(conn.db, {
      eventType: "stage_error",
      path: "/api/specs",
      userId: "usr_builder_2",
      stage: "stage_2_stories",
      modelId: "deepseek/deepseek-r1:free",
      billingSource: "free_tier",
      durationMs: 1800,
      statusCode: 429,
      metadata: { code: "RATE_LIMITED" },
    });
    await recordAnalyticsEvent(conn.db, {
      eventType: "mcp_call",
      path: "/mcp",
      userId: "usr_owner",
      statusCode: 200,
      metadata: { tool: "specprism_triage_idea" },
    });
    await recordAnalyticsEvent(conn.db, {
      eventType: "export_zip",
      path: `/api/specs/${p1!.id}/export`,
      userId: "usr_owner",
      projectId: p1!.id,
      dialectId: "anthropic-claude",
      statusCode: 200,
    });

    const rows = await conn.db.select().from(analyticsEvents);
    expect(rows).toHaveLength(6);
    expect(rows[0]!.referrerDomain).toBe("linkedin.com");

    const snapshot = await computePlatformAnalyticsSnapshot(conn.db, { windowDays: 30 });
    expect(snapshot.overview.totalUsers).toBe(2);
    expect(snapshot.overview.googleUsers).toBe(1);
    expect(snapshot.overview.githubUsers).toBe(1);
    expect(snapshot.overview.byokUsers).toBe(1);
    expect(snapshot.overview.totalProjects).toBe(2);
    expect(snapshot.overview.pageviewsInWindow).toBe(2);
    expect(snapshot.overview.uniqueVisitorsInWindow).toBe(2);
    expect(snapshot.overview.mcpCallsInWindow).toBe(1);
    expect(snapshot.overview.exportsInWindow).toBe(1);
    expect(snapshot.overview.avgHappyPathPct).toBe(100);
    expect(snapshot.overview.avgNegativeEdgePct).toBe(60);

    expect(snapshot.funnel.stages.find((s) => s.key === "stage_1_triage")?.count).toBe(2);
    expect(snapshot.funnel.stages.find((s) => s.key === "stage_4_tests")?.count).toBe(1);
    expect(snapshot.traffic.topReferrers.map((r) => r.referrerDomain)).toContain("linkedin.com");
    expect(snapshot.models.find((m) => m.modelId === "google/gemini-2.5-pro")?.avgDurationMs).toBe(
      4200
    );
    expect(snapshot.improvementSignals.length).toBeGreaterThan(0);

    await conn.close();
  });

  it("TC-012: enforces verified Google OAuth owner check (orphik@gmail.com) and rejects anonymous, non-admin, PAT, or GitHub-only sessions", async () => {
    const conn = await createSpecPrismDb("memory://");

    await conn.db.insert(users).values([
      {
        id: "usr_google_owner",
        name: "Ryan Main",
        email: "orphik@gmail.com",
        emailVerified: true,
      },
      {
        id: "usr_github_only_same_domain",
        name: "Other Dev",
        email: "someoneelse@gmail.com",
        emailVerified: true,
      },
      {
        id: "usr_github_only_spoof",
        name: "GitHub Only User",
        email: "githubonly@example.com",
        emailVerified: true,
      },
      {
        id: "usr_unverified",
        name: "Unverified",
        email: "unverified@gmail.com",
        emailVerified: false,
      },
    ]);

    await conn.db.insert(accounts).values([
      {
        id: "acc_1",
        accountId: "google_sub_owner",
        providerId: "google",
        userId: "usr_google_owner",
      },
      {
        id: "acc_2",
        accountId: "google_sub_other",
        providerId: "google",
        userId: "usr_github_only_same_domain",
      },
      {
        id: "acc_3",
        accountId: "github_sub_only",
        providerId: "github",
        userId: "usr_github_only_spoof",
      },
    ]);

    // 1. Anonymous / null user -> false
    expect(
      await verifyGoogleOAuthOwner(conn.db, {
        userId: null,
        sessionEmail: null,
        requiredOwnerEmail: "orphik@gmail.com",
      })
    ).toBe(false);

    // 2. Different Google user -> false
    expect(
      await verifyGoogleOAuthOwner(conn.db, {
        userId: "usr_github_only_same_domain",
        sessionEmail: "someoneelse@gmail.com",
        requiredOwnerEmail: "orphik@gmail.com",
      })
    ).toBe(false);

    // 3. GitHub-only user (even if requiredOwnerEmail matched their email without a Google account row) -> false
    expect(
      await verifyGoogleOAuthOwner(conn.db, {
        userId: "usr_github_only_spoof",
        sessionEmail: "githubonly@example.com",
        requiredOwnerEmail: "githubonly@example.com",
      })
    ).toBe(false);

    // 4. Unverified email -> false
    await conn.db.insert(accounts).values({
      id: "acc_4",
      accountId: "google_unverified",
      providerId: "google",
      userId: "usr_unverified",
    });
    expect(
      await verifyGoogleOAuthOwner(conn.db, {
        userId: "usr_unverified",
        sessionEmail: "unverified@gmail.com",
        requiredOwnerEmail: "unverified@gmail.com",
      })
    ).toBe(false);

    // 5. Verified Google OAuth owner (orphik@gmail.com + emailVerified + providerId === 'google') -> true
    expect(
      await verifyGoogleOAuthOwner(conn.db, {
        userId: "usr_google_owner",
        sessionEmail: "Orphik@Gmail.com ",
        requiredOwnerEmail: "orphik@gmail.com",
      })
    ).toBe(true);

    await conn.close();
  });
});
