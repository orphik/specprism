import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { and, desc, eq, gte, isNull, lt } from "drizzle-orm";
import { ingestUatReport, type UatVerificationRun } from "@specprism/core";
import type { AnySpecPrismDrizzleDb } from "./bootstrap.js";
import {
  analyticsEvents,
  personalAccessTokens,
  specIterations,
  specProjects,
  specUatRuns,
} from "./schema/index.js";

export const ANONYMOUS_SANDBOX_MAX_RUNS_24H = 3;
export const ANONYMOUS_DRAFT_TTL_MS = 24 * 60 * 60 * 1_000;

export function signAnonymousDraftClaimToken(
  params: { projectId: string; expiresAtEpochMs: number },
  secret: string
): string {
  const payload = `${params.projectId}.${params.expiresAtEpochMs}`;
  const sig = createHmac("sha256", secret).update(payload, "utf8").digest("base64url");
  return `${params.expiresAtEpochMs}.${sig}`;
}

export function verifyAnonymousDraftClaimToken(
  token: string | null | undefined,
  expectedProjectId: string,
  secret: string,
  nowEpochMs = Date.now()
): boolean {
  if (!token || !expectedProjectId || !secret) return false;
  const parts = token.trim().split(".");
  if (parts.length !== 2) return false;
  const expiresAtEpochMs = Number(parts[0]);
  const providedSig = parts[1] ?? "";
  if (!Number.isFinite(expiresAtEpochMs) || expiresAtEpochMs <= nowEpochMs || !providedSig) {
    return false;
  }

  const expectedSig = createHmac("sha256", secret)
    .update(`${expectedProjectId}.${expiresAtEpochMs}`, "utf8")
    .digest("base64url");

  const actualBuf = Buffer.from(providedSig, "utf8");
  const expectedBuf = Buffer.from(expectedSig, "utf8");
  if (actualBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(actualBuf, expectedBuf);
}

export async function checkAnonymousSandboxAllowance(
  db: AnySpecPrismDrizzleDb,
  visitorHash: string,
  now = new Date()
): Promise<{
  allowed: boolean;
  used: number;
  remaining: number;
  limit: number;
}> {
  const cutoff = new Date(now.getTime() - ANONYMOUS_DRAFT_TTL_MS);
  const rows = await db
    .select({ id: analyticsEvents.id })
    .from(analyticsEvents)
    .where(
      and(
        eq(analyticsEvents.eventType, "stage_run"),
        eq(analyticsEvents.visitorHash, visitorHash),
        isNull(analyticsEvents.userId),
        gte(analyticsEvents.createdAt, cutoff)
      )
    );

  const used = rows.length;
  const remaining = Math.max(0, ANONYMOUS_SANDBOX_MAX_RUNS_24H - used);
  return {
    allowed: used < ANONYMOUS_SANDBOX_MAX_RUNS_24H,
    used,
    remaining,
    limit: ANONYMOUS_SANDBOX_MAX_RUNS_24H,
  };
}

export async function purgeExpiredUnclaimedDrafts(
  db: AnySpecPrismDrizzleDb,
  now = new Date()
): Promise<number> {
  const cutoff = new Date(now.getTime() - ANONYMOUS_DRAFT_TTL_MS);
  const deleted = await db
    .delete(specProjects)
    .where(and(isNull(specProjects.ownerId), lt(specProjects.createdAt, cutoff)))
    .returning({ id: specProjects.id });
  return deleted.length;
}

export async function claimAnonymousSandboxProject(
  db: AnySpecPrismDrizzleDb,
  params: {
    projectId: string;
    claimToken: string | null | undefined;
    claimantUserId: string;
    signingSecret: string;
    nowEpochMs?: number;
  }
): Promise<{
  claimed: boolean;
  idempotent?: boolean;
  reason?: "invalid_token" | "already_claimed_or_missing";
}> {
  const valid = verifyAnonymousDraftClaimToken(
    params.claimToken,
    params.projectId,
    params.signingSecret,
    params.nowEpochMs
  );
  if (!valid) {
    return { claimed: false, reason: "invalid_token" };
  }

  // Atomic single-use bind (`WHERE id = $1 AND owner_id IS NULL`)
  const updated = await db
    .update(specProjects)
    .set({
      ownerId: params.claimantUserId,
      updatedAt: new Date(),
    })
    .where(and(eq(specProjects.id, params.projectId), isNull(specProjects.ownerId)))
    .returning({ id: specProjects.id });

  if (updated.length > 0) {
    return { claimed: true, idempotent: false };
  }

  // Allow safe idempotent re-check if the exact same user already claimed it
  const [existing] = await db
    .select({ ownerId: specProjects.ownerId })
    .from(specProjects)
    .where(eq(specProjects.id, params.projectId))
    .limit(1);

  if (existing && existing.ownerId === params.claimantUserId) {
    return { claimed: true, idempotent: true };
  }

  return { claimed: false, reason: "already_claimed_or_missing" };
}

export async function syncRemoteUatRunForOwnerPat(
  db: AnySpecPrismDrizzleDb,
  params: {
    rawBearerToken: string | null | undefined;
    projectId: string;
    reportPayload: unknown;
    commitSha?: string | null;
    ciRunUrl?: string | null;
  }
): Promise<{
  ok: boolean;
  status: number;
  error?: string;
  uatRun?: UatVerificationRun;
}> {
  const cleanedToken = (params.rawBearerToken ?? "")
    .replace(/^bearer\s+/i, "")
    .trim();

  if (!cleanedToken.startsWith("sp_pat_")) {
    return {
      ok: false,
      status: 401,
      error: "Missing or invalid Personal Access Token (sp_pat_*).",
    };
  }

  const tokenHash = createHash("sha256").update(cleanedToken, "utf8").digest("hex");
  const [pat] = await db
    .select()
    .from(personalAccessTokens)
    .where(eq(personalAccessTokens.tokenHash, tokenHash))
    .limit(1);

  if (!pat || (pat.expiresAt && pat.expiresAt.getTime() <= Date.now())) {
    return {
      ok: false,
      status: 401,
      error: "Invalid, expired, or revoked Personal Access Token (sp_pat_*).",
    };
  }

  await db
    .update(personalAccessTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(personalAccessTokens.id, pat.id));

  const [proj] = await db
    .select()
    .from(specProjects)
    .where(and(eq(specProjects.id, params.projectId), eq(specProjects.ownerId, pat.userId)))
    .limit(1);

  if (!proj) {
    return {
      ok: false,
      status: 404,
      error: "Project not found for this Personal Access Token.",
    };
  }

  const [latestIter] = await db
    .select()
    .from(specIterations)
    .where(eq(specIterations.projectId, proj.id))
    .orderBy(desc(specIterations.iterationNumber))
    .limit(1);

  if (!latestIter || latestIter.document.testCases.length === 0) {
    return {
      ok: false,
      status: 400,
      error: "Project must reach Stage 4 Test Blueprint before syncing UAT results.",
    };
  }

  try {
    const scored = ingestUatReport(latestIter.document, params.reportPayload);
    const metaSuffix = [
      params.commitSha?.trim() ? `commit \`${params.commitSha.trim().slice(0, 12)}\`` : "",
      params.ciRunUrl?.trim() ? `[CI Run](${params.ciRunUrl.trim()})` : "",
    ]
      .filter(Boolean)
      .join(" · ");

    const enrichedRun: UatVerificationRun = metaSuffix
      ? {
          ...scored,
          summaryMarkdown: `${scored.summaryMarkdown}\n> Synced from CI: ${metaSuffix}\n`,
        }
      : scored;

    await db.insert(specUatRuns).values({
      projectId: proj.id,
      iterationNumber: enrichedRun.iterationNumber,
      runnerFormat: enrichedRun.runnerFormat,
      overallPassRatePct: enrichedRun.overallPassRatePct,
      releaseReady: enrichedRun.releaseReady,
      report: enrichedRun,
    });

    return {
      ok: true,
      status: 200,
      uatRun: enrichedRun,
    };
  } catch (err) {
    return {
      ok: false,
      status: 400,
      error: err instanceof Error ? err.message : "Unable to parse UAT test report.",
    };
  }
}
