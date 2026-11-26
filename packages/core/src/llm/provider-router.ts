import type { z } from "zod";

export type LlmProviderType =
  | "openrouter"
  | "openai"
  | "anthropic"
  | "google"
  | "ollama"
  | "custom";

export interface LlmProviderConfig {
  provider: LlmProviderType;
  modelId: string;
  apiKey?: string;
  baseUrl?: string;
  appUrl?: string;
}

export interface GenerateStructuredParams<T> {
  schemaName: string;
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  systemPrompt: string;
  userPrompt: string;
  jsonStructureHint: string;
  temperature?: number;
}

export interface LlmProviderClient {
  readonly modelId: string;
  generateStructured<T>(params: GenerateStructuredParams<T>): Promise<T>;
}

function sanitizeUpstreamError(provider: string, status: number, rawBody: string): string {
  try {
    const parsed = JSON.parse(rawBody) as {
      error?: { message?: string } | string;
      message?: string;
    };
    const msg =
      (typeof parsed.error === "object" ? parsed.error?.message : parsed.error) ??
      parsed.message ??
      "Upstream model request failed.";
    const redacted = msg.replace(/\borg_[a-zA-Z0-9_]+\b/g, "[redacted]");
    return `Model provider (${provider}) returned HTTP ${status}: ${redacted}`;
  } catch {
    const snippet = rawBody.replace(/\borg_[a-zA-Z0-9_]+\b/g, "[redacted]").slice(0, 180);
    return `Model provider (${provider}) returned HTTP ${status}: ${snippet || "Request failed"}`;
  }
}

function extractJsonObject(rawText: string): unknown {
  const trimmed = rawText.trim();
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fencedMatch?.[1]?.trim() ?? trimmed;

  try {
    return JSON.parse(candidate);
  } catch {
    const firstBrace = candidate.indexOf("{");
    const lastBrace = candidate.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      return JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
    }
    throw new Error(`Model response did not contain valid JSON: ${trimmed.slice(0, 240)}`);
  }
}

async function callRawCompletion(
  config: LlmProviderConfig,
  systemPrompt: string,
  userPrompt: string,
  temperature: number
): Promise<string> {
  const { provider, modelId, apiKey, baseUrl, appUrl } = config;

  if (provider === "ollama") {
    const root = (baseUrl ?? "http://127.0.0.1:11434").replace(/\/$/, "");
    const cleanModel = modelId.replace(/^ollama\//, "");
    const res = await fetch(`${root}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: cleanModel,
        stream: false,
        format: "json",
        options: { temperature },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });
    if (!res.ok) {
      throw new Error(`Ollama error (${res.status}): ${await res.text()}`);
    }
    const payload = (await res.json()) as { message?: { content?: string } };
    return payload.message?.content ?? "";
  }

  if (provider === "anthropic") {
    if (!apiKey) throw new Error("Anthropic API key is required.");
    const cleanModel = modelId.replace(/^anthropic\//, "");
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: cleanModel,
        max_tokens: 8192,
        temperature,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      }),
    });
    if (!res.ok) {
      throw new Error(`Anthropic API error (${res.status}): ${await res.text()}`);
    }
    const payload = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    return payload.content?.find((c) => c.type === "text")?.text ?? "";
  }

  if (provider === "google") {
    if (!apiKey) throw new Error("Google Gemini API key is required.");
    const cleanModel = modelId.replace(/^google\//, "");
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      cleanModel
    )}:generateContent`;
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: "user", parts: [{ text: userPrompt }] }],
        generationConfig: {
          temperature,
          responseMimeType: "application/json",
        },
      }),
    });
    if (!res.ok) {
      throw new Error(`Google Gemini API error (${res.status}): ${await res.text()}`);
    }
    const payload = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    return payload.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  }

  // Default: OpenRouter, OpenAI, or Custom OpenAI-compatible Chat Completions
  if (!apiKey && provider !== "custom") {
    throw new Error(`API key is required for provider '${provider}'.`);
  }
  const endpoint =
    provider === "openrouter"
      ? "https://openrouter.ai/api/v1/chat/completions"
      : `${(baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "")}/chat/completions`;

  const cleanModel =
    provider === "openai" ? modelId.replace(/^openai\//, "") : modelId;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  if (provider === "openrouter") {
    headers["HTTP-Referer"] = appUrl ?? "https://spec-prism.app";
    headers["X-Title"] = "SpecPrism";
  }

  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: cleanModel,
      temperature,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(sanitizeUpstreamError(provider, res.status, await res.text()));
  }

  const payload = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return payload.choices?.[0]?.message?.content ?? "";
}

export function createLlmProviderClient(config: LlmProviderConfig): LlmProviderClient {
  return {
    modelId: config.modelId,
    async generateStructured<T>(params: GenerateStructuredParams<T>): Promise<T> {
      const temperature = params.temperature ?? 0.2;
      const fullSystem = `${params.systemPrompt}\n\nCRITICAL OUTPUT CONTRACT:\nReturn ONLY a single valid JSON object matching schema '${params.schemaName}'. Do NOT wrap in prose.\nExpected JSON shape:\n${params.jsonStructureHint}`;

      const firstRaw = await callRawCompletion(config, fullSystem, params.userPrompt, temperature);

      let firstIssueSummary = "";
      try {
        const extracted = extractJsonObject(firstRaw);
        const parsed = params.schema.safeParse(extracted);
        if (parsed.success) {
          return parsed.data;
        }
        firstIssueSummary = parsed.error.issues
          .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
          .join("; ");
      } catch (err) {
        firstIssueSummary = err instanceof Error ? err.message : "Invalid JSON syntax";
      }

      // 1-shot self-healing repair pass feeding exact Zod/JSON errors back
      const repairPrompt = `${params.userPrompt}\n\nYour previous JSON response failed strict schema validation with these errors:\n${firstIssueSummary}\n\nPrevious output snippet:\n${firstRaw.slice(
        0,
        2_500
      )}\n\nReturn the corrected, complete JSON object ONLY.`;

      const repairedRaw = await callRawCompletion(config, fullSystem, repairPrompt, 0.1);
      const extractedRepair = extractJsonObject(repairedRaw);
      return params.schema.parse(extractedRepair);
    },
  };
}
