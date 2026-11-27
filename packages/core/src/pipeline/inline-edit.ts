import { z } from "zod";
import {
  CriterionCategorySchema,
  type SpecIterationDocument,
  SpecIterationDocumentSchema,
  VerticalTouchpointsSchema,
} from "../schemas/index.js";
import { assertVerticalStorySlices } from "./stage2-vertical-stories.js";
import { detectAntiSlopViolation } from "./loophole-taxonomy.js";
import { type TraceabilityAuditResult, verifySpecTraceability } from "./stage5-iterative-delta.js";

export const InlineSpecEditPayloadSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("assumption"),
    assumptionId: z.string().regex(/^ASM-\d{3,}$/),
    statement: z.string().min(5, "Assumption statement must be at least 5 characters.").max(600),
  }),
  z.object({
    kind: z.literal("story"),
    storyId: z.string().regex(/^US-\d{3,}$/),
    title: z.string().min(3).max(160),
    asA: z.string().min(2).max(120),
    iWant: z.string().min(3).max(400),
    soThat: z.string().min(3).max(400),
    independentDemoProof: z.string().min(3).max(500),
    touchpoints: VerticalTouchpointsSchema,
  }),
  z.object({
    kind: z.literal("criterion"),
    reqId: z.string().regex(/^REQ-\d{3,}$/),
    title: z.string().min(3).max(180),
    category: CriterionCategorySchema,
    earsRendered: z.string().min(10).max(800),
    gwtGiven: z.array(z.string().min(2)).min(1),
    gwtWhen: z.string().min(2).max(400),
    gwtThen: z.array(z.string().min(2)).min(1),
    whyItMatters: z.string().min(3).max(500).optional(),
    failureModePrevented: z.string().min(3).max(400).optional(),
  }),
]);

export type InlineSpecEditPayload = z.infer<typeof InlineSpecEditPayloadSchema>;

export function applyInlineSpecEdit(
  doc: SpecIterationDocument,
  rawEdit: InlineSpecEditPayload
): {
  document: SpecIterationDocument;
  audit: TraceabilityAuditResult;
} {
  const edit = InlineSpecEditPayloadSchema.parse(rawEdit);

  if (edit.kind === "assumption") {
    let found = false;
    const nextAssumptions = doc.triage.lockedAssumptions.map((asm) => {
      if (asm.id !== edit.assumptionId) return asm;
      found = true;
      return {
        ...asm,
        statement: edit.statement.trim(),
        source: "user_edited" as const,
      };
    });
    if (!found) {
      throw new Error(`Locked assumption ${edit.assumptionId} not found.`);
    }
    const nextDoc = SpecIterationDocumentSchema.parse({
      ...doc,
      triage: {
        ...doc.triage,
        lockedAssumptions: nextAssumptions,
      },
    });
    return { document: nextDoc, audit: verifySpecTraceability(nextDoc) };
  }

  if (edit.kind === "story") {
    let found = false;
    const nextFeatures = doc.features.map((feat) => ({
      ...feat,
      stories: feat.stories.map((st) => {
        if (st.id !== edit.storyId) return st;
        found = true;
        return {
          ...st,
          title: edit.title.trim(),
          asA: edit.asA.trim(),
          iWant: edit.iWant.trim(),
          soThat: edit.soThat.trim(),
          independentDemoProof: edit.independentDemoProof.trim(),
          touchpoints: {
            entrySurface: edit.touchpoints.entrySurface.trim(),
            domainLogic: edit.touchpoints.domainLogic.trim(),
            persistenceOrExternal: edit.touchpoints.persistenceOrExternal.trim(),
          },
        };
      }),
    }));
    if (!found) {
      throw new Error(`Vertical story ${edit.storyId} not found.`);
    }
    // Enforce strict vertical slice touchpoints (reject "none", "TBD", "UI only", etc.)
    assertVerticalStorySlices(nextFeatures);

    const nextDoc = SpecIterationDocumentSchema.parse({
      ...doc,
      features: nextFeatures,
    });
    return { document: nextDoc, audit: verifySpecTraceability(nextDoc) };
  }

  // edit.kind === "criterion"
  const trimmedEars = edit.earsRendered.trim();
  if (!/\bSHALL\b/.test(trimmedEars)) {
    throw new Error(
      `Invalid EARS statement on ${edit.reqId}: canonical EARS clauses must include uppercase 'SHALL' (e.g., 'WHEN <trigger>, THE <system> SHALL <response>.').`
    );
  }
  const slopErr = detectAntiSlopViolation(trimmedEars);
  if (slopErr) {
    throw new Error(`${edit.reqId}: ${slopErr}`);
  }

  let found = false;
  const nextCriteria = doc.criteria.map((req) => {
    if (req.id !== edit.reqId) return req;
    found = true;
    return {
      ...req,
      title: edit.title.trim(),
      category: edit.category,
      gwt: {
        given: edit.gwtGiven.map((s) => s.trim()).filter(Boolean),
        when: edit.gwtWhen.trim(),
        then: edit.gwtThen.map((s) => s.trim()).filter(Boolean),
      },
      ears: {
        ...req.ears,
        shallResponse: trimmedEars,
        rendered: trimmedEars,
      },
      coaching: {
        whyItMatters: edit.whyItMatters?.trim() || req.coaching.whyItMatters,
        failureModePrevented:
          edit.failureModePrevented?.trim() || req.coaching.failureModePrevented,
      },
    };
  });

  if (!found) {
    throw new Error(`Acceptance criterion ${edit.reqId} not found.`);
  }

  const nextDoc = SpecIterationDocumentSchema.parse({
    ...doc,
    criteria: nextCriteria,
  });
  return { document: nextDoc, audit: verifySpecTraceability(nextDoc) };
}
