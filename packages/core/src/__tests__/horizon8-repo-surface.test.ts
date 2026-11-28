import { describe, expect, it, vi } from "vitest";
import {
  normalizePushedSurfaceJson,
  runStage1SocraticTriage,
  runStage4TestBlueprint,
  scanPublicGitHubRepoSurface,
  type LlmProviderClient,
} from "../index.js";

describe("Horizon 8 — Brownfield Repo Surface Grounding & SSRF Guardrails", () => {
  it("TC-016: scans public GitHub repo trees/manifests, normalizes MCP surface.json, and injects RepoSurfaceContext into Stages 1-4", async () => {
    const mockFetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://api.github.com/repos/orphik/demo-app") {
        return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 });
      }
      if (url === "https://api.github.com/repos/orphik/demo-app/git/trees/main?recursive=1") {
        return new Response(
          JSON.stringify({
            tree: [
              { path: "package.json", type: "blob" },
              { path: "src/app/page.tsx", type: "blob" },
              { path: "src/db/schema.ts", type: "blob" },
              { path: "src/__tests__/billing.test.ts", type: "blob" },
              { path: "node_modules/ignored/index.js", type: "blob" },
            ],
          }),
          { status: 200 }
        );
      }
      if (url === "https://raw.githubusercontent.com/orphik/demo-app/main/package.json") {
        return new Response(
          JSON.stringify({
            packageManager: "pnpm@10.0.0",
            dependencies: { next: "15.0.0", react: "19.0.0", "drizzle-orm": "0.40.0" },
            devDependencies: { vitest: "3.0.0", "@playwright/test": "1.50.0" },
          }),
          { status: 200 }
        );
      }
      return new Response("Not found", { status: 404 });
    });

    const surface = await scanPublicGitHubRepoSurface("https://github.com/orphik/demo-app", {
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    expect(surface.repoSlug).toBe("orphik/demo-app");
    expect(surface.frameworks).toEqual(expect.arrayContaining(["nextjs", "react"]));
    expect(surface.orms).toContain("drizzle");
    expect(surface.testRunners).toEqual(expect.arrayContaining(["vitest", "playwright"]));
    expect(surface.samplePaths).toContain("src/__tests__/billing.test.ts");
    expect(surface.samplePaths).not.toContain("node_modules/ignored/index.js");

    const mcpNormalized = normalizePushedSurfaceJson(
      {
        mode: "brownfield",
        packageManager: "pnpm",
        frameworks: ["nextjs"],
        orms: ["drizzle"],
        testRunners: ["vitest"],
        codeFileCount: 42,
        samplePaths: ["packages/core/src/index.ts"],
      },
      "mcp_push"
    );
    expect(mcpNormalized.source).toBe("mcp_push");
    expect(mcpNormalized.orms).toContain("drizzle");

    const capturedPrompts: string[] = [];
    const mockLlm: LlmProviderClient = {
      async generateStructured(req) {
        capturedPrompts.push(req.userPrompt);
        if (req.schemaName === "Stage1SocraticTriage") {
          return req.schema.parse({
            projectTitle: "Demo Billing Guard",
            rawPrompt: "Add billing webhook idempotency",
            scopedVisionSummary: "Enforce idempotent Stripe webhooks in Next.js + Drizzle.",
            primaryActors: ["Backend Service"],
            explicitOutOfScopeV1: ["Multi-currency tax calculation"],
            questions: [
              {
                id: "q-1",
                dimension: "failure_and_recovery_states",
                exploitClass: "partial_mutation",
                detectedAmbiguity: "Duplicate webhook retry handling",
                question: "How should duplicate webhook event IDs behave?",
                options: [
                  { id: "o1", label: "Unique event_id ledger in Drizzle", tradeoffNote: "Safe", recommended: true },
                  { id: "o2", label: "In-memory cache", tradeoffNote: "Lost on restart", recommended: false },
                ],
              },
              {
                id: "q-2",
                dimension: "security_auth_and_rate_limits",
                detectedAmbiguity: "Signature verification",
                question: "Reject invalid signatures?",
                options: [
                  { id: "o1", label: "Verify HMAC before DB write", tradeoffNote: "Zero-trust", recommended: true },
                  { id: "o2", label: "Log and accept", tradeoffNote: "Unsafe", recommended: false },
                ],
              },
              {
                id: "q-3",
                dimension: "v1_out_of_scope_boundary",
                detectedAmbiguity: "Dead-letter UI",
                question: "Include admin replay UI in v1?",
                options: [
                  { id: "o1", label: "Defer replay UI to v2", tradeoffNote: "Lean v1", recommended: true },
                  { id: "o2", label: "Build full replay UI", tradeoffNote: "Slower", recommended: false },
                ],
              },
            ],
            lockedAssumptions: [],
          });
        }
        return req.schema.parse({
          testCases: [
            {
              id: "TC-001",
              title: "Verifies REQ-001 in real repo test path",
              tier: "unit",
              verifiesReqIds: ["REQ-001"],
              targetFilePath: "src/__tests__/billing.test.ts",
              skeletonCode: "expect(true).toBe(true);",
              deterministicAssertions: ["Idempotent insert"],
            },
          ],
        });
      },
    };

    const triage = await runStage1SocraticTriage({
      rawPrompt: "Add billing webhook idempotency",
      llm: mockLlm,
      repoSurface: surface,
    });

    await runStage4TestBlueprint({
      triage,
      features: [],
      criteria: [
        {
          id: "REQ-001",
          storyId: "US-001",
          category: "happy_path",
          title: "Idempotent Stripe Event Ledger",
          gwt: { given: ["event arrives"], when: "processed", then: ["deduped"] },
          ears: {
            pattern: "event_driven",
            systemName: "Webhook Handler",
            triggerOrCondition: "a webhook arrives",
            shallResponse: "deduplicate by event_id",
            rendered: "WHEN a webhook arrives, THE Webhook Handler SHALL deduplicate by event_id.",
          },
          coaching: { whyItMatters: "No double charges", failureModePrevented: "Duplicate ledger credits" },
        },
      ],
      llm: mockLlm,
      repoSurface: surface,
    });

    expect(capturedPrompts[0]).toContain("orphik/demo-app");
    expect(capturedPrompts[0]).toContain("drizzle");
    expect(capturedPrompts[1]).toContain("src/__tests__/billing.test.ts");
  });

  it("TC-017: rejects non-GitHub SSRF URLs before fetching and deterministically caps repository trees at 400 paths", async () => {
    const spyFetch = vi.fn();

    for (const hostileUrl of [
      "http://169.254.169.254/latest/meta-data/",
      "https://localhost:3000/orphik/specprism",
      "https://evil.example.com/github.com/orphik/specprism",
      "https://github.com/orphik/../../etc/passwd",
      "http://github.com/orphik/specprism",
    ]) {
      await expect(
        scanPublicGitHubRepoSurface(hostileUrl, {
          fetchImpl: spyFetch as unknown as typeof fetch,
        })
      ).rejects.toThrow(/github\.com/i);
    }
    expect(spyFetch).not.toHaveBeenCalled();

    const hugeTree = Array.from({ length: 650 }, (_, i) => ({
      path: `src/modules/mod-${String(i).padStart(4, "0")}.ts`,
      type: "blob",
    }));
    const mockLargeFetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/git/trees/")) {
        return new Response(JSON.stringify({ tree: hugeTree }), { status: 200 });
      }
      if (url.endsWith("/repos/orphik/monorepo")) {
        return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    });

    const capped = await scanPublicGitHubRepoSurface("https://github.com/orphik/monorepo", {
      fetchImpl: mockLargeFetch as unknown as typeof fetch,
    });
    expect(capped.samplePaths).toHaveLength(400);
    expect(capped.codeFileCount).toBe(650);
  });
});
