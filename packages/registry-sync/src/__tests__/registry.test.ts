import { describe, expect, it } from "vitest";
import {
  formatContextWindowLabel,
  isCacheFresh,
  isFreeTierEligibleModel,
  normalizeOpenRouterModels,
  pickRecommendedModels,
  UPSTREAM_CATALOG_ENDPOINTS,
} from "../index.js";

describe("@specprism/registry-sync catalog hygiene & smart presets", () => {
  it("tracks TTL windows accurately for ETag-backed catalog syncs", () => {
    const baseNow = 1_795_700_000_000;
    expect(
      isCacheFresh(
        { etag: 'W/"abc"', fetchedAtIso: new Date(baseNow - 60_000).toISOString(), ttlSeconds: 14_400 },
        baseNow
      )
    ).toBe(true);
    expect(UPSTREAM_CATALOG_ENDPOINTS.officialMcpRegistry).toContain("modelcontextprotocol.io");
  });

  it("filters out :batch, ~aliases, and image models while ranking Tier-1 models ahead of obscure labs", () => {
    const normalized = normalizeOpenRouterModels(
      [
        {
          id: "aion-labs/aion-3.5-mini",
          name: "AionLabs: Aion 3.5 Mini",
          context_length: 262144,
          supported_parameters: ["structured_outputs"],
          pricing: { prompt: "0.0000001", completion: "0.0000004" },
        },
        {
          id: "anthropic/claude-haiku-5.5:batch",
          name: "Anthropic: Claude Haiku 5.5 (batch)",
          context_length: 1000000,
          supported_parameters: ["structured_outputs", "tools"],
          pricing: { prompt: "0.0000002", completion: "0.000001" },
        },
        {
          id: "~anthropic/claude-haiku-latest",
          name: "Anthropic: Claude Haiku Latest",
          context_length: 1000000,
          supported_parameters: ["tools"],
          pricing: { prompt: "0.0000002", completion: "0.000001" },
        },
        {
          id: "google/nano-banana-2-image",
          name: "Google: Nano Banana 2 (Image)",
          context_length: 65536,
          architecture: { output_modalities: ["image"] },
          supported_parameters: ["tools"],
          pricing: { prompt: "0.0000002", completion: "0.000001" },
        },
        {
          id: "anthropic/claude-haiku-5.5",
          name: "Anthropic: Claude Haiku 5.5 (free)",
          context_length: 1000000,
          supported_parameters: ["structured_outputs", "tools"],
          pricing: { prompt: "0.00000025", completion: "0.00000125" },
        },
        {
          id: "openai/gpt-5.5-pro",
          name: "OpenAI: GPT-5.5 Pro",
          context_length: 200000,
          supported_parameters: ["structured_outputs", "tools", "reasoning"],
          pricing: { prompt: "0.000005", completion: "0.000015" },
        },
      ],
      'W/"etag-2"'
    );

    const ids = normalized.map((m) => m.id);
    expect(ids).not.toContain("anthropic/claude-haiku-5.5:batch");
    expect(ids).not.toContain("~anthropic/claude-haiku-latest");
    expect(ids).not.toContain("google/nano-banana-2-image");
    expect(ids[0]).toBe("anthropic/claude-haiku-5.5");
    expect(normalized[0]?.displayName).toBe("Claude Haiku 5.5");
    expect(formatContextWindowLabel(1_000_000)).toBe("1M context");

    const enriched = normalized.map((m) => ({
      ...m,
      freeTierEligible: isFreeTierEligibleModel(m),
    }));
    const presets = pickRecommendedModels(enriched);
    expect(presets.fastFreeModelId).toBe("anthropic/claude-haiku-5.5");
    expect(presets.deepReasoningModelId).toBe("openai/gpt-5.5-pro");
  });
});
