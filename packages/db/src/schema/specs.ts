import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { SpecIterationDocument, UatVerificationRun } from "@specprism/core";
import { users } from "./platform.js";

export const specProjects = pgTable("spec_projects", {
  id: uuid("id").defaultRandom().primaryKey(),
  ownerId: text("owner_id").references(() => users.id, { onDelete: "cascade" }),
  slug: text("slug").notNull(),
  title: text("title").notNull(),
  visibility: text("visibility").notNull().default("private"), // "private" | "unlisted" | "public"
  latestIterationNumber: integer("latest_iteration_number").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const specIterations = pgTable(
  "spec_iterations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => specProjects.id, { onDelete: "cascade" }),
    iterationNumber: integer("iteration_number").notNull(),
    stage: text("stage").notNull(),
    rawPrompt: text("raw_prompt").notNull(),
    targetDialectId: text("target_dialect_id").notNull().default("anthropic-claude"),
    document: jsonb("document").$type<SpecIterationDocument>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("spec_iterations_project_iter_idx").on(table.projectId, table.iterationNumber),
  ]
);

export const traceabilityLinks = pgTable("traceability_links", {
  id: uuid("id").defaultRandom().primaryKey(),
  iterationId: uuid("iteration_id")
    .notNull()
    .references(() => specIterations.id, { onDelete: "cascade" }),
  storyId: text("story_id").notNull(),
  reqId: text("req_id").notNull(),
  testCaseId: text("test_case_id").notNull(),
  verificationTier: text("verification_tier").notNull(),
  impactStatus: text("impact_status").notNull().default("regression_shield"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const specSignoffs = pgTable("spec_signoffs", {
  id: uuid("id").defaultRandom().primaryKey(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => specProjects.id, { onDelete: "cascade" }),
  iterationNumber: integer("iteration_number").notNull(),
  reviewerName: text("reviewer_name").notNull(),
  reviewerRole: text("reviewer_role").notNull().default("Stakeholder"),
  status: text("status").notNull().default("approved"), // "approved" | "changes_requested"
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const specUatRuns = pgTable("spec_uat_runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => specProjects.id, { onDelete: "cascade" }),
  iterationNumber: integer("iteration_number").notNull(),
  runnerFormat: text("runner_format").notNull(),
  overallPassRatePct: integer("overall_pass_rate_pct").notNull(),
  releaseReady: boolean("release_ready").notNull().default(false),
  report: jsonb("report").$type<UatVerificationRun>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
