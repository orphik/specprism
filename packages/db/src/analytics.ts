import { and, desc, eq } from "drizzle-orm";
import type { AnySpecPrismDrizzleDb } from "./bootstrap.js";
import {
  accounts,
  aiModels,
  analyticsEvents,
  mcpServers,
  personalAccessTokens,
  radarEvents,
  specIterations,
  specProjects,
  specSignoffs,
  specUatRuns,
  supporterContributions,
  userApiKeys,
  users,
} from "./schema/index.js";

export type AnalyticsEventType =
  | "pageview"
  | "stage_run"
  | "stage_error"
  | "export_zip"
  | "copy_action"
  | "share_toggle"
  | "signoff_submitted"
  | "uat_ingest"
  | "mcp_call";

export interface RecordAnalyticsEventInput {
  eventType: AnalyticsEventType;
  path?: string | null;
  referrerUrl?: string | null;
  referrerDomain?: string | null;
  visitorHash?: string | null;
  userId?: string | null;
  projectId?: string | null;
  stage?: string | null;
  modelId?: string | null;
  dialectId?: string | null;
  billingSource?: "free_tier" | "byok" | "ollama" | string | null;
  durationMs?: number | null;
  statusCode?: number | null;
  metadata?: Record<string, unknown> | null;
}

const INTERNAL_HOSTS = new Set(["spec-prism.app", "www.spec-prism.app", "localhost", "127.0.0.1"]);

export function extractCleanReferrerDomain(rawReferrer?: string | null): string {
  if (!rawReferrer || !rawReferrer.trim()) return "direct";
  try {
    const parsed = new URL(rawReferrer.trim());
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    if (!host || INTERNAL_HOSTS.has(host) || INTERNAL_HOSTS.has(`www.${host}`)) {
      return "direct";
    }
    return host.slice(0, 120);
  } catch {
    return "direct";
  }
}

function sanitizePath(rawPath?: string | null): string | null {
  if (!rawPath || !rawPath.trim()) return null;
  const clean = rawPath.trim().split("?")[0]?.split("#")[0] ?? "/";
  if (!clean.startsWith("/")) return `/${clean.slice(0, 160)}`;
  return clean.slice(0, 160);
}

export async function recordAnalyticsEvent(
  db: AnySpecPrismDrizzleDb,
  input: RecordAnalyticsEventInput
): Promise<void> {
  try {
    const referrerDomain =
      input.referrerDomain?.trim().toLowerCase().slice(0, 120) ||
      extractCleanReferrerDomain(input.referrerUrl);

    await db.insert(analyticsEvents).values({
      eventType: input.eventType,
      path: sanitizePath(input.path),
      referrerDomain,
      visitorHash: input.visitorHash?.trim().slice(0, 64) ?? null,
      userId: input.userId ?? null,
      projectId: input.projectId ?? null,
      stage: input.stage?.slice(0, 48) ?? null,
      modelId: input.modelId?.slice(0, 120) ?? null,
      dialectId: input.dialectId?.slice(0, 80) ?? null,
      billingSource: input.billingSource?.slice(0, 32) ?? null,
      durationMs:
        typeof input.durationMs === "number" && Number.isFinite(input.durationMs)
          ? Math.max(0, Math.round(input.durationMs))
          : null,
      statusCode:
        typeof input.statusCode === "number" && Number.isFinite(input.statusCode)
          ? Math.round(input.statusCode)
          : null,
      metadata: input.metadata ?? null,
    });
  } catch {
    // Telemetry writes are strictly best-effort and never block product flows
  }
}

export async function verifyGoogleOAuthOwner(
  db: AnySpecPrismDrizzleDb,
  params: {
    userId: string | null | undefined;
    sessionEmail: string | null | undefined;
    requiredOwnerEmail: string;
  }
): Promise<boolean> {
  const targetEmail = (params.requiredOwnerEmail ?? "").trim().toLowerCase();
  const sessEmail = (params.sessionEmail ?? "").trim().toLowerCase();
  const userId = params.userId?.trim();

  if (!userId || !targetEmail || !sessEmail || sessEmail !== targetEmail) {
    return false;
  }

  const [userRow] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!userRow) return false;
  if (!userRow.emailVerified) return false;
  if (userRow.email.trim().toLowerCase() !== targetEmail) return false;

  const [googleAccount] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.providerId, "google")))
    .limit(1);

  return Boolean(googleAccount);
}

export interface FunnelStageMetric {
  key: string;
  label: string;
  count: number;
  conversionFromStartPct: number;
  conversionFromPrevPct: number;
}

export interface ImprovementSignal {
  severity: "high" | "opportunity" | "healthy";
  title: string;
  metric: string;
  recommendation: string;
}

export interface PlatformAnalyticsSnapshot {
  windowDays: number;
  generatedAt: string;
  overview: {
    totalUsers: number;
    newUsersInWindow: number;
    googleUsers: number;
    githubUsers: number;
    byokUsers: number;
    mcpTokenUsers: number;
    supportersCount: number;
    supporterRevenueCents: number;
    totalProjects: number;
    projectsInWindow: number;
    unlistedSharedProjects: number;
    totalIterations: number;
    stage4PlusProjects: number;
    completionRatePct: number;
    uniqueVisitorsInWindow: number;
    pageviewsInWindow: number;
    mcpCallsInWindow: number;
    exportsInWindow: number;
    uatRunsTotal: number;
    uatReleaseReadyPct: number;
    avgHappyPathPct: number;
    avgNegativeEdgePct: number;
    avgGuardrailPct: number;
  };
  dailySeries: Array<{
    date: string;
    pageviews: number;
    uniqueVisitors: number;
    newSpecs: number;
    stageRuns: number;
    mcpCalls: number;
    errors: number;
  }>;
  funnel: {
    stages: FunnelStageMetric[];
    biggestDropOff: {
      fromStage: string;
      toStage: string;
      dropPct: number;
    } | null;
  };
  models: Array<{
    modelId: string;
    runs: number;
    freeTierRuns: number;
    byokRuns: number;
    avgDurationMs: number | null;
    errorCount: number;
    errorRatePct: number;
  }>;
  dialects: Array<{
    dialectId: string;
    iterations: number;
    sharePct: number;
  }>;
  traffic: {
    topPages: Array<{ path: string; views: number; uniqueVisitors: number }>;
    topReferrers: Array<{ referrerDomain: string; views: number; uniqueVisitors: number }>;
  };
  featureAdoption: {
    zipExports: number;
    copyAgentPrompt: number;
    copyIssues: number;
    copyRepairPrompt: number;
    shareLinksActive: number;
    stakeholderApprovals: number;
    mcpToolCalls: number;
    uatRuns: number;
  };
  catalogHealth: {
    aiModelsCount: number;
    mcpServersCount: number;
    radarEventsCount: number;
    latestModelSyncAt: string | null;
  };
  improvementSignals: ImprovementSignal[];
  recentEvents: Array<{
    id: string;
    createdAt: string;
    eventType: string;
    path: string | null;
    stage: string | null;
    modelId: string | null;
    dialectId: string | null;
    billingSource: string | null;
    durationMs: number | null;
    statusCode: number | null;
    referrerDomain: string | null;
    detail: string | null;
  }>;
}

const STAGE_RANK: Record<string, number> = {
  stage_1_triage: 1,
  stage_2_stories: 2,
  stage_3_criteria: 3,
  stage_4_tests: 4,
  stage_5_delta: 5,
};

function pct(num: number, den: number): number {
  if (den <= 0) return 0;
  return Math.round((num / den) * 100);
}

export async function computePlatformAnalyticsSnapshot(
  db: AnySpecPrismDrizzleDb,
  options?: { windowDays?: number }
): Promise<PlatformAnalyticsSnapshot> {
  const windowDays = options?.windowDays ?? 30;
  const now = new Date();
  const cutoff = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1_000);

  const [
    userRows,
    accountRows,
    keyRows,
    patRows,
    donationRows,
    projectRows,
    iterationRows,
    signoffRows,
    uatRows,
    eventRows,
    modelCatalogRows,
    mcpCatalogRows,
    radarRows,
  ] = await Promise.all([
    db.select().from(users),
    db.select({ userId: accounts.userId, providerId: accounts.providerId }).from(accounts),
    db.select({ userId: userApiKeys.userId, provider: userApiKeys.provider }).from(userApiKeys),
    db.select({ userId: personalAccessTokens.userId }).from(personalAccessTokens),
    db.select().from(supporterContributions),
    db.select().from(specProjects),
    db.select().from(specIterations),
    db.select().from(specSignoffs),
    db.select().from(specUatRuns),
    db.select().from(analyticsEvents).orderBy(desc(analyticsEvents.createdAt)).limit(5000),
    db.select({ id: aiModels.id, syncedAt: aiModels.syncedAt }).from(aiModels),
    db.select({ id: mcpServers.id }).from(mcpServers),
    db.select({ id: radarEvents.id }).from(radarEvents),
  ]);

  const googleUserSet = new Set(
    accountRows.filter((a) => a.providerId === "google").map((a) => a.userId)
  );
  const githubUserSet = new Set(
    accountRows.filter((a) => a.providerId === "github").map((a) => a.userId)
  );
  const byokUserSet = new Set(keyRows.map((k) => k.userId));
  const mcpUserSet = new Set(patRows.map((p) => p.userId));

  const newUsersInWindow = userRows.filter((u) => u.createdAt >= cutoff).length;
  const projectsInWindow = projectRows.filter((p) => p.createdAt >= cutoff).length;
  const unlistedSharedProjects = projectRows.filter((p) => p.visibility === "unlisted").length;
  const supportersCount = userRows.filter((u) => u.isSupporter).length;
  const supporterRevenueCents = donationRows.reduce((acc, r) => acc + r.amountCents, 0);

  // Per-project max stage rank for accurate 5-stage funnel conversion
  const maxRankByProject = new Map<string, number>();
  const iterCountByProject = new Map<string, number>();
  for (const p of projectRows) {
    maxRankByProject.set(p.id, 1);
    iterCountByProject.set(p.id, 0);
  }
  for (const it of iterationRows) {
    const rank = STAGE_RANK[it.stage] ?? 1;
    const prev = maxRankByProject.get(it.projectId) ?? 1;
    if (rank > prev) maxRankByProject.set(it.projectId, rank);
    iterCountByProject.set(it.projectId, (iterCountByProject.get(it.projectId) ?? 0) + 1);
  }
  const uatProjectSet = new Set(uatRows.map((r) => r.projectId));

  const stage1Count = projectRows.length;
  const stage2Count = [...maxRankByProject.values()].filter((r) => r >= 2).length;
  const stage3Count = [...maxRankByProject.values()].filter((r) => r >= 3).length;
  const stage4Count = [...maxRankByProject.values()].filter((r) => r >= 4).length;
  const stage5Count = projectRows.filter(
    (p) => (maxRankByProject.get(p.id) ?? 1) >= 5 || (iterCountByProject.get(p.id) ?? 0) >= 2
  ).length;
  const uatVerifiedCount = uatProjectSet.size;

  const rawStages = [
    { key: "stage_1_triage", label: "Stage 1 · Scope Triage", count: stage1Count },
    { key: "stage_2_stories", label: "Stage 2 · Vertical Stories", count: stage2Count },
    { key: "stage_3_criteria", label: "Stage 3 · EARS & GWT", count: stage3Count },
    { key: "stage_4_tests", label: "Stage 4 · Test Blueprint", count: stage4Count },
    { key: "stage_5_delta", label: "Stage 5 · Spec Deltas (v2+)", count: stage5Count },
    { key: "post_code_uat", label: "Post-Code UAT Scorecard", count: uatVerifiedCount },
  ];

  const funnelStages: FunnelStageMetric[] = rawStages.map((s, idx) => {
    const prevCount = idx === 0 ? s.count : rawStages[idx - 1]!.count;
    return {
      key: s.key,
      label: s.label,
      count: s.count,
      conversionFromStartPct: idx === 0 ? (s.count > 0 ? 100 : 0) : pct(s.count, stage1Count),
      conversionFromPrevPct: idx === 0 ? (s.count > 0 ? 100 : 0) : pct(s.count, prevCount),
    };
  });

  // Identify biggest core funnel drop-off across Stage 1 -> Stage 4
  let biggestDropOff: PlatformAnalyticsSnapshot["funnel"]["biggestDropOff"] = null;
  for (let i = 1; i <= 3; i++) {
    const prev = funnelStages[i - 1]!;
    const curr = funnelStages[i]!;
    if (prev.count > 0) {
      const dropPct = Math.max(0, 100 - curr.conversionFromPrevPct);
      if (!biggestDropOff || dropPct > biggestDropOff.dropPct) {
        biggestDropOff = {
          fromStage: prev.label,
          toStage: curr.label,
          dropPct,
        };
      }
    }
  }

  // Filter events within window
  const windowEvents = eventRows.filter((e) => e.createdAt >= cutoff);
  const pageviewEvents = windowEvents.filter((e) => e.eventType === "pageview");
  const uniqueVisitorSet = new Set(
    pageviewEvents.map((e) => e.visitorHash).filter((v): v is string => Boolean(v))
  );
  const mcpCallsInWindow = windowEvents.filter((e) => e.eventType === "mcp_call").length;
  const exportsInWindow = windowEvents.filter(
    (e) => e.eventType === "export_zip" || e.eventType === "copy_action"
  ).length;

  // UAT Category averages
  const uatRunsTotal = uatRows.length;
  const uatReleaseReadyCount = uatRows.filter((u) => u.releaseReady).length;
  const catTotals: Record<string, { sum: number; count: number }> = {
    happy_path: { sum: 0, count: 0 },
    negative_edge_case: { sum: 0, count: 0 },
    non_functional_guardrail: { sum: 0, count: 0 },
  };
  for (const row of uatRows) {
    const reportObj = row.report as {
      categoryBreakdown?: Array<{ category?: string; passRatePct?: number }>;
    } | null;
    for (const item of reportObj?.categoryBreakdown ?? []) {
      if (item.category && typeof item.passRatePct === "number" && catTotals[item.category]) {
        catTotals[item.category]!.sum += item.passRatePct;
        catTotals[item.category]!.count += 1;
      }
    }
  }
  const avgHappyPathPct =
    catTotals.happy_path!.count > 0
      ? Math.round(catTotals.happy_path!.sum / catTotals.happy_path!.count)
      : 0;
  const avgNegativeEdgePct =
    catTotals.negative_edge_case!.count > 0
      ? Math.round(catTotals.negative_edge_case!.sum / catTotals.negative_edge_case!.count)
      : 0;
  const avgGuardrailPct =
    catTotals.non_functional_guardrail!.count > 0
      ? Math.round(
          catTotals.non_functional_guardrail!.sum / catTotals.non_functional_guardrail!.count
        )
      : 0;

  // Dialect popularity from specIterations
  const dialectCounts = new Map<string, number>();
  for (const it of iterationRows) {
    const id = it.targetDialectId || "anthropic-claude";
    dialectCounts.set(id, (dialectCounts.get(id) ?? 0) + 1);
  }
  const totalIterations = iterationRows.length;
  const dialects = [...dialectCounts.entries()]
    .map(([dialectId, iterations]) => ({
      dialectId,
      iterations,
      sharePct: pct(iterations, totalIterations),
    }))
    .sort((a, b) => b.iterations - a.iterations);

  // Model popularity, billing source, latency & error rates (combines analyticsEvents + historical specIterations)
  const modelAgg = new Map<
    string,
    {
      runs: number;
      freeTierRuns: number;
      byokRuns: number;
      durationSum: number;
      durationCount: number;
      errorCount: number;
    }
  >();

  const ensureModel = (id: string) => {
    let entry = modelAgg.get(id);
    if (!entry) {
      entry = {
        runs: 0,
        freeTierRuns: 0,
        byokRuns: 0,
        durationSum: 0,
        durationCount: 0,
        errorCount: 0,
      };
      modelAgg.set(id, entry);
    }
    return entry;
  };

  const stageEvents = windowEvents.filter(
    (e) => e.eventType === "stage_run" || e.eventType === "stage_error"
  );
  for (const ev of stageEvents) {
    const id = ev.modelId || "preset:fast_free";
    const entry = ensureModel(id);
    entry.runs += 1;
    if (ev.billingSource === "byok") entry.byokRuns += 1;
    else entry.freeTierRuns += 1;
    if (typeof ev.durationMs === "number") {
      entry.durationSum += ev.durationMs;
      entry.durationCount += 1;
    }
    if (ev.eventType === "stage_error" || (ev.statusCode && ev.statusCode >= 400)) {
      entry.errorCount += 1;
    }
  }

  // Backfill historical model counts from specIterations when telemetry is newer than existing projects
  for (const it of iterationRows) {
    const docObj = it.document as { preferredModelId?: string } | null;
    const histModel = docObj?.preferredModelId || "preset:fast_free";
    if (!modelAgg.has(histModel)) {
      const entry = ensureModel(histModel);
      entry.runs += 1;
      entry.freeTierRuns += 1;
    }
  }

  const models = [...modelAgg.entries()]
    .map(([modelId, m]) => ({
      modelId,
      runs: m.runs,
      freeTierRuns: m.freeTierRuns,
      byokRuns: m.byokRuns,
      avgDurationMs: m.durationCount > 0 ? Math.round(m.durationSum / m.durationCount) : null,
      errorCount: m.errorCount,
      errorRatePct: pct(m.errorCount, m.runs),
    }))
    .sort((a, b) => b.runs - a.runs)
    .slice(0, 12);

  // Traffic top pages & referrers
  const pageMap = new Map<string, { views: number; visitors: Set<string> }>();
  const refMap = new Map<string, { views: number; visitors: Set<string> }>();

  for (const pv of pageviewEvents) {
    const p = pv.path || "/";
    const pEntry = pageMap.get(p) ?? { views: 0, visitors: new Set<string>() };
    pEntry.views += 1;
    if (pv.visitorHash) pEntry.visitors.add(pv.visitorHash);
    pageMap.set(p, pEntry);

    const ref = pv.referrerDomain || "direct";
    const rEntry = refMap.get(ref) ?? { views: 0, visitors: new Set<string>() };
    rEntry.views += 1;
    if (pv.visitorHash) rEntry.visitors.add(pv.visitorHash);
    refMap.set(ref, rEntry);
  }

  const topPages = [...pageMap.entries()]
    .map(([path, v]) => ({ path, views: v.views, uniqueVisitors: v.visitors.size }))
    .sort((a, b) => b.views - a.views)
    .slice(0, 10);

  const topReferrers = [...refMap.entries()]
    .map(([referrerDomain, v]) => ({
      referrerDomain,
      views: v.views,
      uniqueVisitors: v.visitors.size,
    }))
    .sort((a, b) => b.views - a.views)
    .slice(0, 10);

  // Feature adoption counters
  const copyEvents = eventRows.filter((e) => e.eventType === "copy_action");
  const countCopyKind = (kind: string) =>
    copyEvents.filter((e) => (e.metadata as { target?: string } | null)?.target === kind).length;

  const featureAdoption = {
    zipExports: eventRows.filter((e) => e.eventType === "export_zip").length,
    copyAgentPrompt: countCopyKind("agent_prompt"),
    copyIssues: countCopyKind("issues_backlog"),
    copyRepairPrompt: countCopyKind("uat_repair_prompt"),
    shareLinksActive: unlistedSharedProjects,
    stakeholderApprovals: signoffRows.filter((s) => s.status === "approved").length,
    mcpToolCalls: eventRows.filter((e) => e.eventType === "mcp_call").length,
    uatRuns: uatRunsTotal,
  };

  // 14-day daily series (UTC YYYY-MM-DD)
  const dailyMap = new Map<
    string,
    {
      date: string;
      pageviews: number;
      visitors: Set<string>;
      newSpecs: number;
      stageRuns: number;
      mcpCalls: number;
      errors: number;
    }
  >();
  for (let d = 13; d >= 0; d--) {
    const dt = new Date(now.getTime() - d * 24 * 60 * 60 * 1_000);
    const key = dt.toISOString().slice(0, 10);
    dailyMap.set(key, {
      date: key,
      pageviews: 0,
      visitors: new Set<string>(),
      newSpecs: 0,
      stageRuns: 0,
      mcpCalls: 0,
      errors: 0,
    });
  }
  for (const p of projectRows) {
    const key = p.createdAt.toISOString().slice(0, 10);
    const bucket = dailyMap.get(key);
    if (bucket) bucket.newSpecs += 1;
  }
  for (const ev of eventRows) {
    const key = ev.createdAt.toISOString().slice(0, 10);
    const bucket = dailyMap.get(key);
    if (!bucket) continue;
    if (ev.eventType === "pageview") {
      bucket.pageviews += 1;
      if (ev.visitorHash) bucket.visitors.add(ev.visitorHash);
    } else if (ev.eventType === "stage_run") {
      bucket.stageRuns += 1;
    } else if (ev.eventType === "stage_error") {
      bucket.errors += 1;
    } else if (ev.eventType === "mcp_call") {
      bucket.mcpCalls += 1;
    }
  }
  const dailySeries = [...dailyMap.values()].map((b) => ({
    date: b.date,
    pageviews: b.pageviews,
    uniqueVisitors: b.visitors.size,
    newSpecs: b.newSpecs,
    stageRuns: b.stageRuns,
    mcpCalls: b.mcpCalls,
    errors: b.errors,
  }));

  // Catalog freshness
  let latestSyncMs = 0;
  for (const m of modelCatalogRows) {
    if (m.syncedAt.getTime() > latestSyncMs) latestSyncMs = m.syncedAt.getTime();
  }

  // Deterministic Continuous-Improvement Signals
  const improvementSignals: ImprovementSignal[] = [];

  if (biggestDropOff && biggestDropOff.dropPct >= 30) {
    improvementSignals.push({
      severity: biggestDropOff.dropPct >= 50 ? "high" : "opportunity",
      title: `Largest Pipeline Drop-Off: ${biggestDropOff.fromStage} -> ${biggestDropOff.toStage}`,
      metric: `-${biggestDropOff.dropPct}% step drop`,
      recommendation:
        "Review default Socratic option pre-selections and streaming latency on this transition so builders reach Stage 4 zero-orphan test bundles without friction.",
    });
  }

  const flakyModels = models.filter((m) => m.errorCount > 0);
  if (flakyModels.length > 0) {
    const worst = flakyModels[0]!;
    improvementSignals.push({
      severity: worst.errorRatePct >= 25 ? "high" : "opportunity",
      title: `Upstream LLM Errors Detected on ${worst.modelId}`,
      metric: `${worst.errorCount} error(s) (${worst.errorRatePct}%)`,
      recommendation:
        "Inspect HTTP 402/429 upstream responses in the Recent Activity log; promote higher-availability models in Fast Co-Architect presets or encourage universal OpenRouter BYOK failover.",
    });
  }

  if (uatRunsTotal > 0 && avgHappyPathPct - avgNegativeEdgePct >= 15) {
    improvementSignals.push({
      severity: "opportunity",
      title: "Negative Edge Cases Trail Happy-Path UAT Pass Rates",
      metric: `${avgHappyPathPct}% Happy vs ${avgNegativeEdgePct}% Edge Cases`,
      recommendation:
        "Generated code passes happy-path smoke tests faster than negative edge cases. Highlight the 1-Click Engineer Repair Prompt in UAT Scorecards and tighten negative guardrails in top dialects.",
    });
  }

  if (stage4Count > 0 && uatVerifiedCount < Math.ceil(stage4Count * 0.4)) {
    improvementSignals.push({
      severity: "opportunity",
      title: "Close the Post-Code UAT Loop on Completed Specs",
      metric: `${uatVerifiedCount} / ${stage4Count} Stage 4+ specs UAT-verified`,
      recommendation:
        "More specs reach Stage 4 test export than post-code UAT upload. Nudge builders after .zip / Copy Agent Prompt to run `npx specprism verify-run` or drop their Vitest/Playwright JSON back into the UAT Scorecard.",
    });
  }

  if (improvementSignals.length === 0) {
    improvementSignals.push({
      severity: "healthy",
      title: "Pipeline Funnel & Model Reliability Healthy",
      metric: `${pct(stage4Count, Math.max(1, stage1Count))}% Stage 4 completion · 0 model spikes`,
      recommendation:
        "Conversion and upstream model reliability look clean. Monitor Top Referrers after LinkedIn & GitHub posts to double down on channels driving Stage 4 completions.",
    });
  }

  const recentEvents = eventRows.slice(0, 25).map((e) => {
    const meta = (e.metadata ?? {}) as Record<string, unknown>;
    const detail =
      typeof meta.tool === "string"
        ? `tool:${meta.tool}`
        : typeof meta.target === "string"
          ? `copied:${meta.target}`
          : typeof meta.code === "string"
            ? `code:${meta.code}`
            : typeof meta.runnerFormat === "string"
              ? `format:${meta.runnerFormat}`
              : null;
    return {
      id: e.id,
      createdAt: e.createdAt.toISOString(),
      eventType: e.eventType,
      path: e.path,
      stage: e.stage,
      modelId: e.modelId,
      dialectId: e.dialectId,
      billingSource: e.billingSource,
      durationMs: e.durationMs,
      statusCode: e.statusCode,
      referrerDomain: e.referrerDomain,
      detail,
    };
  });

  return {
    windowDays,
    generatedAt: now.toISOString(),
    overview: {
      totalUsers: userRows.length,
      newUsersInWindow,
      googleUsers: googleUserSet.size,
      githubUsers: githubUserSet.size,
      byokUsers: byokUserSet.size,
      mcpTokenUsers: mcpUserSet.size,
      supportersCount,
      supporterRevenueCents,
      totalProjects: projectRows.length,
      projectsInWindow,
      unlistedSharedProjects,
      totalIterations,
      stage4PlusProjects: stage4Count,
      completionRatePct: pct(stage4Count, stage1Count),
      uniqueVisitorsInWindow: uniqueVisitorSet.size,
      pageviewsInWindow: pageviewEvents.length,
      mcpCallsInWindow,
      exportsInWindow,
      uatRunsTotal,
      uatReleaseReadyPct: pct(uatReleaseReadyCount, uatRunsTotal),
      avgHappyPathPct,
      avgNegativeEdgePct,
      avgGuardrailPct,
    },
    dailySeries,
    funnel: {
      stages: funnelStages,
      biggestDropOff,
    },
    models,
    dialects,
    traffic: {
      topPages,
      topReferrers,
    },
    featureAdoption,
    catalogHealth: {
      aiModelsCount: modelCatalogRows.length,
      mcpServersCount: mcpCatalogRows.length,
      radarEventsCount: radarRows.length,
      latestModelSyncAt: latestSyncMs > 0 ? new Date(latestSyncMs).toISOString() : null,
    },
    improvementSignals,
    recentEvents,
  };
}
