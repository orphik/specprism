import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzlePostgresJs } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { type AnySpecPrismDrizzleDb, ensureSpecPrismSchema } from "./bootstrap.js";
import * as schema from "./schema/index.js";

export interface SpecPrismDbConnection {
  db: AnySpecPrismDrizzleDb;
  engine: "pglite" | "postgres";
  close: () => Promise<void>;
}

export async function createSpecPrismDb(
  rawDatabaseUrl?: string,
  options: { autoBootstrap?: boolean } = { autoBootstrap: true }
): Promise<SpecPrismDbConnection> {
  const url = (rawDatabaseUrl ?? process.env.DATABASE_URL ?? "pglite://./.specprism/pgdata").trim();

  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) {
    const client = postgres(url, {
      max: 10,
      idle_timeout: 20,
      connect_timeout: 10,
    });
    const db = drizzlePostgresJs(client, { schema }) as unknown as AnySpecPrismDrizzleDb;
    if (options.autoBootstrap) {
      await ensureSpecPrismSchema(db);
    }
    return {
      db,
      engine: "postgres",
      close: async () => {
        await client.end({ timeout: 5 });
      },
    };
  }

  // Zero-config embedded PostgreSQL via PGlite (+ pgvector WASM extension)
  let dataDir: string | undefined;
  if (url !== "memory://" && url !== "pglite://memory") {
    const cleanPath = url.replace(/^pglite:\/\//, "");
    dataDir = resolve(process.cwd(), cleanPath);
    mkdirSync(dirname(dataDir), { recursive: true });
  }

  const pg = await PGlite.create({
    dataDir,
    extensions: { vector },
  });
  const db = drizzlePglite(pg, { schema }) as unknown as AnySpecPrismDrizzleDb;

  if (options.autoBootstrap) {
    await ensureSpecPrismSchema(db);
  }

  return {
    db,
    engine: "pglite",
    close: async () => {
      await pg.close();
    },
  };
}
