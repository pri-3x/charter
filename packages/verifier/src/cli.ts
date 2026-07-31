#!/usr/bin/env -S npx tsx
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { verify } from "./verify.js";
import type { Anchor } from "./verify.js";

/** Minimal .env loader (inline — the verifier imports NO workspace packages, D6). */
function loadEnv(): void {
  const file = resolve(process.cwd(), ".env");
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    const hash = val.indexOf(" #");
    if (hash !== -1 && !val.startsWith('"')) val = val.slice(0, hash).trim();
    if (!(key in process.env)) process.env[key] = val;
  }
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  loadEnv();
  const tenant = arg("--tenant") ?? "acme-fintech";
  const fromSeq = arg("--from-seq") ? Number(arg("--from-seq")) : undefined;
  const connectionString = process.env.VERIFIER_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("VERIFIER_DATABASE_URL (or DATABASE_URL) is required");
    process.exit(2);
  }

  const pubPath = arg("--pubkey") ?? process.env.CHARTER_SIGNING_PUB_PATH;
  const publicKeyPem = pubPath && existsSync(pubPath) ? readFileSync(pubPath, "utf8") : undefined;

  const anchorsPath = arg("--anchors");
  let anchors: Anchor[] | undefined;
  if (anchorsPath && existsSync(anchorsPath)) {
    anchors = readFileSync(anchorsPath, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Anchor);
  }

  const report = await verify({ connectionString, tenant, ...(fromSeq ? { fromSeq } : {}), ...(publicKeyPem ? { publicKeyPem } : {}), ...(anchors ? { anchors } : {}) });

  console.log("");
  console.log(`  charter-verify · tenant ${report.tenant}`);
  console.log(`  entries checked:      ${report.entriesChecked}`);
  console.log(`  checkpoints verified: ${report.checkpointsChecked}`);
  for (const w of report.warnings) console.log(`  ⚠ ${w}`);
  if (report.ok) {
    console.log(`  \x1b[32mRESULT: OK — ledger intact\x1b[0m`);
    console.log("");
    process.exit(0);
  } else {
    const f = report.failure!;
    const where = f.seq !== undefined ? `@ seq ${f.seq}` : f.checkpointId ? `@ checkpoint ${f.checkpointId}` : "";
    console.log(`  \x1b[31mRESULT: FAIL [${f.kind}] ${where}\x1b[0m`);
    console.log(`  ${f.detail}`);
    console.log("");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
