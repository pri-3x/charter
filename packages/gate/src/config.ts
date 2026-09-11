import { loadEnv } from "@charter/shared";

export interface GateConfig {
  databaseUrl: string;
  adminKey: string;
  port: number;
  signingKeyPath?: string;
  anchorsLogPath: string;
  checkpointIntervalMs: number;
  /** Agent key the public demo endpoints act as. Absent ⇒ those endpoints answer 503. */
  demoAgentKey?: string;
  /** base64 AES-256 key sealing Pattern B tool credentials. Absent ⇒ /v1/credentials + /v1/proxy 503. */
  credentialKey?: string;
  /** Dev only: allow http://localhost egress targets so the demo tool can run on this machine. */
  allowLoopbackEgress: boolean;
}

/** Read + validate gate config from the environment. Fails closed if required values are missing. */
export function loadConfig(): GateConfig {
  loadEnv();
  const databaseUrl = process.env.DATABASE_URL;
  const adminKey = process.env.CHARTER_ADMIN_KEY;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  if (!adminKey) throw new Error("CHARTER_ADMIN_KEY is required");
  return {
    databaseUrl,
    adminKey,
    port: Number(process.env.PORT ?? 8080),
    signingKeyPath: process.env.CHARTER_SIGNING_KEY_PATH,
    anchorsLogPath: process.env.ANCHORS_LOG_PATH ?? "./anchors.log",
    checkpointIntervalMs: Number(process.env.CHECKPOINT_INTERVAL_MS ?? 300000),
    ...(process.env.CHARTER_DEMO_AGENT_KEY ? { demoAgentKey: process.env.CHARTER_DEMO_AGENT_KEY } : {}),
    ...(process.env.CHARTER_CREDENTIAL_KEY ? { credentialKey: process.env.CHARTER_CREDENTIAL_KEY } : {}),
    // Opt-in, and never on in production: this is what lets a credential be posted to localhost.
    allowLoopbackEgress:
      process.env.CHARTER_ALLOW_LOOPBACK_EGRESS === "true" && process.env.NODE_ENV !== "production",
  };
}
