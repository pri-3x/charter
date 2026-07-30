import { ulid } from "ulid";
import { sha256Token } from "@mandate/shared";
import type { Pool } from "../db.js";
import { appendEntry } from "../ledger.js";
import { parsePolicyYaml } from "./schema.js";
import type { PolicyDoc } from "./schema.js";
import type { PolicyStore } from "./store.js";

export interface DraftResult {
  draftId: string;
  tenant: string;
  parsed: PolicyDoc;
}

/**
 * Validate a YAML policy and store it as a draft (D11: policies are immutable rows; never UPDATE a
 * doc). The tenant is taken from the document. Drafts get a provisional NEGATIVE version so they
 * satisfy the (tenant, version) PK without colliding with activated (positive) versions; activation
 * assigns the real version.
 */
export async function createDraft(pool: Pool, yamlText: string): Promise<DraftResult> {
  const parsed = parsePolicyYaml(yamlText); // throws PolicyValidationError on bad input
  const tenant = parsed.tenant;
  const draftId = ulid();
  const docHash = sha256Token(yamlText);
  await pool.query(
    `INSERT INTO policies (tenant_id, version, doc_yaml, doc_hash, status, draft_id)
     VALUES ($1, (SELECT COALESCE(MIN(version), 0) - 1 FROM policies WHERE tenant_id = $1),
             $2, $3, 'draft', $4)`,
    [tenant, yamlText, docHash, draftId],
  );
  return { draftId, tenant, parsed };
}

export interface ActivateResult {
  tenant: string;
  version: number;
  docHash: string;
  activatedEntryId: string;
}

/**
 * Activate a draft (SPEC 3.4): assign version = max positive + 1, retire the current active version,
 * write a POLICY_ACTIVATED ledger entry with the doc hash (D11), invalidate the cache. All in one
 * transaction so the version flip and the ledger entry commit together.
 */
export async function activateDraft(
  pool: Pool,
  store: PolicyStore,
  draftId: string,
): Promise<ActivateResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const draft = await client.query<{ tenant_id: string; doc_hash: string }>(
      "SELECT tenant_id, doc_hash FROM policies WHERE draft_id = $1 AND status = 'draft' FOR UPDATE",
      [draftId],
    );
    if (draft.rowCount === 0) throw new DraftNotFoundError(draftId);
    const tenant = draft.rows[0]!.tenant_id;
    const docHash = draft.rows[0]!.doc_hash;

    const next = await client.query<{ v: number }>(
      "SELECT COALESCE(MAX(version), 0) + 1 AS v FROM policies WHERE tenant_id = $1 AND version > 0",
      [tenant],
    );
    const version = Number(next.rows[0]!.v);

    await client.query(
      "UPDATE policies SET status = 'retired' WHERE tenant_id = $1 AND status = 'active'",
      [tenant],
    );
    await client.query(
      "UPDATE policies SET version = $1, status = 'active', activated_at = now() WHERE draft_id = $2",
      [version, draftId],
    );

    const entryId = ulid();
    await appendEntry(client, {
      tenant,
      kind: "POLICY_ACTIVATED",
      entryId,
      body: { policy_version: version, doc_hash: docHash },
    });

    await client.query("COMMIT");
    store.invalidate(tenant);
    return { tenant, version, docHash, activatedEntryId: entryId };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export class DraftNotFoundError extends Error {
  constructor(draftId: string) {
    super(`draft ${draftId} not found`);
    this.name = "DraftNotFoundError";
  }
}
