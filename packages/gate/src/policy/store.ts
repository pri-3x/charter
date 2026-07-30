import type { Pool } from "../db.js";
import { parsePolicyYaml } from "./schema.js";
import type { PolicyDoc } from "./schema.js";

export interface ActivePolicy {
  version: number;
  docHash: string;
  doc: PolicyDoc;
}

/**
 * In-process cache of the active policy per tenant (SPEC 2.3). Loaded lazily from the DB and
 * invalidated on activation. Single-node POC — cross-process invalidation is out of scope.
 */
export class PolicyStore {
  private cache = new Map<string, ActivePolicy | null>();

  constructor(private pool: Pool) {}

  async getActive(tenant: string): Promise<ActivePolicy | null> {
    if (this.cache.has(tenant)) return this.cache.get(tenant)!;
    const { rows } = await this.pool.query<{ version: number; doc_yaml: string; doc_hash: string }>(
      "SELECT version, doc_yaml, doc_hash FROM policies WHERE tenant_id = $1 AND status = 'active'",
      [tenant],
    );
    const row = rows[0];
    if (!row) {
      this.cache.set(tenant, null);
      return null;
    }
    const active: ActivePolicy = {
      version: Number(row.version),
      docHash: row.doc_hash,
      doc: parsePolicyYaml(row.doc_yaml),
    };
    this.cache.set(tenant, active);
    return active;
  }

  invalidate(tenant: string): void {
    this.cache.delete(tenant);
  }
}
