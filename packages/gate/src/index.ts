export { buildApp } from "./app.js";
export type { BuildDeps } from "./app.js";
export { makePool, dbReachable } from "./db.js";
export type { Pool, PoolClient } from "./db.js";
export { loadConfig } from "./config.js";
export type { GateConfig } from "./config.js";
export { appendEntry } from "./ledger.js";
export { PolicyStore } from "./policy/store.js";
export { parsePolicyYaml, PolicyValidationError } from "./policy/schema.js";
export type { PolicyDoc, Rule } from "./policy/schema.js";
export { matchRules, resolveVerdict } from "./policy/evaluate.js";
export { createDraft, activateDraft } from "./policy/activate.js";
export { decideHold, expireHolds } from "./holds-resolve.js";
export { suspendAgent } from "./suspend.js";
export { loadSigner, makeAnchorAppender, createPendingCheckpoint } from "./checkpoint.js";
export type { Signer, Checkpoint } from "./checkpoint.js";
export { leafFromEntryHash, merkleRootHex, merkleProof } from "./merkle.js";
export {
  registerAgent,
  grantAuthority,
  revokeAuthority,
  reinstateAgent,
  listRegistry,
  listAuthorities,
  loadCharter,
  charterStatus,
} from "./registry/store.js";
export type { AuthorityRow, CharterContext, RegistryCard } from "./registry/store.js";
export { evaluateAuthority, fetchAuthoritySpend, actionAmount } from "./registry/authority.js";
export type { AuthorityDecision } from "./registry/authority.js";
export {
  buildAttestationPack,
  computePackHash,
  renderAttestationHtml,
  TenantNotFoundError,
  uncoveredRanges,
} from "./attestation/index.js";
export type { AttestationPack, BuildAttestationOptions } from "./attestation/types.js";
export { registerStreamRoute } from "./stream.js";
