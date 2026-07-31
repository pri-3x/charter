-- 0002_registry_authority.sql — Charter Registry (§5.1) + Authority documents (§5.2).
--
-- Two new first-class objects sit in FRONT of the policy engine:
--   * the CHARTER on an agent   — named human owner, department, mandatory expiry
--   * the AUTHORITY document    — a versioned grant: who granted it, for how long, what budget,
--                                 which tools, which operations are forbidden outright
-- The gate consults both BEFORE the policy and fails closed on anything missing or expired.
-- Both are ledger-evidenced: AGENT_REGISTERED / AUTHORITY_GRANTED / AUTHORITY_REVOKED.

-- ===== registry fields on agents =====
ALTER TABLE agents ADD COLUMN owner_principal text;
ALTER TABLE agents ADD COLUMN department      text;
ALTER TABLE agents ADD COLUMN purpose         text;
ALTER TABLE agents ADD COLUMN approver_chain  text[] NOT NULL DEFAULT '{}';
-- Mandatory expiry (Charter §5.1: "a mandatory expiry date"). Nullable only so existing rows can be
-- backfilled by the seed; the register endpoint requires it.
ALTER TABLE agents ADD COLUMN expires_at      timestamptz;
ALTER TABLE agents ADD COLUMN registered_at   timestamptz NOT NULL DEFAULT now();

-- An owner must be a real principal in the same tenant — accountability is a named human.
ALTER TABLE agents ADD CONSTRAINT agents_owner_fk
  FOREIGN KEY (tenant_id, owner_principal) REFERENCES principals(tenant_id, id);

-- REVOKED joins ACTIVE/SUSPENDED. EXPIRED is NOT a stored status: it is derived from expires_at, so
-- a charter cannot silently outlive its date because a sweeper failed to run (fail closed by design).
ALTER TABLE agents DROP CONSTRAINT agents_status_check;
ALTER TABLE agents ADD CONSTRAINT agents_status_check
  CHECK (status IN ('ACTIVE','SUSPENDED','REVOKED'));

-- ===== authority documents =====
-- Immutable rows. A new grant supersedes the previous version; revocation only flips status +
-- stamps the revoking entry. Never UPDATE the substance of a grant (same discipline as policies).
CREATE TABLE authorities (
  id                text PRIMARY KEY,               -- ULID
  ref               text NOT NULL,                  -- human ref, e.g. 'auth_2026_0071'
  tenant_id         text NOT NULL REFERENCES tenants(id),
  agent_id          text NOT NULL,
  version           int  NOT NULL,
  grantor_principal text NOT NULL,                  -- the named human who issued it
  valid_from        timestamptz NOT NULL,
  valid_until       timestamptz NOT NULL,
  budget_minor      bigint,                         -- NULL = no spend ceiling in the grant
  budget_currency   text NOT NULL DEFAULT 'INR',
  budget_window_minutes int NOT NULL DEFAULT 1440,  -- 'Rs 1,00,000 / day'
  allowed_tools     text[] NOT NULL DEFAULT '{}',
  forbidden_ops     text[] NOT NULL DEFAULT '{}',   -- hard DENY even if policy would allow
  status            text NOT NULL DEFAULT 'ACTIVE'
                    CHECK (status IN ('ACTIVE','REVOKED','SUPERSEDED')),
  doc               jsonb NOT NULL,                 -- canonical grant document (hashed)
  doc_hash          text  NOT NULL,                 -- sha256 of JCS(doc)
  granted_entry_id  text  NOT NULL,                 -- AUTHORITY_GRANTED ledger entry
  revoked_entry_id  text,
  revoked_by        text,
  revoked_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, agent_id) REFERENCES agents(tenant_id, id)
);
-- At most one live grant per agent, and versions are unique per agent.
CREATE UNIQUE INDEX authorities_one_active ON authorities(tenant_id, agent_id)
  WHERE status = 'ACTIVE';
CREATE UNIQUE INDEX authorities_version ON authorities(tenant_id, agent_id, version);
CREATE INDEX authorities_agent ON authorities(tenant_id, agent_id, created_at DESC);

-- ===== new ledger kinds =====
ALTER TABLE ledger_entries DROP CONSTRAINT ledger_entries_kind_check;
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_kind_check
  CHECK (kind IN ('VERDICT','APPROVAL','OUTCOME','POLICY_ACTIVATED','AGENT_SUSPENDED',
                  'AGENT_REGISTERED','AGENT_REINSTATED','AUTHORITY_GRANTED','AUTHORITY_REVOKED'));

-- ===== grants (new table is not covered by the 0001 grants) =====
GRANT SELECT, INSERT, UPDATE ON authorities TO charter_gate;
GRANT SELECT ON authorities TO charter_verifier;
