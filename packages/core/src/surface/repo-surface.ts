import { type RepoSurfaceContext, RepoSurfaceContextSchema } from "../schemas/index.js";

export const MAX_REPO_SURFACE_PATHS = 400;

const IGNORED_PATH_PREFIXES = [
  "node_modules/",
  ".git/",
  "dist/",
  "build/",
  ".next/",
  ".turbo/",
  "coverage/",
  "vendor/",
  "__pycache__/",
  "target/",
];

const SAFE_SEGMENT_RX = /^[A-Za-z0-9._-]+$/;

export function parseGitHubPublicRepoUrl(rawUrl: string): {
  owner: string;
  repo: string;
  normalizedUrl: string;
} {
  const trimmed = (rawUrl ?? "").trim();
  if (!trimmed || trimmed.includes("..") || trimmed.includes("\\") || /\s/.test(trimmed)) {
    throw new Error(
      "Invalid repository URL: provide a public https://github.com/<owner>/<repo> URL."
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(
      "Invalid repository URL: provide a public https://github.com/<owner>/<repo> URL."
    );
  }

  const host = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== "https:" ||
    (host !== "github.com" && host !== "www.github.com") ||
    parsed.username ||
    parsed.password ||
    parsed.port
  ) {
    throw new Error(
      "Unsupported repository host: only public https://github.com/<owner>/<repo> URLs are permitted."
    );
  }

  const cleanPath = parsed.pathname.replace(/\.git$/i, "");
  const segments = cleanPath.split("/").filter(Boolean);
  if (segments.length < 2) {
    throw new Error(
      "Repository URL must include both owner and repository name (https://github.com/<owner>/<repo>)."
    );
  }

  const owner = segments[0]!;
  const repo = segments[1]!;
  if (
    owner === "." ||
    repo === "." ||
    !SAFE_SEGMENT_RX.test(owner) ||
    !SAFE_SEGMENT_RX.test(repo)
  ) {
    throw new Error(
      "Invalid GitHub owner or repository name in https://github.com/<owner>/<repo>."
    );
  }

  return {
    owner,
    repo,
    normalizedUrl: `https://github.com/${owner}/${repo}`,
  };
}

function inferStackFromManifestAndPaths(
  pkgJson: Record<string, unknown> | null,
  paths: string[]
): {
  packageManager?: string;
  frameworks: string[];
  orms: string[];
  testRunners: string[];
} {
  const frameworks = new Set<string>();
  const orms = new Set<string>();
  const testRunners = new Set<string>();
  let packageManager: string | undefined;

  const lowerPaths = paths.map((p) => p.toLowerCase());
  if (lowerPaths.includes("pnpm-lock.yaml") || lowerPaths.includes("pnpm-workspace.yaml")) {
    packageManager = "pnpm";
  } else if (lowerPaths.includes("yarn.lock")) {
    packageManager = "yarn";
  } else if (lowerPaths.includes("bun.lockb") || lowerPaths.includes("bun.lock")) {
    packageManager = "bun";
  } else if (lowerPaths.includes("package-lock.json") || lowerPaths.includes("package.json")) {
    packageManager = "npm";
  }

  if (pkgJson) {
    if (typeof pkgJson.packageManager === "string" && pkgJson.packageManager.trim()) {
      packageManager = pkgJson.packageManager.split("@")[0]?.trim() || packageManager;
    }
    const deps = {
      ...((pkgJson.dependencies as Record<string, unknown> | undefined) ?? {}),
      ...((pkgJson.devDependencies as Record<string, unknown> | undefined) ?? {}),
    };
    const hasDep = (name: string) => Object.prototype.hasOwnProperty.call(deps, name);

    if (hasDep("next")) frameworks.add("nextjs");
    if (hasDep("react")) frameworks.add("react");
    if (hasDep("vue") || hasDep("nuxt")) frameworks.add("vue");
    if (hasDep("svelte") || hasDep("@sveltejs/kit")) frameworks.add("svelte");
    if (hasDep("@angular/core")) frameworks.add("angular");
    if (hasDep("express")) frameworks.add("express");
    if (hasDep("fastify")) frameworks.add("fastify");
    if (hasDep("hono")) frameworks.add("hono");
    if (hasDep("@nestjs/core")) frameworks.add("nestjs");

    if (hasDep("drizzle-orm")) orms.add("drizzle");
    if (hasDep("prisma") || hasDep("@prisma/client")) orms.add("prisma");
    if (hasDep("typeorm")) orms.add("typeorm");
    if (hasDep("knex")) orms.add("knex");
    if (hasDep("mongoose")) orms.add("mongoose");

    if (hasDep("vitest")) testRunners.add("vitest");
    if (hasDep("@playwright/test") || hasDep("playwright")) testRunners.add("playwright");
    if (hasDep("jest")) testRunners.add("jest");
    if (hasDep("cypress")) testRunners.add("cypress");
  }

  // Fallback heuristics from file paths (monorepos, Python, Java, Go)
  for (const p of lowerPaths) {
    if (p.endsWith("next.config.ts") || p.endsWith("next.config.mjs") || p.endsWith("next.config.js")) {
      frameworks.add("nextjs");
    }
    if (p.includes("drizzle.config") || p.includes("/schema/") && p.endsWith(".ts")) {
      // Only infer drizzle from config; avoid false positive on generic schema
      if (p.includes("drizzle.config")) orms.add("drizzle");
    }
    if (p.endsWith("schema.prisma")) orms.add("prisma");
    if (p.includes("vitest.config") || p.endsWith(".test.ts") || p.endsWith(".test.tsx")) {
      if (p.includes("vitest.config") || testRunners.size === 0) testRunners.add("vitest");
    }
    if (p.includes("playwright.config")) testRunners.add("playwright");
    if (p.endsWith("pyproject.toml") || p.endsWith("requirements.txt")) {
      packageManager = packageManager ?? "pip/uv";
    }
    if (p.includes("conftest.py") || p.startsWith("tests/test_")) testRunners.add("pytest");
    if (p.endsWith("pom.xml") || p.endsWith("build.gradle") || p.endsWith("build.gradle.kts")) {
      frameworks.add("java/jvm");
      testRunners.add("junit");
    }
  }

  return {
    packageManager,
    frameworks: [...frameworks],
    orms: [...orms],
    testRunners: [...testRunners],
  };
}

function prioritizeSamplePaths(paths: string[], limit: number): string[] {
  const scorePath = (p: string): number => {
    const low = p.toLowerCase();
    if (low.includes("__tests__") || low.endsWith(".test.ts") || low.endsWith(".spec.ts")) return 0;
    if (low.includes("schema") || low.includes("db/") || low.includes("prisma")) return 1;
    if (low.includes("src/app/") || low.includes("routes") || low.includes("api/")) return 2;
    if (low.startsWith("src/") || low.startsWith("packages/") || low.startsWith("apps/")) return 3;
    return 4;
  };

  return [...paths]
    .sort((a, b) => {
      const diff = scorePath(a) - scorePath(b);
      return diff !== 0 ? diff : a.localeCompare(b);
    })
    .slice(0, Math.min(limit, MAX_REPO_SURFACE_PATHS));
}

export async function scanPublicGitHubRepoSurface(
  rawUrl: string,
  options?: {
    fetchImpl?: typeof fetch;
    maxPaths?: number;
    githubToken?: string;
  }
): Promise<RepoSurfaceContext> {
  // Strict allowlist check BEFORE any network request (blocks SSRF)
  const { owner, repo, normalizedUrl } = parseGitHubPublicRepoUrl(rawUrl);
  const fetchFn = options?.fetchImpl ?? fetch;
  const maxPaths = Math.min(options?.maxPaths ?? MAX_REPO_SURFACE_PATHS, MAX_REPO_SURFACE_PATHS);

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "specprism-surface-scanner/1.6",
  };
  if (options?.githubToken?.trim()) {
    headers.Authorization = `Bearer ${options.githubToken.trim()}`;
  }

  const repoMetaRes = await fetchFn(`https://api.github.com/repos/${owner}/${repo}`, { headers });
  if (!repoMetaRes.ok) {
    throw new Error(
      repoMetaRes.status === 404
        ? `GitHub repository '${owner}/${repo}' was not found or is private. For private repositories, push .specprism/surface.json via MCP (specprism_push_surface) or CLI (specprism sync-surface).`
        : `GitHub API returned HTTP ${repoMetaRes.status} while inspecting '${owner}/${repo}'.`
    );
  }

  const repoMeta = (await repoMetaRes.json()) as { default_branch?: string };
  const defaultBranch = repoMeta.default_branch?.trim() || "main";

  const treeRes = await fetchFn(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(
      defaultBranch
    )}?recursive=1`,
    { headers }
  );
  if (!treeRes.ok) {
    throw new Error(
      `Failed to read repository file tree for '${owner}/${repo}@${defaultBranch}' (HTTP ${treeRes.status}).`
    );
  }

  const treeJson = (await treeRes.json()) as {
    tree?: Array<{ path?: string; type?: string }>;
  };

  const cleanBlobs = (treeJson.tree ?? [])
    .filter((entry) => entry.type === "blob" && typeof entry.path === "string")
    .map((entry) => entry.path!.trim())
    .filter(
      (p) =>
        p.length > 0 &&
        !p.includes("..") &&
        !IGNORED_PATH_PREFIXES.some((prefix) => p.startsWith(prefix) || p.includes(`/${prefix}`))
    );

  let rootPkgJson: Record<string, unknown> | null = null;
  if (cleanBlobs.includes("package.json")) {
    try {
      const pkgRes = await fetchFn(
        `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(
          defaultBranch
        )}/package.json`,
        { headers: { "User-Agent": "specprism-surface-scanner/1.6" } }
      );
      if (pkgRes.ok) {
        rootPkgJson = (await pkgRes.json()) as Record<string, unknown>;
      }
    } catch {
      rootPkgJson = null;
    }
  }

  const inferred = inferStackFromManifestAndPaths(rootPkgJson, cleanBlobs);
  const samplePaths = prioritizeSamplePaths(cleanBlobs, maxPaths);

  return RepoSurfaceContextSchema.parse({
    source: "github_public",
    repoUrl: normalizedUrl,
    repoSlug: `${owner}/${repo}`,
    defaultBranch,
    mode: cleanBlobs.length > 0 ? "brownfield" : "greenfield",
    packageManager: inferred.packageManager,
    frameworks: inferred.frameworks,
    orms: inferred.orms,
    testRunners: inferred.testRunners,
    codeFileCount: cleanBlobs.length,
    samplePaths,
    scannedAt: new Date().toISOString(),
  });
}

export function normalizePushedSurfaceJson(
  rawSurface: unknown,
  source: "mcp_push" | "cli_scan" | "manual_upload" = "mcp_push"
): RepoSurfaceContext {
  if (!rawSurface || typeof rawSurface !== "object") {
    throw new Error("Surface payload must be a JSON object generated by scan-repo.mjs.");
  }
  const obj = rawSurface as Record<string, unknown>;
  const rawPaths = Array.isArray(obj.samplePaths)
    ? obj.samplePaths.filter((p): p is string => typeof p === "string")
    : [];

  return RepoSurfaceContextSchema.parse({
    source,
    repoSlug: typeof obj.repoSlug === "string" ? obj.repoSlug.slice(0, 160) : undefined,
    defaultBranch:
      typeof obj.defaultBranch === "string" ? obj.defaultBranch.slice(0, 120) : undefined,
    mode: obj.mode === "greenfield" ? "greenfield" : "brownfield",
    packageManager:
      typeof obj.packageManager === "string" ? obj.packageManager.slice(0, 60) : undefined,
    frameworks: Array.isArray(obj.frameworks)
      ? obj.frameworks.filter((x): x is string => typeof x === "string")
      : [],
    orms: Array.isArray(obj.orms)
      ? obj.orms.filter((x): x is string => typeof x === "string")
      : [],
    testRunners: Array.isArray(obj.testRunners)
      ? obj.testRunners.filter((x): x is string => typeof x === "string")
      : [],
    codeFileCount: typeof obj.codeFileCount === "number" ? Math.max(0, obj.codeFileCount) : rawPaths.length,
    samplePaths: prioritizeSamplePaths(rawPaths, MAX_REPO_SURFACE_PATHS),
    scannedAt:
      typeof obj.scannedAt === "string" && obj.scannedAt.trim()
        ? obj.scannedAt
        : new Date().toISOString(),
  });
}

export function formatRepoSurfacePromptBlock(surface?: RepoSurfaceContext | null): string {
  if (!surface) return "";
  const topPaths = surface.samplePaths.slice(0, 80);
  return [
    "",
    "<repository_surface_context>",
    `Repository: ${surface.repoSlug ?? surface.repoUrl ?? "Attached Brownfield Workspace"} (${surface.mode})`,
    `Detected Stack: frameworks=[${surface.frameworks.join(", ") || "unspecified"}] | orms=[${
      surface.orms.join(", ") || "unspecified"
    }] | testRunners=[${surface.testRunners.join(", ") || "unspecified"}] | packageManager=${
      surface.packageManager ?? "unspecified"
    }`,
    `Codebase Size: ${surface.codeFileCount} files scanned`,
    topPaths.length > 0
      ? `Representative File Tree Paths:\n${topPaths.map((p) => `  - ${p}`).join("\n")}`
      : "",
    "GROUNDING RULE: Ground all architectural exploit questions, story touchpoints (entrySurface, domainLogic, persistenceOrExternal), subsystem names, and TC-* targetFilePath / skeletonCode outputs strictly in this detected stack and directory layout. Never invent a foreign ORM or test runner.",
    "</repository_surface_context>",
  ]
    .filter(Boolean)
    .join("\n");
}
