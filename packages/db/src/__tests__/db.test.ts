import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  aiModels,
  createSpecPrismDb,
  decryptSecret,
  encryptSecret,
  mcpServers,
  specProjects,
  type SpecPrismDbConnection,
  userApiKeys,
  users,
} from "../index.js";

describe("@specprism/db unified PGlite + pgvector + BYOK encryption", () => {
  let conn: SpecPrismDbConnection;

  beforeAll(async () => {
    conn = await createSpecPrismDb("memory://", { autoBootstrap: true });
  });

  afterAll(async () => {
    await conn.close();
  });

  it("encrypts and decrypts BYOK keys with AES-256-GCM authenticated envelopes", () => {
    const testKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const rawSecret = "sk-or-v1-super-secret-user-key";
    const ciphertext = encryptSecret(rawSecret, testKey);
    expect(ciphertext.startsWith("v1:")).toBe(true);
    expect(ciphertext).not.toContain(rawSecret);
    expect(decryptSecret(ciphertext, testKey)).toBe(rawSecret);
  });

  it("persists users, encrypted BYOK keys, projects, AI models, and pgvector MCP entries", async () => {
    expect(conn.engine).toBe("pglite");

    await conn.db.insert(users).values({
      id: "usr_01",
      name: "Ada Architect",
      email: "ada@spec-prism.app",
      emailVerified: true,
    });

    const cipher = encryptSecret("sk-or-test-1234", "local-dev-encryption-secret-key");
    await conn.db.insert(userApiKeys).values({
      userId: "usr_01",
      provider: "openrouter",
      keyHint: "...1234",
      encryptedKey: cipher,
    });

    const [project] = await conn.db
      .insert(specProjects)
      .values({
        ownerId: "usr_01",
        slug: "webhook-replay",
        title: "Webhook Replay Workbench",
      })
      .returning();

    expect(project?.slug).toBe("webhook-replay");

    await conn.db.insert(aiModels).values({
      id: "anthropic/claude-sonnet-4-5",
      provider: "anthropic",
      displayName: "Claude Sonnet 4.5",
      contextWindow: 200000,
      supportsStructuredOutput: true,
      supportsTools: true,
      supportsReasoning: true,
      sourceCatalog: "openrouter",
    });

    const zeroVector = Array.from({ length: 384 }, (_, idx) => (idx === 0 ? 1 : 0));
    await conn.db.insert(mcpServers).values({
      id: "io.modelcontextprotocol/playwright",
      displayName: "Playwright MCP",
      description: "Browser automation for deterministic E2E verification",
      transport: "stdio",
      endpointOrCommand: "npx @playwright/mcp@latest",
      tags: ["e2e", "testing", "browser"],
      embedding: zeroVector,
    });

    const storedMcp = await conn.db
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.id, "io.modelcontextprotocol/playwright"));

    expect(storedMcp).toHaveLength(1);
    expect(storedMcp[0]?.displayName).toBe("Playwright MCP");
  });
});
