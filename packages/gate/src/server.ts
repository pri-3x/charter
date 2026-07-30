import { existsSync } from "node:fs";
import { loadConfig } from "./config.js";
import { makePool } from "./db.js";
import { buildApp } from "./app.js";
import { expireHolds } from "./holds-resolve.js";
import { loadSigner, makeAnchorAppender, createPendingCheckpoint } from "./checkpoint.js";
import { logger } from "./logger.js";

const HOLD_SWEEP_INTERVAL_MS = 30_000; // D9: expire past-TTL holds every 30s
const TENANT = "acme-fintech"; // single-tenant POC

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = makePool(config.databaseUrl);
  const app = await buildApp({
    pool,
    adminKey: config.adminKey,
    anchorsLogPath: config.anchorsLogPath,
  });

  // Fail-closed expiry sweeper (D9). Runs in the gate process since it writes ledger entries.
  const sweeper = setInterval(() => {
    expireHolds(pool)
      .then((n) => {
        if (n > 0) logger.info({ expired: n }, "expired past-TTL holds");
      })
      .catch((err) => logger.error({ err }, "hold sweeper failed"));
  }, HOLD_SWEEP_INTERVAL_MS);
  sweeper.unref();

  // Merkle checkpoint worker (SPEC 4.3, D5). Disabled (with a warning) if no signing key is present.
  let checkpointer: NodeJS.Timeout | undefined;
  if (config.signingKeyPath && existsSync(config.signingKeyPath)) {
    const signer = loadSigner(config.signingKeyPath);
    const anchor = makeAnchorAppender(config.anchorsLogPath);
    checkpointer = setInterval(() => {
      createPendingCheckpoint(pool, signer, TENANT, anchor)
        .then((cp) => {
          if (cp) logger.info({ seq_from: cp.seq_from, seq_to: cp.seq_to, merkle_root: cp.merkle_root }, "sealed checkpoint");
        })
        .catch((err) => logger.error({ err }, "checkpoint worker failed"));
    }, config.checkpointIntervalMs);
    checkpointer.unref();
    logger.info({ intervalMs: config.checkpointIntervalMs }, "checkpoint worker enabled");
  } else {
    logger.warn("checkpoint worker disabled: no MANDATE_SIGNING_KEY_PATH (run `npm run keygen`)");
  }

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "shutting down");
    clearInterval(sweeper);
    if (checkpointer) clearInterval(checkpointer);
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ port: config.port, host: "0.0.0.0" });
  logger.info({ port: config.port }, "gate listening");
}

main().catch((err) => {
  logger.error({ err }, "gate failed to start");
  process.exit(1);
});
