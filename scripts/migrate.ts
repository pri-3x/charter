import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { Client } from "pg";
import { loadEnv } from "@charter/shared";

loadEnv();

const MIGRATIONS_DIR = resolve(process.cwd(), "db/migrations");

async function main(): Promise<void> {
  const url = process.env.POSTGRES_SUPERUSER_URL;
  if (!url) throw new Error("POSTGRES_SUPERUSER_URL not set");

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        name       text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    const applied = new Set(
      (await client.query<{ name: string }>("SELECT name FROM _migrations")).rows.map(
        (r) => r.name,
      ),
    );

    let ran = 0;
    for (const file of files) {
      if (applied.has(file)) {
        console.log(`skip  ${file} (already applied)`);
        continue;
      }
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO _migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        console.log(`apply ${file}`);
        ran++;
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      }
    }
    console.log(ran === 0 ? "no new migrations" : `applied ${ran} migration(s)`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
