import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertVerticalStorySlices,
  compileAgentHandoffPrompt,
  exportSpecBundleFiles,
  type LlmProviderClient,
  loadDialectProfiles,
  lockStage1Assumptions,
  runStage1SocraticTriage,
  runStage2VerticalStories,
  runStage3CriteriaCoDesign,
  runStage4TestBlueprint,
  selectDialectForModel,
  SpecIterationDocumentSchema,
} from "../index.js";

describe("@specprism/core Milestone 2 — Stages 1-4 Pipeline & Exporters", () => {
  it("runs Stage 1 triage and locks clickable + custom-edited user assumptions into ASM-*", async () => {
    const mockLlm: LlmProviderClient = {
      modelId: "anthropic/claude-sonnet-4-5",
      async generateStructured({ schema }) {
        return schema.parse({
          rawPrompt: "Build an invoice reminder micro-SaaS for freelancers.",
          scopedVisionSummary:
            "Automated overdue invoice reminder scheduler with client opt-out links and audit logs.",
          primaryActors: ["Freelancer", "Invoice Recipient"],
          explicitOutOfScopeV1: ["Multi-currency tax filing", "Embedded ACH payment processing"],
          questions: [
            {
              id: "q-actors",
              dimension: "actors_and_roles",
              detectedAmbiguity: "Team vs solo workspace access",
              question: "Who manages reminder schedules in v1?",
              options: [
                {
                  id: "opt-solo",
                  label: "Single freelancer owner per workspace",
                  tradeoffNote: "Simplest v1 auth boundary",
                  recommended: true,
                },
                {
                  id: "opt-team",
                  label: "Multi-seat agency roles",
                  tradeoffNote: "Adds RBAC complexity",
                  recommended: false,
                },
              ],
            },
            {
              id: "q-failure",
              dimension: "failure_and_recovery_states",
              detectedAmbiguity: "Bounce/delivery failure handling",
              question: "What happens when a reminder email hard-bounces?",
              options: [
                {
                  id: "opt-pause",
                  label: "Pause sequence for that invoice and flag owner",
                  tradeoffNote: "Protects sender reputation",
                  recommended: true,
                },
                {
                  id: "opt-retry",
                  label: "Retry 3 times over 24h",
                  tradeoffNote: "Risks spam complaints on invalid emails",
                  recommended: false,
                },
              ],
            },
            {
              id: "q-limits",
              dimension: "security_auth_and_rate_limits",
              detectedAmbiguity: "Outbound reminder spam prevention",
              question: "What daily send cap applies per workspace?",
              options: [
                {
                  id: "opt-100",
                  label: "100 reminders/day with idempotency key per invoice+cadence",
                  tradeoffNote: "Prevents duplicate blast loops",
                  recommended: true,
                },
                {
                  id: "opt-unlimited",
                  label: "Uncapped sends",
                  tradeoffNote: "High abuse risk",
                  recommended: false,
                },
              ],
            },
          ],
          lockedAssumptions: [],
        });
      },
    };

    const triage = await runStage1SocraticTriage({
      rawPrompt: "Build an invoice reminder micro-SaaS for freelancers.",
      llm: mockLlm,
    });

    const locked = lockStage1Assumptions(triage, [
      { questionId: "q-actors", selectedOptionId: "opt-solo" },
      {
        questionId: "q-failure",
        customUserOverride: "Pause sequence immediately and record bounce reason in audit table.",
      },
      // Leave q-limits unanswered to verify recommended fallback locking
    ]);

    expect(locked.lockedAssumptions).toHaveLength(3);
    expect(locked.lockedAssumptions[0]?.id).toBe("ASM-001");
    expect(locked.lockedAssumptions[0]?.source).toBe("user_confirmed");
    expect(locked.lockedAssumptions[1]?.id).toBe("ASM-002");
    expect(locked.lockedAssumptions[1]?.source).toBe("user_edited");
    expect(locked.lockedAssumptions[1]?.statement).toContain("record bounce reason");
    expect(locked.lockedAssumptions[2]?.id).toBe("ASM-003");
    expect(locked.lockedAssumptions[2]?.source).toBe("defaulted_explicit");
  });

  it("rejects horizontal DB-only or UI-only story slices", () => {
    expect(() =>
      assertVerticalStorySlices([
        {
          id: "US-001",
          featureId: "FEAT-01",
          sliceOrder: 1,
          title: "Create invoice database tables",
          asA: "Developer",
          iWant: "PostgreSQL tables created",
          soThat: "future stories have a schema",
          independentDemoProof: "Run migration script",
          touchpoints: {
            entrySurface: "N/A",
            domainLogic: "None",
            persistenceOrExternal: "PostgreSQL invoices table",
          },
          linkedAssumptionIds: ["ASM-001"],
        },
      ])
    ).toThrow(/Horizontal slice/i);
  });

  it("orchestrates Stages 2-4 end-to-end and exports runnable Gherkin, test skeletons, and XML dialect prompt", async () => {
    let callCount = 0;
    const mockStageLlm: LlmProviderClient = {
      modelId: "anthropic/claude-sonnet-4-5",
      async generateStructured({ schemaName, schema }) {
        callCount += 1;
        if (schemaName === "Stage2VerticalFeatures") {
          return schema.parse({
            features: [
              {
                id: "FEAT-01",
                title: "Overdue Invoice Reminder Scheduling",
                outcomeSummary: "Create an invoice and schedule deterministic overdue follow-ups.",
                stories: [
                  {
                    id: "US-001",
                    featureId: "FEAT-01",
                    sliceOrder: 1,
                    title: "Schedule overdue reminder for unpaid invoice",
                    asA: "Freelancer",
                    iWant: "to create an invoice with a due date and 3-day overdue reminder",
                    soThat: "late clients receive a polite nudge automatically",
                    independentDemoProof:
                      "Submit new invoice form and verify scheduled_reminders row in Postgres",
                    touchpoints: {
                      entrySurface: "Invoice Creation Form & POST /api/invoices",
                      domainLogic: "Due-date offset calculator & idempotency key generator",
                      persistenceOrExternal: "PostgreSQL invoices + scheduled_reminders tables",
                    },
                    linkedAssumptionIds: ["ASM-001", "ASM-003"],
                  },
                ],
              },
            ],
          });
        }
        if (schemaName === "Stage3AcceptanceCriteria") {
          return schema.parse({
            criteria: [
              {
                id: "REQ-001",
                storyId: "US-001",
                category: "happy_path",
                title: "Enqueues 3-day overdue reminder on invoice creation",
                gwt: {
                  given: ["Authenticated freelancer submits an unpaid invoice due in 7 days"],
                  when: "POST /api/invoices succeeds",
                  then: ["Invoice and a pending reminder at due_date + 3d are persisted atomically"],
                },
                ears: {
                  pattern: "event_driven",
                  systemName: "Reminder Scheduler",
                  triggerOrCondition: "a freelancer creates an unpaid invoice",
                  shallResponse:
                    "persist the invoice and enqueue a pending reminder scheduled 72 hours after due_date",
                  rendered:
                    "WHEN a freelancer creates an unpaid invoice, THE Reminder Scheduler SHALL persist the invoice and enqueue a pending reminder scheduled 72 hours after due_date.",
                },
                coaching: {
                  whyItMatters: "Atomic persistence prevents silent lost reminders.",
                  failureModePrevented: "Invoice saved without a matching reminder job.",
                },
              },
              {
                id: "REQ-002",
                storyId: "US-001",
                category: "non_functional_guardrail",
                title: "Idempotent reminder dispatch per invoice cadence",
                gwt: {
                  given: ["Reminder job for invoice inv_1 +3d has already been sent"],
                  when: "A duplicate worker tick processes inv_1 +3d",
                  then: ["Zero duplicate emails are dispatched"],
                },
                ears: {
                  pattern: "unwanted_event",
                  systemName: "Reminder Dispatcher",
                  triggerOrCondition: "a reminder with the same invoice_id and cadence_key was already sent",
                  shallResponse: "skip email dispatch and log an idempotent no-op",
                  rendered:
                    "IF a reminder with the same invoice_id and cadence_key was already sent, THEN THE Reminder Dispatcher SHALL skip email dispatch and log an idempotent no-op.",
                },
                coaching: {
                  whyItMatters: "Cron retries are at-least-once in cloud environments.",
                  failureModePrevented: "Embarrassing double/triple payment emails sent to clients.",
                },
              },
            ],
          });
        }
        return schema.parse({
          testCases: [
            {
              id: "TC-001",
              title: "Creates invoice and +72h reminder in one transaction",
              tier: "api_contract",
              verifiesReqIds: ["REQ-001"],
              targetFilePath: "tests/api/invoices-schedule.test.ts",
              skeletonCode:
                "import { describe, it, expect } from 'vitest';\ndescribe('POST /api/invoices', () => { it('persists reminder +72h', async () => { expect(true).toBe(true); }); });",
              deterministicAssertions: ["HTTP 201 returned", "scheduled_at === due_date + 72h"],
            },
            {
              id: "TC-002",
              title: "Blocks duplicate dispatch on repeated worker execution",
              tier: "api_contract",
              verifiesReqIds: ["REQ-002"],
              targetFilePath: "tests/api/invoices-schedule.test.ts",
              skeletonCode:
                "import { describe, it, expect } from 'vitest';\ndescribe('dispatchReminder', () => { it('skips duplicate cadence key', async () => { expect(true).toBe(true); }); });",
              deterministicAssertions: ["mailer.send called once across two ticks"],
            },
          ],
        });
      },
    };

    const baseTriage = {
      rawPrompt: "Build an invoice reminder micro-SaaS for freelancers.",
      scopedVisionSummary: "Automated overdue invoice reminder scheduler.",
      primaryActors: ["Freelancer"],
      explicitOutOfScopeV1: ["Tax filing"],
      questions: [
        {
          id: "q1",
          dimension: "actors_and_roles" as const,
          detectedAmbiguity: "Access",
          question: "Who?",
          options: [
            { id: "o1", label: "Solo", tradeoffNote: "Fast", recommended: true },
            { id: "o2", label: "Team", tradeoffNote: "Complex", recommended: false },
          ],
        },
        {
          id: "q2",
          dimension: "failure_and_recovery_states" as const,
          detectedAmbiguity: "Bounce",
          question: "Bounce?",
          options: [
            { id: "o1", label: "Pause", tradeoffNote: "Safe", recommended: true },
            { id: "o2", label: "Retry", tradeoffNote: "Risky", recommended: false },
          ],
        },
        {
          id: "q3",
          dimension: "security_auth_and_rate_limits" as const,
          detectedAmbiguity: "Cap",
          question: "Cap?",
          options: [
            { id: "o1", label: "100/day", tradeoffNote: "Safe", recommended: true },
            { id: "o2", label: "None", tradeoffNote: "Abuse", recommended: false },
          ],
        },
      ],
      lockedAssumptions: [
        {
          id: "ASM-001",
          dimension: "actors_and_roles" as const,
          statement: "Solo freelancer workspace",
          source: "user_confirmed" as const,
        },
        {
          id: "ASM-003",
          dimension: "security_auth_and_rate_limits" as const,
          statement: "Idempotent 100/day cap",
          source: "user_confirmed" as const,
        },
      ],
    };

    const features = await runStage2VerticalStories({ triage: baseTriage, llm: mockStageLlm });
    const criteria = await runStage3CriteriaCoDesign({
      triage: baseTriage,
      features,
      llm: mockStageLlm,
    });
    const testCases = await runStage4TestBlueprint({
      triage: baseTriage,
      features,
      criteria,
      llm: mockStageLlm,
    });

    expect(callCount).toBe(3);

    const doc = SpecIterationDocumentSchema.parse({
      projectId: "550e8400-e29b-41d4-a716-446655440000",
      iterationNumber: 1,
      stage: "stage_4_tests",
      triage: baseTriage,
      features,
      criteria,
      testCases,
      recommendedMcps: [],
      targetDialectId: "anthropic-claude",
      createdAt: "2026-11-26T06:00:00.000Z",
    });

    const dialects = loadDialectProfiles(resolve(process.cwd(), "../../dialects"));
    const selectedDialect = selectDialectForModel("anthropic/claude-sonnet-4-5", dialects);
    expect(selectedDialect.id).toBe("anthropic-claude");

    const compiled = compileAgentHandoffPrompt(doc, selectedDialect);
    expect(compiled.prompt).toContain("<scoped_vision>");
    expect(compiled.prompt).toContain("REQ-001");
    expect(compiled.prompt).toContain("TC-001");
    expect(compiled.prompt.toLowerCase()).not.toContain("think step by step");

    const bundle = exportSpecBundleFiles(doc, selectedDialect);
    const paths = bundle.map((f) => f.path);
    expect(paths).toContain("specprism/spec.json");
    expect(paths).toContain("specprism/TRACEABILITY.md");
    expect(paths).toContain("specprism/AGENT_HANDOFF.md");
    expect(paths).toContain("features/US-001.feature");
    expect(paths).toContain("tests/api/invoices-schedule.test.ts");

    // Verify duplicate targetFilePath entries are merged into a single file containing both TC-001 and TC-002
    const matchingTestFiles = bundle.filter((f) => f.path === "tests/api/invoices-schedule.test.ts");
    expect(matchingTestFiles).toHaveLength(1);
    expect(matchingTestFiles[0]?.content).toContain("[TC-001]");
    expect(matchingTestFiles[0]?.content).toContain("[TC-002]");
  });
});
