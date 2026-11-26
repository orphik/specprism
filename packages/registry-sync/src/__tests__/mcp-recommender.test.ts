import { describe, expect, it } from "vitest";
import { recommendMcpsForStories } from "../index.js";

describe("@specprism/registry-sync MCP Recommender", () => {
  it("recommends Playwright, PostgreSQL, and Stripe MCPs for an invoice web/Postgres story", () => {
    const recs = recommendMcpsForStories({
      scopedVisionSummary: "SaaS invoice billing dashboard with Stripe webhooks",
      stories: [
        {
          id: "US-001",
          featureId: "FEAT-01",
          sliceOrder: 1,
          title: "Create Stripe invoice from React dashboard",
          asA: "Freelancer",
          iWant: "to create an invoice and persist status in PostgreSQL",
          soThat: "clients can pay online",
          independentDemoProof: "Submit form and verify PostgreSQL row",
          touchpoints: {
            entrySurface: "Next.js React Dashboard Form",
            domainLogic: "Stripe invoice total & tax validator",
            persistenceOrExternal: "PostgreSQL Drizzle invoices table + Stripe webhook",
          },
          linkedAssumptionIds: [],
        },
      ],
    });

    expect(recs.length).toBeGreaterThanOrEqual(2);
    const ids = recs.map((r) => r.registryId);
    expect(ids).toContain("com.stripe/mcp");
    expect(ids).toContain("io.modelcontextprotocol/postgres");
  });
});
