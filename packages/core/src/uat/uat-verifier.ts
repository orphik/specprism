import {
  type CategoryReadinessBreakdown,
  type DialectProfile,
  type SpecIterationDocument,
  type TestCaseExecutionResult,
  type TestExecutionStatus,
  type UatRunnerFormat,
  type UatVerificationRun,
  UatVerificationRunSchema,
} from "../schemas/index.js";

export function posixSingleQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

export function pickSafeHeredocMarker(body: string, base = "SPECPRISM_EOF"): string {
  let candidate = base;
  let counter = 1;
  while (body.includes(candidate)) {
    candidate = `${base}_${counter++}`;
  }
  return candidate;
}

interface RawExtractedExecution {
  title: string;
  filePath?: string;
  status: TestExecutionStatus;
  durationMs?: number;
  failureMessage?: string;
}

function normalizePathTail(p?: string): string {
  if (!p) return "";
  return p.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase().trim();
}

function normalizeRunnerStatus(raw: unknown): TestExecutionStatus {
  const s = String(raw ?? "").toLowerCase().trim();
  if (s === "passed" || s === "expected" || s === "ok" || s === "pass") return "passed";
  if (
    s === "failed" ||
    s === "unexpected" ||
    s === "error" ||
    s === "timedout" ||
    s === "fail" ||
    s === "flaky"
  ) {
    return "failed";
  }
  if (s === "skipped" || s === "pending" || s === "todo" || s === "disabled") return "skipped";
  return "not_run";
}

function decodeXmlEntities(str: string): string {
  return str
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function parseJunitXml(xml: string): RawExtractedExecution[] {
  const results: RawExtractedExecution[] = [];
  const tcRegex = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/gi;
  let match: RegExpExecArray | null;

  while ((match = tcRegex.exec(xml)) !== null) {
    const attrs = match[1] ?? "";
    const inner = match[2] ?? "";

    const getAttr = (name: string): string => {
      const m = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(attrs);
      return m ? decodeXmlEntities(m[1]!) : "";
    };

    const name = getAttr("name");
    const classname = getAttr("classname") || getAttr("file");
    const timeSec = Number.parseFloat(getAttr("time") || "0");
    const durationMs = Number.isFinite(timeSec) ? Math.round(timeSec * 1000) : undefined;

    const failMatch = /<(?:failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:failure|error)>)/i.exec(
      inner
    );
    const skipMatch = /<skipped\b/i.test(inner);

    if (failMatch) {
      const msgMatch = /\bmessage\s*=\s*["']([^"']*)["']/i.exec(failMatch[1] ?? "");
      const msgAttr = msgMatch ? decodeXmlEntities(msgMatch[1]!) : "";
      const bodyText = decodeXmlEntities((failMatch[2] ?? "").trim());
      const combined = [msgAttr, bodyText].filter(Boolean).join(" — ").slice(0, 600);
      results.push({
        title: `${classname} ${name}`.trim(),
        filePath: classname,
        status: "failed",
        durationMs,
        failureMessage: combined || "JUnit testcase failed",
      });
    } else if (skipMatch) {
      results.push({
        title: `${classname} ${name}`.trim(),
        filePath: classname,
        status: "skipped",
        durationMs,
      });
    } else {
      results.push({
        title: `${classname} ${name}`.trim(),
        filePath: classname,
        status: "passed",
        durationMs,
      });
    }
  }

  return results;
}

function walkPlaywrightSuites(
  suites: unknown[],
  out: RawExtractedExecution[],
  parentTitle = "",
  parentFile = ""
): void {
  for (const rawSuite of suites) {
    if (!rawSuite || typeof rawSuite !== "object") continue;
    const suite = rawSuite as Record<string, unknown>;
    const suiteTitle = [parentTitle, String(suite.title ?? "")].filter(Boolean).join(" > ");
    const suiteFile = String(suite.file ?? parentFile ?? "");

    if (Array.isArray(suite.specs)) {
      for (const rawSpec of suite.specs) {
        if (!rawSpec || typeof rawSpec !== "object") continue;
        const spec = rawSpec as Record<string, unknown>;
        const specTitle = [suiteTitle, String(spec.title ?? "")].filter(Boolean).join(" > ");
        const specFile = String(spec.file ?? suiteFile ?? "");
        const tests = Array.isArray(spec.tests) ? spec.tests : [];

        if (tests.length === 0) {
          out.push({
            title: specTitle,
            filePath: specFile,
            status: spec.ok === false ? "failed" : "passed",
          });
          continue;
        }

        for (const rawTest of tests) {
          if (!rawTest || typeof rawTest !== "object") continue;
          const t = rawTest as Record<string, unknown>;
          const runResults = Array.isArray(t.results) ? t.results : [];
          const lastRes = (runResults[runResults.length - 1] ?? t) as Record<string, unknown>;
          const rawStatus = lastRes.status ?? t.status ?? (spec.ok === false ? "failed" : "passed");
          const status = normalizeRunnerStatus(rawStatus);
          const errObj = (lastRes.error ??
            (Array.isArray(lastRes.errors) ? lastRes.errors[0] : undefined)) as
            | Record<string, unknown>
            | undefined;
          const errMsg = errObj?.message ? String(errObj.message).slice(0, 600) : undefined;
          const duration =
            typeof lastRes.duration === "number" ? Math.round(lastRes.duration) : undefined;

          out.push({
            title: specTitle,
            filePath: specFile,
            status,
            durationMs: duration,
            failureMessage: status === "failed" ? errMsg ?? "Playwright assertion failed" : undefined,
          });
        }
      }
    }

    if (Array.isArray(suite.suites)) {
      walkPlaywrightSuites(suite.suites, out, suiteTitle, suiteFile);
    }
  }
}

function parseRawReportPayload(rawInput: unknown): {
  format: UatRunnerFormat;
  executions: RawExtractedExecution[];
  explicitResults?: TestCaseExecutionResult[];
} {
  if (typeof rawInput === "string") {
    const trimmed = rawInput.trim();
    if (trimmed.startsWith("<")) {
      return {
        format: "junit_xml",
        executions: parseJunitXml(trimmed),
      };
    }
    const parsedJson = JSON.parse(trimmed.replace(/^\uFEFF/, "")) as unknown;
    return parseRawReportPayload(parsedJson);
  }

  if (!rawInput || typeof rawInput !== "object") {
    throw new Error("Unsupported UAT report input: provide Vitest JSON, Playwright JSON, or JUnit XML.");
  }

  const obj = rawInput as Record<string, unknown>;

  // 1. SpecPrism Native Format (`{ results: [{ testCaseId: "TC-001", status: "passed" }] }`)
  if (Array.isArray(obj.results) && obj.results.some((r: any) => r && typeof r.testCaseId === "string")) {
    const explicitResults: TestCaseExecutionResult[] = obj.results.map((r: any) => ({
      testCaseId: String(r.testCaseId),
      status: normalizeRunnerStatus(r.status),
      durationMs: typeof r.durationMs === "number" ? r.durationMs : undefined,
      failureMessage: r.failureMessage ? String(r.failureMessage).slice(0, 600) : undefined,
      sourceTestTitle: r.sourceTestTitle ? String(r.sourceTestTitle) : undefined,
      sourceFilePath: r.sourceFilePath ? String(r.sourceFilePath) : undefined,
    }));
    return {
      format: obj.simulated === true ? "simulated_sample" : "specprism_native",
      executions: [],
      explicitResults,
    };
  }

  // 2. Vitest / Jest JSON (`{ testResults: [{ name, assertionResults: [...] }] }`)
  if (Array.isArray(obj.testResults)) {
    const executions: RawExtractedExecution[] = [];
    for (const rawSuite of obj.testResults) {
      if (!rawSuite || typeof rawSuite !== "object") continue;
      const suite = rawSuite as Record<string, unknown>;
      const filePath = String(suite.name ?? suite.testFilePath ?? "");
      const assertions = Array.isArray(suite.assertionResults)
        ? suite.assertionResults
        : Array.isArray(suite.testResults)
        ? suite.testResults
        : [];

      if (assertions.length === 0 && suite.status) {
        executions.push({
          title: filePath,
          filePath,
          status: normalizeRunnerStatus(suite.status),
          failureMessage: suite.message ? String(suite.message).slice(0, 600) : undefined,
        });
        continue;
      }

      for (const rawAssert of assertions) {
        if (!rawAssert || typeof rawAssert !== "object") continue;
        const a = rawAssert as Record<string, unknown>;
        const title = String(a.fullName ?? a.title ?? "");
        const status = normalizeRunnerStatus(a.status);
        const failMsgs = Array.isArray(a.failureMessages)
          ? a.failureMessages.map((m) => String(m)).join("\n")
          : a.failureMessage
          ? String(a.failureMessage)
          : "";
        executions.push({
          title,
          filePath,
          status,
          durationMs: typeof a.duration === "number" ? Math.round(a.duration) : undefined,
          failureMessage:
            status === "failed" ? (failMsgs.trim().slice(0, 600) || "Assertion failed") : undefined,
        });
      }
    }
    return { format: "vitest_json", executions };
  }

  // 3. Playwright JSON (`{ suites: [...] }`)
  if (Array.isArray(obj.suites)) {
    const executions: RawExtractedExecution[] = [];
    walkPlaywrightSuites(obj.suites, executions);
    return { format: "playwright_json", executions };
  }

  throw new Error(
    "Unrecognized test report JSON shape. Expected Vitest (`testResults`), Playwright (`suites`), JUnit XML (`<testsuite>`), or SpecPrism (`results`)."
  );
}

const CATEGORY_LABELS: Record<CategoryReadinessBreakdown["category"], string> = {
  happy_path: "Happy Path",
  negative_edge_case: "Negative / Edge Cases",
  non_functional_guardrail: "Security & Perf Guardrails",
};

export function ingestUatReport(
  doc: SpecIterationDocument,
  rawInput: unknown,
  opts?: { runId?: string; executedAt?: string }
): UatVerificationRun {
  const parsedReport = parseRawReportPayload(rawInput);
  const explicitByTcId = new Map(
    (parsedReport.explicitResults ?? []).map((r) => [r.testCaseId.toUpperCase(), r])
  );

  // Map every TC-* in doc.testCases to its execution outcome
  const testResults: TestCaseExecutionResult[] = doc.testCases.map((tc) => {
    const direct = explicitByTcId.get(tc.id.toUpperCase());
    if (direct) return direct;

    const tcIdUpper = tc.id.toUpperCase();
    const expectedTail = normalizePathTail(tc.targetFilePath);

    // Priority 1: Explicit TC-XXX ID match in test title/name
    const byIdHits = parsedReport.executions.filter((ex) =>
      new RegExp(`\\b${tcIdUpper}\\b`, "i").test(ex.title)
    );

    // Priority 2: Target file path suffix match (when file contains a single TC or suite-level match)
    const candidateHits =
      byIdHits.length > 0
        ? byIdHits
        : expectedTail
        ? parsedReport.executions.filter((ex) => {
            const actualTail = normalizePathTail(ex.filePath);
            return actualTail.length > 0 && (actualTail.endsWith(expectedTail) || expectedTail.endsWith(actualTail));
          })
        : [];

    if (candidateHits.length === 0) {
      return {
        testCaseId: tc.id,
        status: "not_run",
      };
    }

    const failedHit = candidateHits.find((h) => h.status === "failed");
    if (failedHit) {
      return {
        testCaseId: tc.id,
        status: "failed",
        durationMs: failedHit.durationMs,
        failureMessage: failedHit.failureMessage ?? "Test execution failed",
        sourceTestTitle: failedHit.title,
        sourceFilePath: failedHit.filePath,
      };
    }

    const passedHit = candidateHits.find((h) => h.status === "passed");
    if (passedHit) {
      return {
        testCaseId: tc.id,
        status: "passed",
        durationMs: passedHit.durationMs,
        sourceTestTitle: passedHit.title,
        sourceFilePath: passedHit.filePath,
      };
    }

    return {
      testCaseId: tc.id,
      status: "skipped",
      sourceTestTitle: candidateHits[0]?.title,
      sourceFilePath: candidateHits[0]?.filePath,
    };
  });

  const resultByTcId = new Map(testResults.map((r) => [r.testCaseId, r]));

  const verifiedReqIds: string[] = [];
  const failingReqIds: string[] = [];
  const unrunReqIds: string[] = [];

  const reqOutcomeById = new Map<string, "verified" | "failed" | "unrun">();
  for (const req of doc.criteria) {
    const verifyingTcs = doc.testCases.filter((tc) => tc.verifiesReqIds.includes(req.id));
    if (verifyingTcs.length === 0) {
      unrunReqIds.push(req.id);
      reqOutcomeById.set(req.id, "unrun");
      continue;
    }

    const statuses = verifyingTcs.map((tc) => resultByTcId.get(tc.id)?.status ?? "not_run");
    if (statuses.some((s) => s === "failed")) {
      failingReqIds.push(req.id);
      reqOutcomeById.set(req.id, "failed");
    } else if (statuses.every((s) => s === "passed")) {
      verifiedReqIds.push(req.id);
      reqOutcomeById.set(req.id, "verified");
    } else {
      unrunReqIds.push(req.id);
      reqOutcomeById.set(req.id, "unrun");
    }
  }

  const categories: Array<CategoryReadinessBreakdown["category"]> = [
    "happy_path",
    "negative_edge_case",
    "non_functional_guardrail",
  ];

  const categoryBreakdown: CategoryReadinessBreakdown[] = categories.map((cat) => {
    const catReqs = doc.criteria.filter((c) => c.category === cat);
    const totalReqs = catReqs.length;
    const verifiedReqs = catReqs.filter((c) => reqOutcomeById.get(c.id) === "verified").length;
    const failedReqs = catReqs.filter((c) => reqOutcomeById.get(c.id) === "failed").length;
    const unrunReqs = catReqs.filter((c) => reqOutcomeById.get(c.id) === "unrun").length;
    const passRatePct = totalReqs === 0 ? 100 : Math.round((verifiedReqs / totalReqs) * 100);
    return {
      category: cat,
      totalReqs,
      verifiedReqs,
      failedReqs,
      unrunReqs,
      passRatePct,
    };
  });

  const totalCriteria = doc.criteria.length;
  const overallPassRatePct =
    totalCriteria === 0 ? 0 : Math.round((verifiedReqIds.length / totalCriteria) * 100);
  const releaseReady =
    totalCriteria > 0 && failingReqIds.length === 0 && unrunReqIds.length === 0;

  const summaryLines: string[] = [
    "<!-- specprism-uat-report -->",
    `### SpecPrism Post-Code UAT Scorecard — ${
      releaseReady ? "✅ 100% Release Ready" : `⚠️ ${overallPassRatePct}% Verified (Iteration Required)`
    }`,
    "",
    `**Project:** ${doc.triage.projectTitle ?? "Specification"} (v${doc.iterationNumber}) · **Format:** \`${parsedReport.format}\` · **Verified Criteria:** \`${verifiedReqIds.length} / ${totalCriteria} REQ-*\``,
    "",
    "| Category | Verified | Failing | Unexecuted | Readiness |",
    "| :--- | :---: | :---: | :---: | :---: |",
    ...categoryBreakdown.map(
      (cb) =>
        `| **${CATEGORY_LABELS[cb.category]}** | ${cb.verifiedReqs}/${cb.totalReqs} | ${cb.failedReqs} | ${cb.unrunReqs} | **${cb.passRatePct}%** |`
    ),
    "",
  ];

  if (failingReqIds.length > 0) {
    summaryLines.push("#### Failing Edge Cases & Acceptance Criteria");
    for (const fid of failingReqIds) {
      const req = doc.criteria.find((c) => c.id === fid);
      const failedTcs = doc.testCases
        .filter((tc) => tc.verifiesReqIds.includes(fid))
        .map((tc) => resultByTcId.get(tc.id))
        .filter((r): r is TestCaseExecutionResult => r?.status === "failed");
      const trace = failedTcs
        .map((ft) => `\`${ft.testCaseId}\`: ${ft.failureMessage ?? "Failed"}`)
        .join("; ");
      summaryLines.push(`- ❌ **\`${fid}\`** (${req?.title ?? fid}) — ${trace}`);
    }
    summaryLines.push("");
  }

  return UatVerificationRunSchema.parse({
    runId: opts?.runId ?? `uat_${Date.now().toString(36)}`,
    iterationNumber: doc.iterationNumber,
    runnerFormat: parsedReport.format,
    executedAt: opts?.executedAt ?? new Date().toISOString(),
    overallPassRatePct,
    releaseReady,
    categoryBreakdown,
    testResults,
    verifiedReqIds,
    failingReqIds,
    unrunReqIds,
    summaryMarkdown: summaryLines.join("\n"),
  });
}

export function buildSimulatedEdgeCaseRun(doc: SpecIterationDocument): UatVerificationRun {
  const edgeCritIds = new Set(
    doc.criteria
      .filter((c) => c.category === "negative_edge_case")
      .slice(0, 2)
      .map((c) => c.id)
  );
  if (edgeCritIds.size === 0 && doc.criteria.length > 0) {
    edgeCritIds.add(doc.criteria[doc.criteria.length - 1]!.id);
  }

  const results = doc.testCases.map((tc, idx) => {
    const hitsEdge = tc.verifiesReqIds.some((rid) => edgeCritIds.has(rid));
    if (hitsEdge) {
      const targetReq = doc.criteria.find((c) => edgeCritIds.has(c.id) && tc.verifiesReqIds.includes(c.id));
      return {
        testCaseId: tc.id,
        status: "failed" as const,
        durationMs: 38 + idx * 7,
        failureMessage: `AssertionError in ${tc.targetFilePath}: Expected negative boundary guardrail for ${
          targetReq?.id ?? tc.id
        } ("${targetReq?.title ?? tc.title}"), received HTTP 200 without edge-case rejection.`,
        sourceTestTitle: `[${tc.id}] ${tc.title}`,
        sourceFilePath: tc.targetFilePath,
      };
    }
    return {
      testCaseId: tc.id,
      status: "passed" as const,
      durationMs: 14 + idx * 5,
      sourceTestTitle: `[${tc.id}] ${tc.title}`,
      sourceFilePath: tc.targetFilePath,
    };
  });

  return ingestUatReport(doc, { simulated: true, results });
}

function stripDialectAvoidPhrases(text: string, avoidPhrases: string[]): string {
  let out = text;
  for (const phrase of avoidPhrases) {
    if (!phrase.trim()) continue;
    const rx = new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    out = out.replace(rx, "");
  }
  return out;
}

export function compileUatRepairPrompt(
  doc: SpecIterationDocument,
  uatRun: UatVerificationRun,
  dialect: DialectProfile
): {
  prompt: string;
  failingReqCount: number;
  shieldCount: number;
} {
  const targetReqSet = new Set([...uatRun.failingReqIds, ...uatRun.unrunReqIds]);
  const targetCriteria = doc.criteria.filter((c) => targetReqSet.has(c.id));
  const resultMap = new Map(uatRun.testResults.map((r) => [r.testCaseId, r]));

  const failingTests = doc.testCases.filter((tc) => {
    const st = resultMap.get(tc.id)?.status;
    return st === "failed" || st === "not_run" || st === "skipped";
  });

  const shieldTests = doc.testCases.filter((tc) => resultMap.get(tc.id)?.status === "passed");

  if (targetCriteria.length === 0) {
    return {
      prompt: `All ${doc.criteria.length} REQ-* acceptance criteria and ${doc.testCases.length} TC-* verification tests are 100% GREEN. No repair iteration required.`,
      failingReqCount: 0,
      shieldCount: shieldTests.length,
    };
  }

  const failingCriteriaBlock = targetCriteria
    .map(
      (c) =>
        `- [${c.id}] (${c.storyId} · ${c.category}) ${c.title}\n  EARS: ${c.ears.rendered}\n  GIVEN ${c.gwt.given.join(" AND ")} | WHEN ${c.gwt.when} | THEN ${c.gwt.then.join(" AND ")}`
    )
    .join("\n\n");

  const failingTestsBlock = failingTests
    .map((tc) => {
      const res = resultMap.get(tc.id);
      return `- [${tc.id}] (${tc.tier} -> ${tc.targetFilePath}) Verifies: ${tc.verifiesReqIds.join(", ")}\n  Status: ${
        res?.status ?? "not_run"
      }${res?.failureMessage ? `\n  Observed Failure: ${res.failureMessage}` : ""}\n  Expected Assertions: ${tc.deterministicAssertions.join("; ")}`;
    })
    .join("\n\n");

  const shieldBlock =
    shieldTests.length > 0
      ? shieldTests
          .map(
            (tc) =>
              `- [🛡️ ${tc.id}] (${tc.targetFilePath}) -> Verifies ${tc.verifiesReqIds.join(", ")} (MUST STAY PASSING)`
          )
          .join("\n")
      : "- None passing yet — run full suite after implementing fixes.";

  let body: string;
  if (dialect.structuralFormat === "xml_tags") {
    body = [
      dialect.rules.systemFramingTemplate.trim(),
      "",
      `<uat_repair_objective>\nPost-Code UAT Readiness is currently ${uatRun.overallPassRatePct}%. Surgically fix the ${targetCriteria.length} failing/unverified acceptance criteria below while keeping all ${shieldTests.length} passing Regression Shield tests 100% green.\n</uat_repair_objective>`,
      "",
      `<failing_acceptance_criteria>\n${failingCriteriaBlock}\n</failing_acceptance_criteria>`,
      "",
      `<failing_test_diagnostics>\n${failingTestsBlock}\n</failing_test_diagnostics>`,
      "",
      `<locked_regression_shields>\n${shieldBlock}\n</locked_regression_shields>`,
      "",
      `<execution_directive>\n${dialect.rules.toolUseGuidance.trim()}\n1. Reproduce each failing TC-* test first.\n2. Implement the minimal vertical fix satisfying the exact EARS SHALL clauses.\n3. Re-run the full test suite and verify 0 regressions across all Regression Shields.\n</execution_directive>`,
    ].join("\n");
  } else if (dialect.structuralFormat === "hybrid_json_fence") {
    body = [
      dialect.rules.systemFramingTemplate.trim(),
      "",
      "Fix all failing/unrun REQ-* items below without breaking locked Regression Shields:",
      "```json",
      JSON.stringify(
        {
          readinessPct: uatRun.overallPassRatePct,
          failingCriteria: targetCriteria.map((c) => ({
            id: c.id,
            storyId: c.storyId,
            category: c.category,
            ears: c.ears.rendered,
          })),
          failingTests: failingTests.map((tc) => ({
            id: tc.id,
            file: tc.targetFilePath,
            failure: resultMap.get(tc.id)?.failureMessage ?? "not_run",
          })),
          regressionShieldsMustPass: shieldTests.map((tc) => tc.id),
        },
        null,
        2
      ),
      "```",
    ].join("\n");
  } else {
    body = [
      `# Post-Code UAT Repair Contract (${dialect.displayName})`,
      dialect.rules.systemFramingTemplate.trim(),
      "",
      `## Repair Objective\nCurrent Release Readiness: **${uatRun.overallPassRatePct}%**. Resolve the **${targetCriteria.length}** failing/unverified criteria below without breaking any of the **${shieldTests.length}** locked Regression Shields.`,
      "",
      `## Failing Acceptance Criteria (EARS)\n${failingCriteriaBlock}`,
      "",
      `## Failing Test Diagnostics\n${failingTestsBlock}`,
      "",
      `## Locked Regression Shields (Must Stay Green)\n${shieldBlock}`,
      "",
      `## Execution Protocol\n${dialect.rules.toolUseGuidance.trim()}`,
    ].join("\n");
  }

  return {
    prompt: stripDialectAvoidPhrases(body, dialect.rules.avoidPhrases),
    failingReqCount: targetCriteria.length,
    shieldCount: shieldTests.length,
  };
}

export interface FailingUatBugTicket {
  reqId: string;
  storyId: string;
  category: string;
  title: string;
  markdownBody: string;
}

export function compileFailingBugTickets(
  doc: SpecIterationDocument,
  uatRun: UatVerificationRun
): {
  tickets: FailingUatBugTicket[];
  bugsMarkdown: string;
  ghCliScript: string;
} {
  const resultMap = new Map(uatRun.testResults.map((r) => [r.testCaseId, r]));
  const allStories = doc.features.flatMap((f) => f.stories);
  const storyMap = new Map(allStories.map((s) => [s.id, s]));

  const targetIds = uatRun.failingReqIds;
  const tickets: FailingUatBugTicket[] = targetIds
    .map((reqId) => doc.criteria.find((c) => c.id === reqId))
    .filter((c): c is NonNullable<typeof c> => Boolean(c))
    .map((req) => {
      const story = storyMap.get(req.storyId);
      const failedTcs = doc.testCases.filter(
        (tc) => tc.verifiesReqIds.includes(req.id) && resultMap.get(tc.id)?.status === "failed"
      );

      const body = [
        `## [UAT Bug] ${req.id} (${req.storyId}) — ${req.title}`,
        "",
        `> **Category:** \`${req.category}\` · **Iteration:** v${doc.iterationNumber}`,
        "",
        "### Violated EARS Acceptance Criterion",
        `\`${req.ears.rendered}\``,
        "",
        "### Failing Verification Tests (`TC-*`)",
        ...failedTcs.map((tc) => {
          const r = resultMap.get(tc.id);
          return `- **\`${tc.id}\`** (\`${tc.tier}\` -> \`${tc.targetFilePath}\`)\n  - **Observed Error:** \`${(
            r?.failureMessage ?? "Test failed"
          ).replace(/`/g, "'")}\``;
        }),
        "",
        ...(story
          ? [
              "### Story Touchpoints",
              `- **Entry Surface:** ${story.touchpoints.entrySurface}`,
              `- **Domain Logic:** ${story.touchpoints.domainLogic}`,
              `- **Persistence / External:** ${story.touchpoints.persistenceOrExternal}`,
            ]
          : []),
      ].join("\n");

      return {
        reqId: req.id,
        storyId: req.storyId,
        category: req.category,
        title: `[UAT Bug · ${req.id}] ${req.title}`,
        markdownBody: body,
      };
    });

  const bugsMarkdown =
    tickets.length === 0
      ? `# Post-Code UAT Bug Backlog — 0 Failing Criteria\n\nAll executed acceptance criteria passed.`
      : [
          `# SpecPrism Post-Code UAT Bug Backlog — ${doc.triage.projectTitle ?? "Project"} (v${doc.iterationNumber})`,
          "",
          ...tickets.flatMap((t) => [t.markdownBody, "", "---", ""]),
        ].join("\n");

  const ghLines: string[] = [
    "#!/usr/bin/env bash",
    "# Generated by SpecPrism — Creates GitHub Issues for failing Post-Code UAT criteria",
    "set -euo pipefail",
    "",
  ];

  for (const t of tickets) {
    const safeTitle = posixSingleQuote(t.title);
    const marker = pickSafeHeredocMarker(t.markdownBody, "SPECPRISM_BUG_EOF");
    ghLines.push(`gh issue create --label 'bug,specprism' --title ${safeTitle} --body-file - <<'${marker}'`);
    ghLines.push(t.markdownBody);
    ghLines.push(marker);
    ghLines.push("");
  }

  return {
    tickets,
    bugsMarkdown,
    ghCliScript: ghLines.join("\n") + "\n",
  };
}
