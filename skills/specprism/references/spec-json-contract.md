# `.specprism/spec.json` Canonical JSON Contract

```json
{
  "projectId": "550e8400-e29b-41d4-a716-446655440000",
  "iterationNumber": 1,
  "stage": "stage_4_tests",
  "targetDialectId": "anthropic-claude",
  "createdAt": "2026-11-26T00:00:00.000Z",
  "triage": {
    "projectTitle": "Short 3-6 Word Product Title",
    "rawPrompt": "Original user idea",
    "scopedVisionSummary": "Crisp 1-2 sentence v1 scope summary",
    "primaryActors": ["Primary User", "System Admin"],
    "explicitOutOfScopeV1": ["Explicit non-goal 1", "Explicit non-goal 2"],
    "questions": [],
    "lockedAssumptions": [
      {
        "id": "ASM-001",
        "dimension": "security_auth_and_rate_limits",
        "statement": "Inbound webhook bursts above 60 req/s return HTTP 429 with Retry-After.",
        "source": "user_confirmed"
      }
    ]
  },
  "features": [
    {
      "id": "FEAT-01",
      "title": "Feature Outcome Title",
      "outcomeSummary": "Measurable user outcome",
      "stories": [
        {
          "id": "US-001",
          "featureId": "FEAT-01",
          "sliceOrder": 1,
          "title": "End-to-end vertical capability",
          "asA": "Primary User",
          "iWant": "concrete capability",
          "soThat": "verifiable value",
          "independentDemoProof": "Exact end-to-end action proving this slice works",
          "touchpoints": {
            "entrySurface": "POST /api/items + CreateItemForm",
            "domainLogic": "Rate-limit & payload schema validator",
            "persistenceOrExternal": "PostgreSQL items table"
          },
          "linkedAssumptionIds": ["ASM-001"]
        }
      ]
    }
  ],
  "criteria": [
    {
      "id": "REQ-001",
      "storyId": "US-001",
      "category": "non_functional_guardrail",
      "title": "Rate limit burst protection",
      "gwt": {
        "given": ["60 requests were accepted in the active 1-second window"],
        "when": "Request 61 arrives in the same second",
        "then": ["HTTP 429 is returned with a Retry-After header"]
      },
      "ears": {
        "pattern": "unwanted_event",
        "systemName": "Ingress API",
        "triggerOrCondition": "inbound requests exceed 60 per second",
        "shallResponse": "reject excess requests with HTTP 429 and Retry-After",
        "rendered": "IF inbound requests exceed 60 per second, THEN THE Ingress API SHALL reject excess requests with HTTP 429 and Retry-After."
      },
      "coaching": {
        "whyItMatters": "Protects DB connection pool during webhook storms.",
        "failureModePrevented": "Cascading 503 outage across all tenants."
      }
    }
  ],
  "testCases": [
    {
      "id": "TC-001",
      "title": "Returns 429 Retry-After on burst request 61",
      "tier": "api_contract",
      "verifiesReqIds": ["REQ-001"],
      "targetFilePath": "tests/api/rate-limit.test.ts",
      "skeletonCode": "import { describe, it, expect } from 'vitest';\ndescribe('rate limit', () => { it('returns 429 on 61st req', async () => { /* ... */ }); });",
      "deterministicAssertions": ["res.status === 429", "res.headers.get('retry-after') !== null"]
    }
  ],
  "recommendedMcps": []
}
```
