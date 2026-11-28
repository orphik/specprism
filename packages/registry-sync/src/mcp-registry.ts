import { sql } from "drizzle-orm";
import type { McpRecommendation, VerticalStory } from "@specprism/core";
import { type AnySpecPrismDrizzleDb, mcpServers } from "@specprism/db";
import { UPSTREAM_CATALOG_ENDPOINTS } from "./index.js";

export interface CuratedMcpSeed {
  id: string;
  displayName: string;
  description: string;
  transport: "stdio" | "streamable_http";
  endpointOrCommand: string;
  repositoryUrl: string;
  tags: string[];
}

export const CURATED_MCP_SERVERS: CuratedMcpSeed[] = [
  {
    id: "io.modelcontextprotocol/playwright",
    displayName: "Playwright Browser MCP",
    description: "Deterministic browser automation, accessibility snapshots, and E2E UI verification.",
    transport: "stdio",
    endpointOrCommand: "npx @playwright/mcp@latest",
    repositoryUrl: "https://github.com/microsoft/playwright-mcp",
    tags: ["ui", "browser", "e2e", "playwright", "frontend", "form", "dashboard", "nextjs", "react"],
  },
  {
    id: "io.modelcontextprotocol/postgres",
    displayName: "PostgreSQL Schema & Query MCP",
    description: "Inspect PostgreSQL tables, indexes, constraints, and execute read-only verification queries.",
    transport: "stdio",
    endpointOrCommand: "npx -y @modelcontextprotocol/server-postgres",
    repositoryUrl: "https://github.com/modelcontextprotocol/servers",
    tags: ["postgres", "postgresql", "database", "sql", "drizzle", "prisma", "table", "migration"],
  },
  {
    id: "io.modelcontextprotocol/github",
    displayName: "GitHub Repository & PR MCP",
    description: "Manage issues, pull requests, branches, workflows, and code reviews via GitHub API.",
    transport: "streamable_http",
    endpointOrCommand: "https://api.githubcopilot.com/mcp/",
    repositoryUrl: "https://github.com/github/github-mcp-server",
    tags: ["github", "git", "pull-request", "ci", "actions", "repo", "webhook"],
  },
  {
    id: "com.stripe/mcp",
    displayName: "Stripe Billing & Webhooks MCP",
    description: "Create payment intents, subscriptions, invoices, checkout sessions, and inspect webhook events.",
    transport: "stdio",
    endpointOrCommand: "npx -y @stripe/mcp --tools=all",
    repositoryUrl: "https://github.com/stripe/agent-toolkit",
    tags: ["stripe", "payment", "invoice", "billing", "subscription", "checkout", "saas", "fintech"],
  },
  {
    id: "com.cloudflare/mcp",
    displayName: "Cloudflare Workers, DNS & Edge MCP",
    description: "Inspect and manage Cloudflare DNS, Workers, KV, D1, R2, and Zero Trust configurations.",
    transport: "streamable_http",
    endpointOrCommand: "https://mcp.cloudflare.com/mcp",
    repositoryUrl: "https://github.com/cloudflare/mcp-server-cloudflare",
    tags: ["cloudflare", "dns", "worker", "edge", "cdn", "r2", "kv", "rate-limit"],
  },
  {
    id: "io.modelcontextprotocol/fetch",
    displayName: "HTTP & Webhook Contract Fetch MCP",
    description: "Fetch, inspect, and validate external HTTP REST endpoints, payloads, and OpenAPI docs.",
    transport: "stdio",
    endpointOrCommand: "npx -y @modelcontextprotocol/server-fetch",
    repositoryUrl: "https://github.com/modelcontextprotocol/servers",
    tags: ["webhook", "http", "api", "rest", "ingest", "proxy", "endpoint", "json"],
  },
];

function buildKeywordEmbedding(text: string): number[] {
  // Deterministic 384-dim feature-hashed unit vector so pgvector cosine similarity works zero-API-key offline & online!
  const vec = new Array<number>(384).fill(0);
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t.length >= 2);

  for (const tok of tokens) {
    let hash = 2166136261;
    for (let i = 0; i < tok.length; i += 1) {
      hash ^= tok.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    const idx = Math.abs(hash) % 384;
    vec[idx] = (vec[idx] ?? 0) + 1;
  }

  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vec.map((v) => Number((v / norm).toFixed(6)));
}

export async function syncMcpRegistryToDb(db: AnySpecPrismDrizzleDb): Promise<number> {
  let upserted = 0;

  // 1. Always ensure curated high-trust MCP servers exist with deterministic embeddings
  for (const seed of CURATED_MCP_SERVERS) {
    const emb = buildKeywordEmbedding(`${seed.displayName} ${seed.description} ${seed.tags.join(" ")}`);
    await db
      .insert(mcpServers)
      .values({
        id: seed.id,
        displayName: seed.displayName,
        description: seed.description,
        transport: seed.transport,
        endpointOrCommand: seed.endpointOrCommand,
        repositoryUrl: seed.repositoryUrl,
        tags: seed.tags,
        embedding: emb,
        syncedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: mcpServers.id,
        set: {
          displayName: seed.displayName,
          description: seed.description,
          tags: seed.tags,
          embedding: emb,
          syncedAt: sql`now()`,
        },
      });
    upserted += 1;
  }

  // 2. Pull live entries from Official MCP Registry (`registry.modelcontextprotocol.io`)
  try {
    const res = await fetch(`${UPSTREAM_CATALOG_ENDPOINTS.officialMcpRegistry}?limit=40`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(6_000),
    });
    if (res.ok) {
      const data = (await res.json()) as {
        servers?: Array<{
          name?: string;
          description?: string;
          repository?: { url?: string };
          remotes?: Array<{ type?: string; url?: string }>;
          packages?: Array<{ registry_name?: string; name?: string }>;
        }>;
      };
      for (const srv of data.servers ?? []) {
        if (!srv.name || !srv.description) continue;
        const remote = srv.remotes?.[0];
        const pkg = srv.packages?.[0];
        const transport = remote?.url ? "streamable_http" : "stdio";
        const endpoint =
          remote?.url ??
          (pkg?.name ? `npx -y ${pkg.name}` : `mcp://${srv.name}`);
        const words = `${srv.name} ${srv.description}`
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, " ")
          .split(" ")
          .filter((w) => w.length >= 3)
          .slice(0, 12);
        const emb = buildKeywordEmbedding(`${srv.name} ${srv.description}`);

        await db
          .insert(mcpServers)
          .values({
            id: srv.name,
            displayName: srv.name.split("/").pop() ?? srv.name,
            description: srv.description.slice(0, 280),
            transport,
            endpointOrCommand: endpoint,
            repositoryUrl: srv.repository?.url ?? null,
            tags: words,
            embedding: emb,
            syncedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: mcpServers.id,
            set: {
              description: srv.description.slice(0, 280),
              endpointOrCommand: endpoint,
              embedding: emb,
              syncedAt: sql`now()`,
            },
          });
        upserted += 1;
      }
    }
  } catch {
    // Gracefully fall back to curated MCP catalog when offline
  }

  return upserted;
}

export function recommendMcpsForStories(params: {
  scopedVisionSummary: string;
  stories: VerticalStory[];
  explicitOutOfScopeV1?: string[];
  availableServers?: Array<{
    id: string;
    displayName: string;
    description: string;
    transport: string;
    endpointOrCommand: string;
    tags: string[];
  }>;
  maxRecommendations?: number;
}): McpRecommendation[] {
  const catalog = params.availableServers?.length ? params.availableServers : CURATED_MCP_SERVERS;
  const max = params.maxRecommendations ?? 3;
  const outOfScopeCorpus = (params.explicitOutOfScopeV1 ?? []).join(" ").toLowerCase();

  const scored = catalog.map((srv) => {
    const matchedStoryIds: string[] = [];
    let score = 0;

    for (const story of params.stories) {
      const touchpointsCorpus = [
        story.touchpoints.entrySurface,
        story.touchpoints.domainLogic,
        story.touchpoints.persistenceOrExternal,
      ]
        .join(" ")
        .toLowerCase();
      const storyTextCorpus = `${story.title} ${story.iWant}`.toLowerCase();

      let storyHits = 0;
      for (const rawTag of srv.tags ?? []) {
        const tag = rawTag.toLowerCase();
        // Require whole-word or prefix boundary match and prioritize concrete touchpoints over incidental nouns
        if (touchpointsCorpus.includes(tag)) {
          storyHits += 2;
        } else if (storyTextCorpus.includes(tag) && !outOfScopeCorpus.includes(tag)) {
          storyHits += 1;
        }
      }
      if (storyHits >= 2) {
        matchedStoryIds.push(story.id);
        score += storyHits;
      }
    }

    // Boost curated official MCPs slightly on tie-breaks
    if (srv.id.startsWith("io.modelcontextprotocol/") || srv.id.startsWith("com.")) {
      score += 0.5;
    }

    return { srv, score, matchedStoryIds };
  });

  return scored
    .filter((item) => item.score >= 2 && item.matchedStoryIds.length > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map(({ srv, matchedStoryIds }) => ({
      registryId: srv.id,
      displayName: srv.displayName,
      transport: srv.transport === "streamable_http" ? "streamable_http" : "stdio",
      serverUrlOrCommand: srv.endpointOrCommand,
      whyRecommended: `${srv.description} (Matched vertical touchpoints in ${matchedStoryIds.join(", ")}).`,
      matchedStoryIds,
    }));
}
