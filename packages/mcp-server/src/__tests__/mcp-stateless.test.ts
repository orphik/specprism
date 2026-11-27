import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  handleStatelessMcpRequest,
  signMcpRequestState,
  verifyMcpRequestState,
} from "../index.js";

describe("@specprism/mcp-server 2026-07-28 compliance", () => {
  const secret = "unit-test-hmac-secret-key-32-chars!!";

  it("signs and verifies stateless MRTR requestState handles and detects tampering", () => {
    const signed = signMcpRequestState(
      {
        protocolVersion: "2026-07-28",
        projectId: "550e8400-e29b-41d4-a716-446655440000",
        iterationNumber: 1,
        pendingStage: "stage_1_triage",
        elicitationRound: 1,
        draftTriageHash: "sha256:1234",
        expiresAtEpochMs: Date.now() + 60_000,
      },
      secret
    );

    const verified = verifyMcpRequestState(signed, secret);
    expect(verified.elicitationRound).toBe(1);

    expect(() =>
      verifyMcpRequestState({ ...signed, elicitationRound: 2 }, secret)
    ).toThrow(/Invalid MCP requestState signature/);
  });

  it("rejects legacy Mcp-Session-Id headers and returns cacheable tools/list, resources/list, prompts/list, and skills/list", async () => {
    const legacyReq = new Request("https://spec-prism.app/mcp", {
      method: "POST",
      headers: { "Mcp-Session-Id": "old-session-123" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const legacyRes = await handleStatelessMcpRequest(legacyReq);
    expect(legacyRes.status).toBe(400);

    for (const method of ["tools/list", "resources/list", "prompts/list", "skills/list"]) {
      const req = new Request("https://spec-prism.app/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Mcp-Method": method },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: `req-${method}`,
          method,
          params: { _meta: { protocolVersion: "2026-07-28" } },
        }),
      });
      const res = await handleStatelessMcpRequest(req);
      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toContain("max-age=");
      const payload = (await res.json()) as {
        result: { cache: { ttlMs: number; cacheScope: string } };
      };
      expect(payload.result.cache.ttlMs).toBeGreaterThan(0);
    }
  });

  it("executes stateless 2-round MRTR Socratic elicitation without sticky session state and sets Cache-Control: no-store", async () => {
    // Round 1
    const round1Req = new Request("https://spec-prism.app/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Mcp-Method": "tools/call" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "mrtr-1",
        method: "tools/call",
        params: {
          _meta: { protocolVersion: "2026-07-28" },
          name: "specprism_triage_idea",
          arguments: {
            ideaPrompt: "Build an API webhook debugger with HMAC signature verification.",
          },
        },
      }),
    });
    const round1Res = await handleStatelessMcpRequest(round1Req, { signingSecret: secret });
    expect(round1Res.status).toBe(200);
    expect(round1Res.headers.get("Cache-Control")).toBe("no-store");

    const round1Json = (await round1Res.json()) as {
      result: {
        status: string;
        draftTriage: { questions: Array<{ id: string; options: Array<{ id: string }> }> };
        requestState: Record<string, unknown>;
      };
    };
    expect(round1Json.result.status).toBe("elicitation_required");
    expect(round1Json.result.draftTriage.questions.length).toBeGreaterThanOrEqual(3);

    // Round 2 (completely fresh stateless call using signed requestState)
    const round2Req = new Request("https://spec-prism.app/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Mcp-Method": "tools/call" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "mrtr-2",
        method: "tools/call",
        params: {
          _meta: { protocolVersion: "2026-07-28" },
          name: "specprism_triage_idea",
          arguments: {
            ideaPrompt: "Build an API webhook debugger with HMAC signature verification.",
            draftTriage: round1Json.result.draftTriage,
            requestState: round1Json.result.requestState,
            answers: round1Json.result.draftTriage.questions.map((q) => ({
              questionId: q.id,
              selectedOptionId: q.options[0]!.id,
            })),
          },
        },
      }),
    });
    const round2Res = await handleStatelessMcpRequest(round2Req, { signingSecret: secret });
    expect(round2Res.status).toBe(200);
    expect(round2Res.headers.get("Cache-Control")).toBe("no-store");
    const round2Json = (await round2Res.json()) as {
      result: { status: string; lockedAssumptions: Array<{ id: string }> };
    };
    expect(round2Json.result.status).toBe("triage_locked");
    expect(round2Json.result.lockedAssumptions.length).toBeGreaterThanOrEqual(3);
  });

  it("compiles 9-family dialects (xai-grok) and exports issue tracker backlogs via stateless MCP tools", async () => {
    const sampleSpec = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../../../../specprism/spec.json"), "utf8")
    );

    const compileReq = new Request("https://spec-prism.app/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "dialect-grok",
        method: "tools/call",
        params: {
          _meta: { protocolVersion: "2026-07-28" },
          name: "specprism_compile_dialect",
          arguments: { spec: sampleSpec, dialectId: "xai-grok" },
        },
      }),
    });
    const compileRes = await handleStatelessMcpRequest(compileReq, { signingSecret: secret });
    expect(compileRes.status).toBe(200);
    const compileJson = (await compileRes.json()) as {
      result: { dialectId: string; prompt: string };
    };
    expect(compileJson.result.dialectId).toBe("xai-grok");
    expect(compileJson.result.prompt).toContain("Engineering Contract:");

    const issuesReq = new Request("https://spec-prism.app/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "export-issues",
        method: "tools/call",
        params: {
          _meta: { protocolVersion: "2026-07-28" },
          name: "specprism_export_issues",
          arguments: { spec: sampleSpec },
        },
      }),
    });
    const issuesRes = await handleStatelessMcpRequest(issuesReq, { signingSecret: secret });
    expect(issuesRes.status).toBe(200);
    const issuesJson = (await issuesRes.json()) as {
      result: { tickets: Array<{ storyId: string }>; ghCliScript: string };
    };
    expect(issuesJson.result.tickets.length).toBeGreaterThanOrEqual(3);
    expect(issuesJson.result.ghCliScript).toContain("gh issue create");

    const uatReq = new Request("https://spec-prism.app/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "ingest-uat",
        method: "tools/call",
        params: {
          _meta: { protocolVersion: "2026-07-28" },
          name: "specprism_ingest_uat",
          arguments: {
            spec: sampleSpec,
            report: {
              results: sampleSpec.testCases.map((tc: { id: string }, i: number) => ({
                testCaseId: tc.id,
                status: i === 0 ? "failed" : "passed",
                failureMessage: i === 0 ? "Expected orphan rejection" : undefined,
              })),
            },
            dialectId: "anthropic-claude",
          },
        },
      }),
    });
    const uatRes = await handleStatelessMcpRequest(uatReq, { signingSecret: secret });
    expect(uatRes.status).toBe(200);
    const uatJson = (await uatRes.json()) as {
      result: {
        uatRun: { releaseReady: boolean; failingReqIds: string[] };
        repairPrompt: string;
      };
    };
    expect(uatJson.result.uatRun.releaseReady).toBe(false);
    expect(uatJson.result.uatRun.failingReqIds).toContain("REQ-001");
    expect(uatJson.result.repairPrompt).toContain("<failing_acceptance_criteria>");
  });
});
