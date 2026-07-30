import { loadEnv } from "@mandate/shared";

export interface GateConfig {
  databaseUrl: string;
  adminKey: string;
  port: number;
  signingKeyPath?: string;
  anchorsLogPath: string;
  checkpointIntervalMs: number;
}

/** Read + validate gate config from the environment. Fails closed if required values are missing. */
export function loadConfig(): GateConfig {
  loadEnv();
  const databaseUrl = process.env.DATABASE_URL;
  const adminKey = process.env.MANDATE_ADMIN_KEY;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  if (!adminKey) throw new Error("MANDATE_ADMIN_KEY is required");
  return {
    databaseUrl,
    adminKey,
    port: Number(process.env.PORT ?? 8080),
    signingKeyPath: process.env.MANDATE_SIGNING_KEY_PATH,
    anchorsLogPath: process.env.ANCHORS_LOG_PATH ?? "./anchors.log",
    checkpointIntervalMs: Number(process.env.CHECKPOINT_INTERVAL_MS ?? 300000),
  };
}
