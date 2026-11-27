import {
  boolean,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

export const aiModels = pgTable("ai_models", {
  id: text("id").primaryKey(), // e.g., "anthropic/claude-sonnet-4-5"
  provider: text("provider").notNull(),
  displayName: text("display_name").notNull(),
  contextWindow: integer("context_window").notNull(),
  maxOutputTokens: integer("max_output_tokens"),
  supportsStructuredOutput: boolean("supports_structured_output").notNull().default(false),
  supportsTools: boolean("supports_tools").notNull().default(false),
  supportsReasoning: boolean("supports_reasoning").notNull().default(false),
  inputCostPerMillionUsd: numeric("input_cost_per_million_usd", { precision: 10, scale: 4 }),
  outputCostPerMillionUsd: numeric("output_cost_per_million_usd", { precision: 10, scale: 4 }),
  sourceCatalog: text("source_catalog").notNull(), // "openrouter" | "litellm" | "ollama" | "custom"
  sourceEtag: text("source_etag"),
  rawMetadata: jsonb("raw_metadata"),
  syncedAt: timestamp("synced_at", { withTimezone: true }).defaultNow().notNull(),
});

export const mcpServers = pgTable("mcp_servers", {
  id: text("id").primaryKey(), // e.g., "io.modelcontextprotocol/playwright"
  displayName: text("display_name").notNull(),
  description: text("description").notNull(),
  transport: text("transport").notNull(), // "stdio" | "streamable_http"
  endpointOrCommand: text("endpoint_or_command").notNull(),
  repositoryUrl: text("repository_url"),
  tags: jsonb("tags").$type<string[]>().notNull().default([]),
  embedding: vector("embedding", { dimensions: 384 }),
  syncedAt: timestamp("synced_at", { withTimezone: true }).defaultNow().notNull(),
});

export const radarEvents = pgTable("radar_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  source: text("source").notNull(),
  category: text("category").notNull(), // "new_model" | "new_mcp" | "new_skill" | "dialect_shift"
  externalSlug: text("external_slug").notNull().unique(),
  title: text("title").notNull(),
  summary: text("summary").notNull(),
  sourceUrl: text("source_url"),
  suggestedDialectId: text("suggested_dialect_id"),
  draftPrUrl: text("draft_pr_url"),
  adminAlertSentAt: timestamp("admin_alert_sent_at", { withTimezone: true }),
  digestIncludedAt: timestamp("digest_included_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
