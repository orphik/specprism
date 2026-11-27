import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createLlmProviderClient } from "../llm/provider-router.js";

const DemoSchema = z.object({
  verdict: z.string(),
});

describe("BYOK Provider Router — Sanitized Errors & Multi-Key Automatic Failover", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sanitizes raw Google Gemini JSON errors into clean human-readable messages when no fallback exists", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            code: 402,
            message: "Your prepayment credits are depleted. Visit https://ai.studio/projects.",
            status: "RESOURCE_EXHAUSTED",
          },
        }),
        { status: 402, headers: { "Content-Type": "application/json" } }
      )
    );

    const client = createLlmProviderClient({
      provider: "google",
      modelId: "gemini-2.5-pro",
      apiKey: "AQ.Ab8testkey",
    });

    await expect(
      client.generateStructured({
        schemaName: "DemoSchema",
        schema: DemoSchema,
        systemPrompt: "Return JSON",
        userPrompt: "Test",
        jsonStructureHint: '{"verdict":"ok"}',
      })
    ).rejects.toThrow(
      "Model provider (google) returned HTTP 402: Your prepayment credits are depleted. Visit https://ai.studio/projects."
    );
  });

  it("automatically fails over from an exhausted direct Google key (HTTP 402) to the user's OpenRouter BYOK key", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              code: 402,
              message: "Your prepayment credits are depleted.",
              status: "RESOURCE_EXHAUSTED",
            },
          }),
          { status: 402, headers: { "Content-Type": "application/json" } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"verdict":"failover_succeeded"}' } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );

    const client = createLlmProviderClient({
      provider: "google",
      modelId: "gemini-2.5-pro",
      apiKey: "AQ.Ab8depleted",
      fallback: {
        provider: "openrouter",
        modelId: "google/gemini-2.5-pro",
        apiKey: "sk-or-v1-funded",
        appUrl: "https://spec-prism.app",
      },
    });

    const result = await client.generateStructured({
      schemaName: "DemoSchema",
      schema: DemoSchema,
      systemPrompt: "Return JSON",
      userPrompt: "Test failover",
      jsonStructureHint: '{"verdict":"string"}',
    });

    expect(result.verdict).toBe("failover_succeeded");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(String(fetchSpy.mock.calls[0]![0])).toContain("generativelanguage.googleapis.com");
    expect(String(fetchSpy.mock.calls[1]![0])).toContain("openrouter.ai/api/v1/chat/completions");
  });

  it("handles concurrent parallel batch failover cleanly when multiple story workers hit HTTP 402 simultaneously", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("generativelanguage.googleapis.com")) {
        return new Response(
          JSON.stringify({ error: { code: 402, message: "Prepayment credits depleted." } }),
          { status: 402, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"verdict":"parallel_ok"}' } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });

    const client = createLlmProviderClient({
      provider: "google",
      modelId: "gemini-2.5-pro",
      apiKey: "AQ.Ab8depleted",
      fallback: {
        provider: "openrouter",
        modelId: "google/gemini-2.5-pro",
        apiKey: "sk-or-v1-funded",
      },
    });

    const parallelResults = await Promise.all(
      [1, 2, 3, 4].map((idx) =>
        client.generateStructured({
          schemaName: "DemoSchema",
          schema: DemoSchema,
          systemPrompt: "Return JSON",
          userPrompt: `Batch ${idx}`,
          jsonStructureHint: '{"verdict":"string"}',
        })
      )
    );

    expect(parallelResults.map((r) => r.verdict)).toEqual([
      "parallel_ok",
      "parallel_ok",
      "parallel_ok",
      "parallel_ok",
    ]);
  });
});
