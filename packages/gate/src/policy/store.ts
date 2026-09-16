import type { Pool } from "../db.js";
import { parsePolicyYaml } from "./schema.js";
import type { PolicyDoc } from "./schema.js";

export interface ActivePolicy {
  version: number;
  docHash: string;
  doc: PolicyDoc;
}

/**
 * In-process cache of the active policy per tenant (SPEC 2.3), with a short TTL.
 *
 * This was originally invalidate-on-activation with no expiry, documented as "single-node POC —
 * cross-process invalidation is out of scope". That was right for one long-lived process. It stopped
 * being right the moment the gate ran on serverless, because `invalidate()` only clears the cache of
 * the ONE instance that served the activation request. Every other warm instance keeps enforcing the
 * previous policy until it happens to cycle — so an operator who TIGHTENS a rule sees it take effect
 * on some requests and not others, with no signal which. For a policy gate that is a fail-open, and
 * the failure is invisible.
 *
 * A TTL bounds it without adding infrastructure: the worst case becomes "a policy change takes up to
 * TTL to apply everywhere" instead of "indefinitely". The cost is one small query per tenant per TTL
 * per instance. `invalidate()` is kept so the activating instance is still correct immediately.
 *
 * The honest remaining gap: within the TTL, instances can disagree. Closing that properly needs a
 * notification channel (LISTEN/NOTIFY or a version check per request) rather than a timer.
 */
const DEFAULT_TTL_MS = 30_000;

interface Entry {
  value: ActivePolicy | null;
  loadedAt: number;
}

export class PolicyStore {
  private cache = new Map<string, Entry>();
  private readonly ttlMs: number;

  constructor(
    private pool: Pool,
    opts: { ttlMs?: number } = {},
  ) {
    this.ttlMs = opts.ttlMs ?? Number(process.env.CHARTER_POLICY_CACHE_TTL_MS ?? DEFAULT_TTL_MS);
  }

  async getActive(tenant: string): Promise<ActivePolicy | null> {
    const hit = this.cache.get(tenant);
    if (hit && Date.now() - hit.loadedAt < this.ttlMs) return hit.value;
    const { rows } = await this.pool.query<{ version: number; doc_yaml: string; doc_hash: string }>(
      "SELECT version, doc_yaml, doc_hash FROM policies WHERE tenant_id = $1 AND status = 'active'",
      [tenant],
    );
    const row = rows[0];
    if (!row) {
      this.cache.set(tenant, { value: null, loadedAt: Date.now() });
      return null;
    }
    const active: ActivePolicy = {
      version: Number(row.version),
      docHash: row.doc_hash,
      doc: parsePolicyYaml(row.doc_yaml),
    };
    this.cache.set(tenant, { value: active, loadedAt: Date.now() });
    return active;
  }

  invalidate(tenant: string): void {
    this.cache.delete(tenant);
  }
}
