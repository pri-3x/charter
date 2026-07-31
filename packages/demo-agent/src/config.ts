import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { loadEnv } from "@charter/shared";

/**
 * Demo-agent configuration. Everything is read once, up front, and validated with zod — a missing
 * key or a malformed seed file must stop the run rather than surface later as a confusing 401
 * (CLAUDE.md: fail closed everywhere).
 */

/** `.seed/agent-key.json`, written by `npm run seed`. */
const seedSchema = z.object({
  tenant: z.string().min(1),
  agentId: z.string().min(1),
  apiKey: z.string().min(1),
  adminKey: z.string().min(1),
  agents: z.record(z.string().min(1)),
});

export type Seed = z.infer<typeof seedSchema>;

export interface DemoConfig {
  baseUrl: string;
  seed: Seed;
  /** Model id for --live. CLAUDE.md pins claude-sonnet-4-6; ANTHROPIC_MODEL overrides. */
  model: string;
  /** Present only when ANTHROPIC_API_KEY is set. --live without it must exit non-zero. */
  anthropicApiKey?: string;
}

export const SEED_PATH = ".seed/agent-key.json";
export const DEFAULT_MODEL = "claude-sonnet-4-6";

export class DemoConfigError extends Error {}

export function loadDemoConfig(): DemoConfig {
  loadEnv();
  const seedFile = resolve(process.cwd(), SEED_PATH);
  if (!existsSync(seedFile)) {
    throw new DemoConfigError(
      `${SEED_PATH} not found — run \`npm run db:up && npm run db:migrate && npm run seed\` first.`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(seedFile, "utf8"));
  } catch (err) {
    throw new DemoConfigError(`${SEED_PATH} is not valid JSON: ${String(err)}`);
  }
  const parsed = seedSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DemoConfigError(
      `${SEED_PATH} is malformed: ${parsed.error.issues.map((i) => i.path.join(".") + " " + i.message).join("; ")}`,
    );
  }

  const explicit = process.env.CHARTER_BASE_URL ?? process.env.MANDATE_BASE_URL;
  const baseUrl = explicit ?? `http://127.0.0.1:${process.env.PORT ?? "8080"}`;

  const config: DemoConfig = {
    baseUrl,
    seed: parsed.data,
    model: process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL,
  };
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (key) config.anthropicApiKey = key;
  return config;
}

/** Look up an agent's API key by id. Unknown agent ⇒ throw; never silently fall back to another. */
export function agentKey(seed: Seed, agentId: string): string {
  const key = seed.agents[agentId];
  if (!key) {
    throw new DemoConfigError(
      `no API key for agent '${agentId}' in ${SEED_PATH} (have: ${Object.keys(seed.agents).join(", ")})`,
    );
  }
  return key;
}

/** Fail fast with a readable message if the gate is not reachable / not healthy. */
export async function requireHealthyGate(baseUrl: string): Promise<{ activePolicyVersion: number | null }> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl.replace(/\/$/, "")}/healthz`, {
      signal: AbortSignal.timeout(5_000),
    });
  } catch (err) {
    throw new DemoConfigError(
      `gate at ${baseUrl} is unreachable (${String(err)}). Start it with \`npm run dev:gate\` ` +
        `(set PORT / CHARTER_BASE_URL if it does not listen on ${baseUrl}).`,
    );
  }
  if (res.status !== 200) {
    throw new DemoConfigError(`gate at ${baseUrl} is unhealthy: HTTP ${res.status}`);
  }
  const body = (await res.json()) as { ok?: boolean; active_policy_version?: number | null };
  if (body.ok !== true) throw new DemoConfigError(`gate at ${baseUrl} reports not-ok: ${JSON.stringify(body)}`);
  return { activePolicyVersion: body.active_policy_version ?? null };
}
