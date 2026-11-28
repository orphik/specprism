import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema/index.js";

export type AnySpecPrismDrizzleDb = PgDatabase<PgQueryResultHKT, typeof schema>;

export async function ensureSpecPrismSchema(db: AnySpecPrismDrizzleDb): Promise<void> {
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector;`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "user" (
      "id" text PRIMARY KEY,
      "name" text NOT NULL,
      "email" text NOT NULL UNIQUE,
      "email_verified" boolean NOT NULL DEFAULT false,
      "image" text,
      "is_supporter" boolean NOT NULL DEFAULT false,
      "supporter_since" timestamptz,
      "radar_opt_in" boolean NOT NULL DEFAULT true,
      "daily_free_runs_used" integer NOT NULL DEFAULT 0,
      "daily_quota_reset_at" timestamptz,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    );
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "session" (
      "id" text PRIMARY KEY,
      "expires_at" timestamptz NOT NULL,
      "token" text NOT NULL UNIQUE,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now(),
      "ip_address" text,
      "user_agent" text,
      "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE
    );
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "account" (
      "id" text PRIMARY KEY,
      "account_id" text NOT NULL,
      "provider_id" text NOT NULL,
      "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
      "access_token" text,
      "refresh_token" text,
      "id_token" text,
      "access_token_expires_at" timestamptz,
      "refresh_token_expires_at" timestamptz,
      "scope" text,
      "password" text,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    );
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "verification" (
      "id" text PRIMARY KEY,
      "identifier" text NOT NULL,
      "value" text NOT NULL,
      "expires_at" timestamptz NOT NULL,
      "created_at" timestamptz DEFAULT now(),
      "updated_at" timestamptz DEFAULT now()
    );
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "user_api_keys" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
      "provider" text NOT NULL,
      "key_hint" text NOT NULL,
      "encrypted_key" text NOT NULL,
      "created_at" timestamptz NOT NULL DEFAULT now()
    );
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "personal_access_tokens" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
      "label" text NOT NULL,
      "token_hash" text NOT NULL UNIQUE,
      "last_used_at" timestamptz,
      "expires_at" timestamptz,
      "created_at" timestamptz NOT NULL DEFAULT now()
    );
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "supporter_contributions" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "user_id" text REFERENCES "user"("id") ON DELETE SET NULL,
      "rail" text NOT NULL,
      "external_reference_id" text NOT NULL UNIQUE,
      "amount_cents" integer NOT NULL,
      "currency" text NOT NULL DEFAULT 'usd',
      "cadence" text NOT NULL,
      "created_at" timestamptz NOT NULL DEFAULT now()
    );
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "spec_projects" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "owner_id" text REFERENCES "user"("id") ON DELETE CASCADE,
      "slug" text NOT NULL,
      "title" text NOT NULL,
      "visibility" text NOT NULL DEFAULT 'private',
      "latest_iteration_number" integer NOT NULL DEFAULT 1,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    );
  `);

  await db.execute(sql`
    ALTER TABLE "spec_projects" ALTER COLUMN "owner_id" DROP NOT NULL;
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "spec_iterations" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "project_id" uuid NOT NULL REFERENCES "spec_projects"("id") ON DELETE CASCADE,
      "iteration_number" integer NOT NULL,
      "stage" text NOT NULL,
      "raw_prompt" text NOT NULL,
      "target_dialect_id" text NOT NULL DEFAULT 'anthropic-claude',
      "document" jsonb NOT NULL,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "spec_iterations_project_iter_idx" UNIQUE ("project_id", "iteration_number")
    );
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "traceability_links" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "iteration_id" uuid NOT NULL REFERENCES "spec_iterations"("id") ON DELETE CASCADE,
      "story_id" text NOT NULL,
      "req_id" text NOT NULL,
      "test_case_id" text NOT NULL,
      "verification_tier" text NOT NULL,
      "impact_status" text NOT NULL DEFAULT 'regression_shield',
      "created_at" timestamptz NOT NULL DEFAULT now()
    );
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "spec_signoffs" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "project_id" uuid NOT NULL REFERENCES "spec_projects"("id") ON DELETE CASCADE,
      "iteration_number" integer NOT NULL,
      "reviewer_name" text NOT NULL,
      "reviewer_role" text NOT NULL DEFAULT 'Stakeholder',
      "status" text NOT NULL DEFAULT 'approved',
      "note" text,
      "created_at" timestamptz NOT NULL DEFAULT now()
    );
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "spec_uat_runs" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "project_id" uuid NOT NULL REFERENCES "spec_projects"("id") ON DELETE CASCADE,
      "iteration_number" integer NOT NULL,
      "runner_format" text NOT NULL,
      "overall_pass_rate_pct" integer NOT NULL,
      "release_ready" boolean NOT NULL DEFAULT false,
      "report" jsonb NOT NULL,
      "created_at" timestamptz NOT NULL DEFAULT now()
    );
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "ai_models" (
      "id" text PRIMARY KEY,
      "provider" text NOT NULL,
      "display_name" text NOT NULL,
      "context_window" integer NOT NULL,
      "max_output_tokens" integer,
      "supports_structured_output" boolean NOT NULL DEFAULT false,
      "supports_tools" boolean NOT NULL DEFAULT false,
      "supports_reasoning" boolean NOT NULL DEFAULT false,
      "input_cost_per_million_usd" numeric(10, 4),
      "output_cost_per_million_usd" numeric(10, 4),
      "source_catalog" text NOT NULL,
      "source_etag" text,
      "raw_metadata" jsonb,
      "synced_at" timestamptz NOT NULL DEFAULT now()
    );
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "mcp_servers" (
      "id" text PRIMARY KEY,
      "display_name" text NOT NULL,
      "description" text NOT NULL,
      "transport" text NOT NULL,
      "endpoint_or_command" text NOT NULL,
      "repository_url" text,
      "tags" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "embedding" vector(384),
      "synced_at" timestamptz NOT NULL DEFAULT now()
    );
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "radar_events" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "source" text NOT NULL,
      "category" text NOT NULL,
      "external_slug" text NOT NULL UNIQUE,
      "title" text NOT NULL,
      "summary" text NOT NULL,
      "source_url" text,
      "suggested_dialect_id" text,
      "draft_pr_url" text,
      "admin_alert_sent_at" timestamptz,
      "digest_included_at" timestamptz,
      "created_at" timestamptz NOT NULL DEFAULT now()
    );
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "analytics_events" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "event_type" text NOT NULL,
      "path" text,
      "referrer_domain" text,
      "visitor_hash" text,
      "user_id" text REFERENCES "user"("id") ON DELETE SET NULL,
      "project_id" uuid REFERENCES "spec_projects"("id") ON DELETE SET NULL,
      "stage" text,
      "model_id" text,
      "dialect_id" text,
      "billing_source" text,
      "duration_ms" integer,
      "status_code" integer,
      "metadata" jsonb,
      "created_at" timestamptz NOT NULL DEFAULT now()
    );
  `);

  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "idx_analytics_events_created_at"
    ON "analytics_events" ("created_at" DESC);
  `);

  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "idx_analytics_events_type_created_at"
    ON "analytics_events" ("event_type", "created_at" DESC);
  `);
}
