import type { MaliciousComplianceExploitClass } from "../schemas/index.js";

export interface ExploitClassDescriptor {
  id: MaliciousComplianceExploitClass;
  badgeLabel: string;
  mechanism: string;
  remedyPattern: string;
}

export const EXPLOIT_CLASS_CATALOG: Record<
  MaliciousComplianceExploitClass,
  ExploitClassDescriptor
> = {
  orphaned_state: {
    id: "orphaned_state",
    badgeLabel: "Orphaned State",
    mechanism:
      "Parent record paused/deleted/downgraded while cron jobs, API keys, sessions, or cached entitlements stay live.",
    remedyPattern:
      "Enforce active parent status at execution time or cascade teardown on state transition.",
  },
  partial_mutation: {
    id: "partial_mutation",
    badgeLabel: "Split-Brain Mutation",
    mechanism:
      "Sequential writes across DB + external APIs (Stripe, S3, email) leave split-brain state on mid-flight failure.",
    remedyPattern:
      "Persist PENDING row + deterministic idempotency key or use transactional outbox reconciliation.",
  },
  auth_boundary_leak: {
    id: "auth_boundary_leak",
    badgeLabel: "Tenant / Role Leak",
    mechanism:
      "Authenticates caller login without scoping queries by tenant/organization ID (IDOR) or enforcing role ceilings.",
    remedyPattern:
      "Scope repository predicates by tenant_id + actor role enum and return deterministic 403/404.",
  },
  concurrency_race: {
    id: "concurrency_race",
    badgeLabel: "Concurrency Race",
    mechanism:
      "Check-then-act balance, seat, or status checks in memory fail under double-clicks or parallel retries.",
    remedyPattern:
      "Acquire SELECT ... FOR UPDATE row locks, optimistic version CAS, or unique DB constraints.",
  },
  blast_radius_scale: {
    id: "blast_radius_scale",
    badgeLabel: "Unbounded Blast Radius",
    mechanism:
      "Synchronous O(N) loops or unbounded SELECT * inside HTTP handlers time out workers under load.",
    remedyPattern:
      "Enforce explicit batch size caps (HTTP 413) or cursor-paginated async worker chunks.",
  },
  silent_fallback: {
    id: "silent_fallback",
    badgeLabel: "Silent Fallback",
    mechanism:
      "Broad catch blocks or permissive defaults swallow upstream 429/payment/auth errors behind HTTP 200.",
    remedyPattern:
      "Fail closed with explicit error codes, dunning states, or dead-letter visibility.",
  },
};

const ANTI_SLOP_REGEXES: Array<{ rx: RegExp; hint: string }> = [
  {
    rx: /\b(add|implement|ensure|use)\s+(proper|appropriate|good|adequate)\s+error\s+handling\b/i,
    hint: "Specify exact HTTP status codes, rollback state, retry backoff, or dead-letter behavior instead of 'proper error handling'.",
  },
  {
    rx: /\bfollow\s+(security\s+)?best\s+practices\b/i,
    hint: "Name the exact tenant predicate, RBAC role check, encryption cipher, or row lock instead of 'follow best practices'.",
  },
  {
    rx: /\b(implement|add|ensure)\s+(appropriate|proper)\s+(input\s+)?validation\b/i,
    hint: "Name the exact schema, field boundary, and rejection status code instead of 'appropriate validation'.",
  },
  {
    rx: /\bhandle\s+edge\s+cases\s+(properly|gracefully|appropriately)\b/i,
    hint: "State the exact trigger condition and deterministic SHALL mitigation instead of 'handle edge cases gracefully'.",
  },
];

export function detectAntiSlopViolation(text: string): string | null {
  const normalized = text.trim();
  for (const rule of ANTI_SLOP_REGEXES) {
    if (rule.rx.test(normalized)) {
      return `Anti-slop gate rejected vague filler phrase in "${normalized.slice(0, 120)}": ${rule.hint}`;
    }
  }
  return null;
}

export const STAGE1_MALICIOUS_COMPLIANCE_DIRECTIVE = `MALICIOUS COMPLIANCE REFEREE LENS:
Coding agents optimize for the shortest diff that passes happy-path words while quietly corrupting production. Probe the prompt across these 6 orthogonal exploit classes and tag each question's optional "exploitClass" when applicable:
- orphaned_state (parent paused/deleted while cron jobs, API keys, or cached entitlements stay active)
- partial_mutation (split-brain sequential writes across DB + Stripe/S3/email without idempotency or outbox recovery)
- auth_boundary_leak (checks login without tenant_id scoping / IDOR protection or role ceilings)
- concurrency_race (check-then-act double-click races without row locks, CAS, or unique constraints)
- blast_radius_scale (synchronous O(N) loops or unbounded queries inside HTTP handlers)
- silent_fallback (broad catch blocks or permissive defaults hiding upstream failures behind HTTP 200)
Keep option labels concrete (locks, status codes, idempotency keys, batch caps) and tradeoffNote in plain, jargon-free product language.`;

export const STAGE3_MALICIOUS_COMPLIANCE_DIRECTIVE = `MALICIOUS COMPLIANCE & ANTI-SLOP RULES:
For negative_edge_case and non_functional_guardrail criteria, defend each story against literal-agent loopholes across the 6 exploit classes (orphaned_state, partial_mutation, auth_boundary_leak, concurrency_race, blast_radius_scale, silent_fallback) and populate optional "exploitClass" when applicable. NEVER write vague filler ("add proper error handling", "follow security best practices"); state exact HTTP status codes, locks, tenant predicates, or retry caps.`;
