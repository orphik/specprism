import { createSpecPrismDb } from "./client.js";

async function main() {
  const conn = await createSpecPrismDb(process.env.DATABASE_URL, { autoBootstrap: true });
  console.log(`[@specprism/db] Schema ensured successfully on engine=${conn.engine}.`);
  await conn.close();
}

main().catch((err) => {
  console.error("[@specprism/db] Migration failed:", err);
  process.exit(1);
});
