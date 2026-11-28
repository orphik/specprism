import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  accounts,
  createSpecPrismDb,
  specProjects,
  specSignoffs,
  supporterContributions,
  users,
} from "../index.js";

describe("Horizon 4 — Unified PG Stakeholder Sign-Offs & GitHub Sponsors Rail", () => {
  it("persists stakeholder sign-offs per iteration and records github_sponsors supporter badges in PGlite", async () => {
    const conn = await createSpecPrismDb("memory://", { autoBootstrap: true });
    try {
      await conn.db.insert(users).values({
        id: "usr-h4-owner",
        name: "Alex Rivera",
        email: "alex@example.com",
      });
      await conn.db.insert(accounts).values({
        id: "acc-gh-1",
        accountId: "99887766",
        providerId: "github",
        userId: "usr-h4-owner",
      });

      const [proj] = await conn.db
        .insert(specProjects)
        .values({
          ownerId: "usr-h4-owner",
          slug: "invoice-reminder-h4",
          title: "Invoice Reminder Spec",
          visibility: "unlisted",
          latestIterationNumber: 2,
        })
        .returning();

      await conn.db.insert(specSignoffs).values({
        projectId: proj!.id,
        iterationNumber: 2,
        reviewerName: "Maya Chen",
        reviewerRole: "QA",
        status: "approved",
        note: "All 15 REQ-* EARS clauses and 27 TC-* tests look rock solid.",
      });

      const rows = await conn.db
        .select()
        .from(specSignoffs)
        .where(eq(specSignoffs.projectId, proj!.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.reviewerName).toBe("Maya Chen");
      expect(rows[0]?.status).toBe("approved");

      await conn.db.insert(supporterContributions).values({
        userId: "usr-h4-owner",
        rail: "github_sponsors",
        externalReferenceId: "gh_sponsorship_99887766_monthly",
        amountCents: 1000,
        currency: "usd",
        cadence: "monthly",
      });
      await conn.db
        .update(users)
        .set({ isSupporter: true, supporterSince: new Date() })
        .where(eq(users.id, "usr-h4-owner"));

      const [updatedUser] = await conn.db
        .select()
        .from(users)
        .where(eq(users.id, "usr-h4-owner"));
      expect(updatedUser?.isSupporter).toBe(true);
    } finally {
      await conn.close();
    }
  });
});
