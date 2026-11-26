import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createInterface } from "node:readline";
import {
  BUILTIN_DIALECT_PROFILES,
  computeDeterministicSpecDelta,
  exportSpecBundleFiles,
  lockStage1Assumptions,
  MCP_PROTOCOL_VERSION,
  type SocraticTriage,
  SocraticTriageSchema,
  SPECPRISM_CORE_VERSION,
  type SpecIterationDocument,
  SpecIterationDocumentSchema,
  type StatelessMcpRequestState,
  StatelessMcpRequestStateSchema,
  verifySpecTraceability,
} from "@specprism/core";
import { z } from "zod";

const DEFAULT_SIGNING_SECRET = "specprism-stateless-mcp-default-hmac-secret-32b";

const McpStatelessEnvelopeSchema = z.object({
  jsonrpc: z.literal("2.0").default("2.0"),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string(),
  params: z
    .object({
      _meta: z
        .object({
          protocolVersion: z.string().default(MCP_PROTOCOL_VERSION),
          clientId: z.string().optional(),
          capabilities: z.record(z.unknown()).optional(),
        })
        .optional(),
      requestState: z.unknown().optional(),
    })
    .passthrough()
    .optional(),
});

export interface StatelessMcpServerOptions {
  signingSecret?: string;
  actorUserId?: string | null;
  runTriageLlm?: (rawPrompt: string) => Promise<SocraticTriage>;
  persistTriageSpec?: (doc: SpecIterationDocument) => Promise<{ projectId: string; url?: string }>;
  listUserSpecs?: () => Promise<Array<{ id: string; title: string; stage: string }>>;
  loadSpecById?: (projectId: string) => Promise<SpecIterationDocument | null>;
  skillMarkdown?: string;
}

function canonicalStatePayload(state: Omit<StatelessMcpRequestState, "signature">): string {
  return [
    state.protocolVersion,
    state.projectId,
    state.iterationNumber,
    state.pendingStage,
    state.elicitationRound,
    state.draftTriageHash,
    state.expiresAtEpochMs,
  ].join("|");
}

export function signMcpRequestState(
  unsigned: Omit<StatelessMcpRequestState, "signature">,
  secret: string
): StatelessMcpRequestState {
  const sig = createHmac("sha256", secret)
    .update(canonicalStatePayload(unsigned), "utf8")
    .digest("base64url");
  return StatelessMcpRequestStateSchema.parse({ ...unsigned, signature: sig });
}

export function verifyMcpRequestState(
  candidate: unknown,
  secret: string,
  nowEpochMs = Date.now()
): StatelessMcpRequestState {
  const parsed = StatelessMcpRequestStateSchema.parse(candidate);
  if (parsed.expiresAtEpochMs <= nowEpochMs) {
    throw new Error("Expired MCP requestState handle.");
  }
  const { signature, ...unsigned } = parsed;
  const expected = createHmac("sha256", secret)
    .update(canonicalStatePayload(unsigned), "utf8")
    .digest("base64url");
  const actualBuf = Buffer.from(signature, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  if (actualBuf.length !== expectedBuf.length || !timingSafeEqual(actualBuf, expectedBuf)) {
    throw new Error("Invalid MCP requestState signature.");
  }
  return parsed;
}

function buildDeterministicFallbackTriage(rawPrompt: string): SocraticTriage {
  const trimmed = rawPrompt.trim();
  const titleWords = trimmed
    .replace(/[^a-zA-Z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5)
    .join(" ");

  return SocraticTriageSchema.parse({
    projectTitle: (titleWords || "Verified Software Feature").slice(0, 70),
    rawPrompt: trimmed,
    scopedVisionSummary: `Deliver a deterministic, test-verified v1 implementation for: ${trimmed.slice(0, 220)}`,
    primaryActors: ["Authenticated User", "System API"],
    explicitOutOfScopeV1: [
      "Multi-region active-active replication",
      "Custom enterprise SSO/SAML provisioning",
    ],
    questions: [
      {
        id: "Q-1",
        dimension: "actors_and_roles",
        detectedAmbiguity: "Primary actor authorization model is unstated.",
        question: "Which actor roles can trigger this workflow in v1?",
        options: [
          {
            id: "Q1-A",
            label: "Single authenticated owner role (Recommended)",
            tradeoffNote: "Fastest vertical delivery without RBAC matrix complexity.",
            recommended: true,
          },
          {
            id: "Q1-B",
            label: "Workspace Admin + Read-Only Viewer roles",
            tradeoffNote: "Adds permission middleware checks across every endpoint.",
            recommended: false,
          },
        ],
      },
      {
        id: "Q-2",
        dimension: "failure_and_recovery_states",
        detectedAmbiguity: "Retry and failure handling behavior is unspecified.",
        question: "How should transient downstream or validation failures behave?",
        options: [
          {
            id: "Q2-A",
            label: "Fail fast with structured HTTP 4xx/5xx error + idempotency key (Recommended)",
            tradeoffNote: "Deterministic client behavior and zero duplicate writes.",
            recommended: true,
          },
          {
            id: "Q2-B",
            label: "Queue async background retry with exponential backoff",
            tradeoffNote: "Higher resilience but requires async job state tracking.",
            recommended: false,
          },
        ],
      },
      {
        id: "Q-3",
        dimension: "security_auth_and_rate_limits",
        detectedAmbiguity: "Abuse and rate-limit boundary is unstated.",
        question: "What request rate limit and validation boundary applies in v1?",
        options: [
          {
            id: "Q3-A",
            label: "Strict Zod payload validation + 60 req/min per actor (Recommended)",
            tradeoffNote: "Prevents malformed state and noisy-neighbor spikes.",
            recommended: true,
          },
          {
            id: "Q3-B",
            label: "Internal trusted network only (schema validation without rate cap)",
            tradeoffNote: "Suitable only behind private VPC ingress.",
            recommended: false,
          },
        ],
      },
    ],
    lockedAssumptions: [],
  });
}

const DEFAULT_SKILL_SUMMARY_MD = `# SpecPrism Skill (MCP ext-skills)
1. Scan workspace stack read-only.
2. Deal 3-4 Socratic Scope & Boundary Decision Cards (ASM-*).
3. Decompose end-to-end Vertical User Stories (US-*: Entry + Domain + Persistence).
4. Co-design deterministic Given/When/Then + canonical EARS ('WHEN ... THE SYSTEM SHALL ...') criteria (REQ-*).
5. Verify 100% REQ-to-TC test coverage (0 orphans) and compute Stage 5 Iterative Spec Deltas (DLT-* + Regression Shields).`;

export async function dispatchStatelessMcpRpc(
  rawEnvelope: unknown,
  options: StatelessMcpServerOptions = {}
): Promise<{
  status: number;
  cacheControl: string;
  body: Record<string, unknown>;
}> {
  const parsed = McpStatelessEnvelopeSchema.safeParse(rawEnvelope);
  if (!parsed.success) {
    return {
      status: 400,
      cacheControl: "no-store",
      body: {
        jsonrpc: "2.0",
        error: { code: -32600, message: "Malformed JSON-RPC 2.0 stateless MCP request." },
      },
    };
  }

  const { id, method, params } = parsed.data;
  const secret =
    options.signingSecret || process.env.MCP_STATE_SIGNING_SECRET || DEFAULT_SIGNING_SECRET;

  // 1. Stateless capability discovery (`initialize` + `server/discover`)
  if (method === "initialize" || method === "server/discover") {
    return {
      status: 200,
      cacheControl: "public, max-age=300",
      body: {
        jsonrpc: "2.0",
        id: id ?? null,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          stateless: true,
          serverInfo: {
            name: "specprism-mcp",
            version: SPECPRISM_CORE_VERSION,
          },
          capabilities: {
            tools: {},
            resources: {},
            prompts: {},
            elicitation: { statelessMrtr: true },
            extensions: { "ext-skills": { version: "1.0" } },
          },
          cache: { ttlMs: 300_000, cacheScope: "public" },
        },
      },
    };
  }

  // 2. Tools list
  if (method === "tools/list") {
    return {
      status: 200,
      cacheControl: "public, max-age=300",
      body: {
        jsonrpc: "2.0",
        id: id ?? null,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          cache: { ttlMs: 300_000, cacheScope: "public" },
          tools: [
            {
              name: "specprism_triage_idea",
              description:
                "Run Stage 1 Socratic Scope & Boundary Triage using stateless Multi Round-Trip Request (MRTR) Elicitations and signed requestState handles.",
              inputSchema: {
                type: "object",
                properties: {
                  ideaPrompt: { type: "string", description: "1-3 sentence feature or product idea" },
                  draftTriage: { type: "object", description: "Returned in MRTR round 1" },
                  requestState: { type: "object", description: "HMAC-signed MRTR state handle" },
                  answers: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        questionId: { type: "string" },
                        selectedOptionId: { type: "string" },
                        customUserOverride: { type: "string" },
                      },
                      required: ["questionId"],
                    },
                  },
                },
                required: ["ideaPrompt"],
              },
            },
            {
              name: "specprism_verify_traceability",
              description:
                "Audit a SpecPrism spec.json document (or synced projectId) for vertical story touchpoints, canonical EARS SHALL clauses, and 0 orphan REQ-to-TC coverage.",
              inputSchema: {
                type: "object",
                properties: {
                  spec: { type: "object", description: "SpecIterationDocument JSON" },
                  projectId: { type: "string", description: "Optional cloud project UUID" },
                },
              },
            },
            {
              name: "specprism_compute_delta",
              description:
                "Compute Stage 5 ADDED/MODIFIED/REMOVED requirement deltas (DLT-*) and classify TC-* tests as regression_shield, requires_update, new_test_required, or obsolete.",
              inputSchema: {
                type: "object",
                properties: {
                  baseSpec: { type: "object" },
                  targetSpec: { type: "object" },
                  changePrompt: { type: "string" },
                },
                required: ["baseSpec", "targetSpec"],
              },
            },
          ],
        },
      },
    };
  }

  // 3. Tools call
  if (method === "tools/call") {
    const toolName = String((params as Record<string, unknown> | undefined)?.name ?? "");
    const toolArgs = ((params as Record<string, unknown> | undefined)?.arguments ?? {}) as Record<
      string,
      unknown
    >;

    if (toolName === "specprism_triage_idea") {
      const ideaPrompt = String(toolArgs.ideaPrompt ?? "").trim();
      if (ideaPrompt.length < 5) {
        return {
          status: 400,
          cacheControl: "no-store",
          body: {
            jsonrpc: "2.0",
            id: id ?? null,
            error: { code: -32602, message: "ideaPrompt must be at least 5 characters." },
          },
        };
      }

      const candidateState = toolArgs.requestState ?? params?.requestState;
      const candidateAnswers = Array.isArray(toolArgs.answers) ? toolArgs.answers : null;

      // MRTR Round 1: Emit Socratic Elicitation + signed requestState (NEVER cached!)
      if (!candidateState || !candidateAnswers) {
        let draftTriage: SocraticTriage;
        if (options.runTriageLlm) {
          try {
            draftTriage = await options.runTriageLlm(ideaPrompt);
          } catch {
            draftTriage = buildDeterministicFallbackTriage(ideaPrompt);
          }
        } else {
          draftTriage = buildDeterministicFallbackTriage(ideaPrompt);
        }
        const projectId = randomUUID();
        const triageHash =
          "sha256:" +
          createHash("sha256").update(JSON.stringify(draftTriage), "utf8").digest("hex").slice(0, 24);

        const signedState = signMcpRequestState(
          {
            protocolVersion: MCP_PROTOCOL_VERSION,
            projectId,
            iterationNumber: 1,
            pendingStage: "stage_1_triage",
            elicitationRound: 1,
            draftTriageHash: triageHash,
            expiresAtEpochMs: Date.now() + 30 * 60 * 1_000,
          },
          secret
        );

        return {
          status: 200,
          cacheControl: "no-store",
          body: {
            jsonrpc: "2.0",
            id: id ?? null,
            result: {
              protocolVersion: MCP_PROTOCOL_VERSION,
              status: "elicitation_required",
              elicitation: {
                message:
                  "Confirm or override the Socratic Scope & Boundary Decision Cards to lock ASM-* assumptions.",
                questions: draftTriage.questions,
                explicitOutOfScopeV1: draftTriage.explicitOutOfScopeV1,
              },
              draftTriage,
              requestState: signedState,
              content: [
                {
                  type: "text",
                  text: `Generated ${draftTriage.questions.length} Socratic Scope Cards for '${draftTriage.projectTitle}'. Re-invoke specprism_triage_idea with requestState, draftTriage, and answers to lock ASM-* assumptions.`,
                },
              ],
            },
          },
        };
      }

      // MRTR Round 2: Verify HMAC requestState + lock ASM-* assumptions
      try {
        const verified = verifyMcpRequestState(candidateState, secret);
        const parsedDraft = toolArgs.draftTriage
          ? SocraticTriageSchema.parse(toolArgs.draftTriage)
          : buildDeterministicFallbackTriage(ideaPrompt);
        const lockedTriage = lockStage1Assumptions(
          parsedDraft,
          candidateAnswers as Array<{
            questionId: string;
            selectedOptionId?: string;
            customUserOverride?: string;
          }>
        );

        const doc = SpecIterationDocumentSchema.parse({
          projectId: verified.projectId,
          iterationNumber: 1,
          stage: "stage_1_triage",
          triage: lockedTriage,
          features: [],
          criteria: [],
          testCases: [],
          recommendedMcps: [],
          targetDialectId: "anthropic-claude",
          createdAt: new Date().toISOString(),
        });

        const persisted = options.persistTriageSpec
          ? await options.persistTriageSpec(doc)
          : { projectId: verified.projectId };

        return {
          status: 200,
          cacheControl: "no-store",
          body: {
            jsonrpc: "2.0",
            id: id ?? null,
            result: {
              protocolVersion: MCP_PROTOCOL_VERSION,
              status: "triage_locked",
              projectId: persisted.projectId,
              workbenchUrl: persisted.url,
              lockedAssumptions: lockedTriage.lockedAssumptions,
              document: doc,
              content: [
                {
                  type: "text",
                  text: `Locked ${lockedTriage.lockedAssumptions.length} scope assumptions (ASM-*) for project ${persisted.projectId}.`,
                },
              ],
            },
          },
        };
      } catch (err) {
        return {
          status: 400,
          cacheControl: "no-store",
          body: {
            jsonrpc: "2.0",
            id: id ?? null,
            error: {
              code: -32602,
              message: err instanceof Error ? err.message : "Invalid MRTR requestState.",
            },
          },
        };
      }
    }

    if (toolName === "specprism_verify_traceability") {
      let targetSpec: unknown = toolArgs.spec;
      if (!targetSpec && typeof toolArgs.projectId === "string" && options.loadSpecById) {
        targetSpec = await options.loadSpecById(toolArgs.projectId);
      }
      if (!targetSpec) {
        return {
          status: 400,
          cacheControl: "no-store",
          body: {
            jsonrpc: "2.0",
            id: id ?? null,
            error: { code: -32602, message: "Provide either 'spec' JSON or a valid 'projectId'." },
          },
        };
      }

      const audit = verifySpecTraceability(targetSpec);
      return {
        status: 200,
        cacheControl: "no-store",
        body: {
          jsonrpc: "2.0",
          id: id ?? null,
          result: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            audit,
            content: [
              {
                type: "text",
                text: audit.valid
                  ? `OK: Verified ${audit.storyCount} vertical stories and ${audit.reqCount} REQ-* -> ${audit.testCount} TC-* with 0 orphans.`
                  : `FAILED (${audit.issues.length} issue(s)): ${audit.issues.join("; ")}`,
              },
            ],
          },
        },
      };
    }

    if (toolName === "specprism_compute_delta") {
      const baseParsed = SpecIterationDocumentSchema.safeParse(toolArgs.baseSpec);
      const nextParsed = SpecIterationDocumentSchema.safeParse(toolArgs.targetSpec);
      if (!baseParsed.success || !nextParsed.success) {
        return {
          status: 400,
          cacheControl: "no-store",
          body: {
            jsonrpc: "2.0",
            id: id ?? null,
            error: {
              code: -32602,
              message: "Both baseSpec and targetSpec must be valid SpecIterationDocument objects.",
            },
          },
        };
      }

      const delta = computeDeterministicSpecDelta(
        baseParsed.data,
        nextParsed.data,
        String(toolArgs.changePrompt ?? "Iterative specification update")
      );
      const shieldCount = delta.testImpacts.filter((t) => t.status === "regression_shield").length;

      return {
        status: 200,
        cacheControl: "no-store",
        body: {
          jsonrpc: "2.0",
          id: id ?? null,
          result: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            delta,
            content: [
              {
                type: "text",
                text: `Computed ${delta.requirementDeltas.length} requirement delta(s) across ${delta.impactedStoryIds.length} story(ies) with ${shieldCount} Regression Shield(s).`,
              },
            ],
          },
        },
      };
    }

    return {
      status: 404,
      cacheControl: "no-store",
      body: {
        jsonrpc: "2.0",
        id: id ?? null,
        error: { code: -32601, message: `Unknown MCP tool '${toolName}'.` },
      },
    };
  }

  // 4. Resources list & read
  if (method === "resources/list") {
    const userSpecs = options.listUserSpecs ? await options.listUserSpecs() : [];
    const scope = userSpecs.length > 0 ? "private" : "public";
    return {
      status: 200,
      cacheControl: scope === "public" ? "public, max-age=300" : "private, max-age=60",
      body: {
        jsonrpc: "2.0",
        id: id ?? null,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          cache: { ttlMs: scope === "public" ? 300_000 : 60_000, cacheScope: scope },
          resources: [
            {
              uri: "specprism://dialects",
              name: "SpecPrism Frontier Model Dialect Rulebooks",
              mimeType: "application/json",
            },
            ...userSpecs.flatMap((sp) => [
              {
                uri: `specprism://specs/${sp.id}/spec.json`,
                name: `${sp.title} (spec.json · ${sp.stage})`,
                mimeType: "application/json",
              },
              {
                uri: `specprism://specs/${sp.id}/traceability`,
                name: `${sp.title} (TRACEABILITY.md)`,
                mimeType: "text/markdown",
              },
            ]),
          ],
        },
      },
    };
  }

  if (method === "resources/read") {
    const uri = String((params as Record<string, unknown> | undefined)?.uri ?? "");
    if (uri === "specprism://dialects") {
      return {
        status: 200,
        cacheControl: "public, max-age=300",
        body: {
          jsonrpc: "2.0",
          id: id ?? null,
          result: {
            cache: { ttlMs: 300_000, cacheScope: "public" },
            contents: [
              {
                uri,
                mimeType: "application/json",
                text: JSON.stringify(BUILTIN_DIALECT_PROFILES, null, 2),
              },
            ],
          },
        },
      };
    }

    const specMatch = /^specprism:\/\/specs\/([0-9a-fA-F-]+)\/(spec\.json|traceability)$/.exec(uri);
    if (specMatch && options.loadSpecById) {
      const [, projId, kind] = specMatch;
      const doc = await options.loadSpecById(projId!);
      if (!doc) {
        return {
          status: 404,
          cacheControl: "no-store",
          body: {
            jsonrpc: "2.0",
            id: id ?? null,
            error: { code: -32002, message: "Specification resource not found or unauthorized." },
          },
        };
      }
      if (kind === "spec.json") {
        return {
          status: 200,
          cacheControl: "private, max-age=60",
          body: {
            jsonrpc: "2.0",
            id: id ?? null,
            result: {
              cache: { ttlMs: 60_000, cacheScope: "private" },
              contents: [{ uri, mimeType: "application/json", text: JSON.stringify(doc, null, 2) }],
            },
          },
        };
      }
      const dialect =
        BUILTIN_DIALECT_PROFILES.find((d) => d.id === doc.targetDialectId) ??
        BUILTIN_DIALECT_PROFILES[0]!;
      const files = exportSpecBundleFiles(doc, dialect);
      const traceMd =
        files.find((f) => f.path.endsWith("TRACEABILITY.md"))?.content ?? "# Traceability Matrix\n";
      return {
        status: 200,
        cacheControl: "private, max-age=60",
        body: {
          jsonrpc: "2.0",
          id: id ?? null,
          result: {
            cache: { ttlMs: 60_000, cacheScope: "private" },
            contents: [{ uri, mimeType: "text/markdown", text: traceMd }],
          },
        },
      };
    }

    return {
      status: 404,
      cacheControl: "no-store",
      body: {
        jsonrpc: "2.0",
        id: id ?? null,
        error: { code: -32002, message: `Unknown resource URI '${uri}'.` },
      },
    };
  }

  // 5. Prompts list & get
  if (method === "prompts/list") {
    return {
      status: 200,
      cacheControl: "public, max-age=300",
      body: {
        jsonrpc: "2.0",
        id: id ?? null,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          cache: { ttlMs: 300_000, cacheScope: "public" },
          prompts: [
            {
              name: "socratic-scope-coach",
              description: "Run SpecPrism pre-code Socratic triage before writing implementation code.",
              arguments: [{ name: "idea", description: "Raw feature or product idea", required: true }],
            },
            {
              name: "dialect-handoff-compiler",
              description: "Format a verified spec for Claude XML, GPT Markdown, Gemini, DeepSeek, Qwen, or Ollama.",
              arguments: [{ name: "dialect", description: "Target dialect ID", required: false }],
            },
          ],
        },
      },
    };
  }

  if (method === "prompts/get") {
    const promptName = String((params as Record<string, unknown> | undefined)?.name ?? "");
    const promptArgs = ((params as Record<string, unknown> | undefined)?.arguments ?? {}) as Record<
      string,
      string
    >;
    return {
      status: 200,
      cacheControl: "public, max-age=300",
      body: {
        jsonrpc: "2.0",
        id: id ?? null,
        result: {
          description: `SpecPrism ${promptName}`,
          messages: [
            {
              role: "user",
              content: {
                type: "text",
                text:
                  promptName === "socratic-scope-coach"
                    ? `Act as SpecPrism Co-Architect. Deal 3-4 Socratic Decision Cards across actors, v1 non-goals, failure states, and rate limits before writing code for: ${promptArgs.idea ?? "(specify idea)"}`
                    : `Compile the verified SpecPrism specification using the '${promptArgs.dialect ?? "anthropic-claude"}' dialect profile and enforce Red -> Green -> Refactor TDD.`,
              },
            },
          ],
        },
      },
    };
  }

  // 6. Skills-over-MCP (`ext-skills`: `skills/list` & `skills/read`)
  if (method === "skills/list") {
    return {
      status: 200,
      cacheControl: "public, max-age=300",
      body: {
        jsonrpc: "2.0",
        id: id ?? null,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          cache: { ttlMs: 300_000, cacheScope: "public" },
          skills: [
            {
              name: "specprism",
              version: SPECPRISM_CORE_VERSION,
              description:
                "Pre-code Socratic specification & QA co-architect enforcing vertical stories, EARS acceptance criteria, 0-orphan REQ-to-TC traceability, and Stage 5 Regression Shields.",
            },
          ],
        },
      },
    };
  }

  if (method === "skills/read") {
    return {
      status: 200,
      cacheControl: "public, max-age=300",
      body: {
        jsonrpc: "2.0",
        id: id ?? null,
        result: {
          name: "specprism",
          version: SPECPRISM_CORE_VERSION,
          markdown: options.skillMarkdown ?? DEFAULT_SKILL_SUMMARY_MD,
        },
      },
    };
  }

  return {
    status: 404,
    cacheControl: "no-store",
    body: {
      jsonrpc: "2.0",
      id: id ?? null,
      error: {
        code: -32601,
        message: `Unknown stateless MCP 2026-07-28 method '${method}'.`,
      },
    },
  };
}

export async function handleStatelessMcpRequest(
  req: Request,
  options: StatelessMcpServerOptions = {}
): Promise<Response> {
  if (req.headers.has("Mcp-Session-Id")) {
    return Response.json(
      {
        jsonrpc: "2.0",
        error: {
          code: -32600,
          message:
            "Mcp-Session-Id is retired in MCP 2026-07-28. Send self-describing stateless requests with _meta and explicit requestState handles.",
        },
      },
      { status: 400 }
    );
  }

  if (req.method === "GET") {
    return Response.json(
      {
        name: "specprism-mcp",
        version: SPECPRISM_CORE_VERSION,
        protocolVersion: MCP_PROTOCOL_VERSION,
        stateless: true,
        authenticatedActor: Boolean(options.actorUserId),
        capabilities: ["tools", "resources", "prompts", "elicitation", "ext-skills"],
        auth: {
          cimdSupported: true,
          personalAccessTokenPrefix: "sp_pat_",
          authorizationMetadataUrl: "/.well-known/oauth-protected-resource",
        },
        cache: { ttlMs: 300_000, cacheScope: "public" },
      },
      {
        status: 200,
        headers: {
          "Cache-Control": "public, max-age=300",
          "Mcp-Protocol-Version": MCP_PROTOCOL_VERSION,
        },
      }
    );
  }

  const rawBody = await req.json().catch(() => null);
  const headerMethod = req.headers.get("Mcp-Method");
  if (
    headerMethod &&
    rawBody &&
    typeof rawBody === "object" &&
    "method" in rawBody &&
    (rawBody as { method?: unknown }).method !== headerMethod
  ) {
    return Response.json(
      {
        jsonrpc: "2.0",
        id: (rawBody as { id?: string | number | null }).id ?? null,
        error: { code: -32600, message: "Mcp-Method header does not match JSON-RPC method." },
      },
      { status: 400 }
    );
  }

  const dispatched = await dispatchStatelessMcpRpc(rawBody, options);
  return Response.json(dispatched.body, {
    status: dispatched.status,
    headers: {
      "Mcp-Protocol-Version": MCP_PROTOCOL_VERSION,
      "Cache-Control": dispatched.cacheControl,
    },
  });
}

export function runStdioMcpServer(options: StatelessMcpServerOptions = {}): void {
  const rl = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    void (async () => {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        const out = await dispatchStatelessMcpRpc(parsed, options);
        process.stdout.write(JSON.stringify(out.body) + "\n");
      } catch {
        process.stdout.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "Invalid JSON line on MCP stdio stream." },
          }) + "\n"
        );
      }
    })();
  });
}
