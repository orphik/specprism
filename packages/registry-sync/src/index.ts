import { desc, like, or, sql } from "drizzle-orm";
import { aiModels, type AnySpecPrismDrizzleDb } from "@specprism/db";

export const UPSTREAM_CATALOG_ENDPOINTS = {
  openRouterModels: "https://openrouter.ai/api/v1/models",
  liteLlmPricing:
    "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
  officialMcpRegistry: "https://registry.modelcontextprotocol.io/v0/servers",
  defaultOllamaTags: "http://127.0.0.1:11434/api/tags",
} as const;

export * from "./mcp-registry.js";

export const CURATED_PROVIDER_PRIORITY: Record<string, { label: string; rank: number }> = {
  anthropic: { label: "Anthropic", rank: 1 },
  google: { label: "Google", rank: 2 },
  openai: { label: "OpenAI", rank: 3 },
  deepseek: { label: "DeepSeek", rank: 4 },
  "x-ai": { label: "xAI", rank: 5 },
  qwen: { label: "Qwen", rank: 6 },
  meta: { label: "Meta", rank: 7 },
  "meta-llama": { label: "Meta", rank: 7 },
  mistralai: { label: "Mistral", rank: 8 },
  ollama: { label: "Local Ollama", rank: 9 },
};

const NON_CHAT_MODEL_PATTERN =
  /\b(image|imagen|flux|stable-diffusion|sdxl|whisper|tts|audio|embed|embedding|moderation|rerank|nano-banana|vision-only)\b/i;

export interface EtagCacheMetadata {
  etag?: string;
  fetchedAtIso: string;
  ttlSeconds: number;
}

export function isCacheFresh(meta: EtagCacheMetadata | undefined, nowMs = Date.now()): boolean {
  if (!meta) return false;
  const ageMs = nowMs - new Date(meta.fetchedAtIso).getTime();
  return ageMs >= 0 && ageMs < meta.ttlSeconds * 1_000;
}

export interface OpenRouterRawModel {
  id: string;
  name?: string;
  context_length?: number;
  architecture?: {
    modality?: string;
    output_modalities?: string[];
  };
  top_provider?: { max_completion_tokens?: number | null };
  supported_parameters?: string[];
  pricing?: { prompt?: string; completion?: string };
}

export interface NormalizedAiModelRow {
  id: string;
  provider: string;
  displayName: string;
  contextWindow: number;
  maxOutputTokens: number | null;
  supportsStructuredOutput: boolean;
  supportsTools: boolean;
  supportsReasoning: boolean;
  inputCostPerMillionUsd: string | null;
  outputCostPerMillionUsd: string | null;
  sourceCatalog: string;
  sourceEtag: string | null;
}

export function cleanModelDisplayName(rawName: string, modelId: string): string {
  const base = (rawName || modelId)
    .replace(/\s*\((?:free|batch|extended|preview)\)\s*/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const colonIdx = base.indexOf(":");
  if (colonIdx > 0 && colonIdx < 24) {
    return base.slice(colonIdx + 1).trim();
  }
  return base;
}

export function formatContextWindowLabel(tokens: number): string {
  if (tokens >= 950_000) return "1M context";
  if (tokens >= 450_000) return "500K context";
  if (tokens >= 190_000) return "200K context";
  if (tokens >= 120_000) return "128K context";
  if (tokens >= 60_000) return "64K context";
  return `${Math.round(tokens / 1024)}K context`;
}

export function isCuratedProvider(provider: string): boolean {
  return Boolean(CURATED_PROVIDER_PRIORITY[provider.toLowerCase()]);
}

export function getProviderDisplayLabel(provider: string): string {
  return (
    CURATED_PROVIDER_PRIORITY[provider.toLowerCase()]?.label ??
    provider.charAt(0).toUpperCase() + provider.slice(1)
  );
}

export function normalizeOpenRouterModels(
  rawModels: OpenRouterRawModel[],
  etag?: string | null
): NormalizedAiModelRow[] {
  const rows: NormalizedAiModelRow[] = [];

  for (const m of rawModels) {
    if (!m.id || !m.context_length || m.context_length < 16_384) continue;
    // Exclude offline :batch endpoints and internal ~router aliases
    if (m.id.startsWith("~")) continue;
    if (m.id.includes(":batch") || /\(batch\)/i.test(m.name ?? "")) continue;

    // Exclude image/audio/embedding-only models
    const outModalities = m.architecture?.output_modalities;
    if (Array.isArray(outModalities) && outModalities.length > 0 && !outModalities.includes("text")) {
      continue;
    }
    if (
      m.architecture?.modality &&
      !m.architecture.modality.toLowerCase().includes("->text") &&
      m.architecture.modality.includes("->")
    ) {
      continue;
    }
    if (NON_CHAT_MODEL_PATTERN.test(m.id) || NON_CHAT_MODEL_PATTERN.test(m.name ?? "")) {
      continue;
    }

    const slashIdx = m.id.indexOf("/");
    const provider = slashIdx > 0 ? m.id.slice(0, slashIdx).toLowerCase() : "openrouter";
    const params = new Set(m.supported_parameters ?? []);

    const promptPerToken = m.pricing?.prompt ? Number(m.pricing.prompt) : NaN;
    const completionPerToken = m.pricing?.completion ? Number(m.pricing.completion) : NaN;

    const inputPerMillion =
      Number.isFinite(promptPerToken) && promptPerToken >= 0
        ? (promptPerToken * 1_000_000).toFixed(4)
        : null;
    const outputPerMillion =
      Number.isFinite(completionPerToken) && completionPerToken >= 0
        ? (completionPerToken * 1_000_000).toFixed(4)
        : null;

    rows.push({
      id: m.id,
      provider,
      displayName: cleanModelDisplayName(m.name ?? m.id, m.id),
      contextWindow: m.context_length,
      maxOutputTokens: m.top_provider?.max_completion_tokens ?? null,
      supportsStructuredOutput:
        params.has("structured_outputs") || params.has("response_format"),
      supportsTools: params.has("tools") || params.has("tool_choice"),
      supportsReasoning:
        params.has("reasoning") ||
        params.has("include_reasoning") ||
        /\b(r1|o1|o3|o4|thinking|reasoner|opus|sonnet|pro)\b/i.test(m.id),
      inputCostPerMillionUsd: inputPerMillion,
      outputCostPerMillionUsd: outputPerMillion,
      sourceCatalog: "openrouter",
      sourceEtag: etag ?? null,
    });
  }

  // Sort curated Tier-1 providers & structured-output models first before slicing
  rows.sort((a, b) => {
    const rankA = CURATED_PROVIDER_PRIORITY[a.provider]?.rank ?? 99;
    const rankB = CURATED_PROVIDER_PRIORITY[b.provider]?.rank ?? 99;
    if (rankA !== rankB) return rankA - rankB;
    if (a.supportsStructuredOutput !== b.supportsStructuredOutput) {
      return a.supportsStructuredOutput ? -1 : 1;
    }
    return a.displayName.localeCompare(b.displayName);
  });

  return rows;
}

export function isFreeTierEligibleModel(model: {
  id?: string;
  contextWindow: number;
  supportsStructuredOutput: boolean;
  supportsTools: boolean;
  inputCostPerMillionUsd: string | number | null;
  outputCostPerMillionUsd: string | number | null;
  sourceCatalog?: string;
}): boolean {
  if (model.id && (model.id.includes(":batch") || model.id.startsWith("~"))) return false;
  if (model.sourceCatalog === "ollama") return true;
  if (model.contextWindow < 32_768) return false;
  if (!model.supportsStructuredOutput && !model.supportsTools) return false;
  const inCost = model.inputCostPerMillionUsd !== null ? Number(model.inputCostPerMillionUsd) : NaN;
  const outCost =
    model.outputCostPerMillionUsd !== null ? Number(model.outputCostPerMillionUsd) : NaN;
  if (!Number.isFinite(inCost) || !Number.isFinite(outCost)) return false;
  return inCost <= 0.8 && outCost <= 3.5;
}

export function pickRecommendedModels<
  T extends {
    id: string;
    provider: string;
    supportsStructuredOutput: boolean;
    supportsReasoning: boolean;
    freeTierEligible: boolean;
  },
>(models: T[], unlockedByokProviders: ReadonlySet<string> = new Set()): {
  fastFreeModelId: string | undefined;
  deepReasoningModelId: string | undefined;
} {
  const hasUniversalKey = unlockedByokProviders.has("openrouter");

  // Best fast Free-Tier model from trusted Tier-1 labs first
  const freePool = models.filter((m) => m.freeTierEligible && !m.id.endsWith(":free"));
  const tier1Free = freePool.filter(
    (m) =>
      (m.provider === "anthropic" || m.provider === "google" || m.provider === "openai") &&
      m.supportsStructuredOutput
  );
  const fastFree = tier1Free[0] ?? freePool.find((m) => isCuratedProvider(m.provider)) ?? freePool[0] ?? models[0];

  // Best Deep Reasoning model (preferring unlocked BYOK provider if user added a key)
  const reasoningPool = models.filter(
    (m) =>
      m.supportsReasoning &&
      isCuratedProvider(m.provider) &&
      (hasUniversalKey ||
        unlockedByokProviders.size === 0 ||
        unlockedByokProviders.has(m.provider) ||
        m.freeTierEligible)
  );
  const nonFreeFrontierReasoning = reasoningPool.find((m) => !m.freeTierEligible);
  const deepReasoning = nonFreeFrontierReasoning ?? reasoningPool[0] ?? fastFree;

  return {
    fastFreeModelId: fastFree?.id,
    deepReasoningModelId: deepReasoning?.id,
  };
}

export async function ensureFreshModelCatalog(
  db: AnySpecPrismDrizzleDb,
  options: { ttlSeconds?: number; ollamaBaseUrl?: string; probeOllama?: boolean } = {}
): Promise<void> {
  const ttlSeconds = options.ttlSeconds ?? 14_400;

  // Always purge any legacy :batch, ~alias, or image-only rows so invalid endpoints never appear
  await db
    .delete(aiModels)
    .where(
      or(
        like(aiModels.id, "%:batch%"),
        like(aiModels.id, "~%"),
        like(aiModels.id, "%image%"),
        like(aiModels.id, "%nano-banana%")
      )
    );

  const latest = await db
    .select({ syncedAt: aiModels.syncedAt, sourceEtag: aiModels.sourceEtag })
    .from(aiModels)
    .orderBy(desc(aiModels.syncedAt))
    .limit(1);

  const recentRow = latest[0];
  if (
    recentRow &&
    isCacheFresh({
      etag: recentRow.sourceEtag ?? undefined,
      fetchedAtIso: recentRow.syncedAt.toISOString(),
      ttlSeconds,
    })
  ) {
    return;
  }

  try {
    const res = await fetch(UPSTREAM_CATALOG_ENDPOINTS.openRouterModels, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });

    if (res.status === 200) {
      const etag = res.headers.get("etag");
      const json = (await res.json()) as { data?: OpenRouterRawModel[] };
      const normalized = normalizeOpenRouterModels(json.data ?? [], etag).slice(0, 180);

      for (const row of normalized) {
        await db
          .insert(aiModels)
          .values({
            ...row,
            syncedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: aiModels.id,
            set: {
              displayName: row.displayName,
              contextWindow: row.contextWindow,
              maxOutputTokens: row.maxOutputTokens,
              supportsStructuredOutput: row.supportsStructuredOutput,
              supportsTools: row.supportsTools,
              supportsReasoning: row.supportsReasoning,
              inputCostPerMillionUsd: row.inputCostPerMillionUsd,
              outputCostPerMillionUsd: row.outputCostPerMillionUsd,
              sourceEtag: row.sourceEtag,
              syncedAt: sql`now()`,
            },
          });
      }
    }
  } catch {
    // Gracefully tolerate offline / air-gapped environments
  }

  if (options.probeOllama) {
    try {
      const base = (options.ollamaBaseUrl ?? "http://127.0.0.1:11434").replace(/\/$/, "");
      const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(1_200) });
      if (res.ok) {
        const payload = (await res.json()) as {
          models?: Array<{ name: string }>;
        };
        for (const m of payload.models ?? []) {
          const id = `ollama/${m.name}`;
          await db
            .insert(aiModels)
            .values({
              id,
              provider: "ollama",
              displayName: m.name,
              contextWindow: 32768,
              supportsStructuredOutput: true,
              supportsTools: true,
              supportsReasoning: /r1|qwq|think/i.test(m.name),
              inputCostPerMillionUsd: "0.0000",
              outputCostPerMillionUsd: "0.0000",
              sourceCatalog: "ollama",
            })
            .onConflictDoUpdate({
              target: aiModels.id,
              set: { syncedAt: sql`now()` },
            });
        }
      }
    } catch {
      // No local Ollama running — ignore silently
    }
  }
}
