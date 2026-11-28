import { describe, expect, it } from "vitest";
import { createSpecPrismDb, specProjects, specUatRuns, users } from "../index.js";

describe("Horizon 5 — Unified PostgreSQL spec_uat_runs Persistence", () => {
  it("persists and queries Post-Code UAT scorecards in embedded PGlite", async () => {
    const conn = await createSpecPrismDb("memory://");
    await conn.db.insert(users).values({
      id: "usr_uat_1",
      name: "QA Architect",
      email: "qa@specprism.test",
      emailVerified: true,
    });

    const [proj] = await conn.db
      .insert(specProjects)
      .values({
        ownerId: "usr_uat_1",
        slug: "uat-demo-1",
        title: "Post-Code UAT Demo",
        latestIterationNumber: 1,
      })
      .returning();

    const [inserted] = await conn.db
      .insert(specUatRuns)
      .values({
        projectId: proj!.id,
        iterationNumber: 1,
        runnerFormat: "vitest_json",
        overallPassRatePct: 67,
        releaseReady: false,
        report: {
          runId: "uat_run_01",
          iterationNumber: 1,
          runnerFormat: "vitest_json",
          executedAt: new Date().toISOString(),
          overallPassRatePct: 67,
          releaseReady: false,
          categoryBreakdown: [],
          testResults: [],
          verifiedReqIds: ["REQ-001", "REQ-003"],
          failingReqIds: ["REQ-002"],
          unrunReqIds: [],
          summaryMarkdown: "<!-- specprism-uat-report -->",
        },
      })
      .returning();

    expect(inserted!.overallPassRatePct).toBe(67);
    expect(inserted!.releaseReady).toBe(false);
    await conn.close();
  });
});
