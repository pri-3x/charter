-- Charter POC schema (PostgreSQL 16) — consolidated view of migrations 0001 + 0002.
-- The MIGRATIONS are what actually build a database (`npm run db:reset`); this file is the readable
-- current-state reference. Change the schema only by adding a numbered migration, then update here.
-- Roles: charter_gate (app), charter_verifier (read-only). Create DB as superuser, then:

CREATE TABLE tenants (
  id            text PRIMARY KEY,              -- 'acme-fintech'
  name          text NOT NULL,
  approver_chat text,                          -- telegram chat id for escalations
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- The REGISTRY (Charter §5.1): every agent is chartered — named human owner, department, an
-- approver chain, and a mandatory expiry. EXPIRED is derived from expires_at, never stored, so a
-- charter cannot outlive its date because a sweeper failed to run.
CREATE TABLE agents (
  id              text NOT NULL,               -- 'support-agent'
  tenant_id       text NOT NULL REFERENCES tenants(id),
  name            text NOT NULL,
  key_fingerprint text NOT NULL,               -- sha256 of API key
  max_autonomy    text NOT NULL DEFAULT 'ALLOW' CHECK (max_autonomy IN ('ALLOW','ESCALATE')),
  status          text NOT NULL DEFAULT 'ACTIVE'
                  CHECK (status IN ('ACTIVE','SUSPENDED','REVOKED')),
  owner_principal text,                        -- the accountable human (FK below)
  department      text,
  purpose         text,
  approver_chain  text[] NOT NULL DEFAULT '{}',-- default approvers for escalations
  expires_at      timestamptz,                 -- mandatory charter expiry
  registered_at   timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
-- owner_principal → principals FK is added after that table exists (see below).
CREATE UNIQUE INDEX agents_key_fp ON agents(key_fingerprint);

-- The AUTHORITY document (Charter §5.2): a versioned grant, not metadata. Immutable — a new grant
-- supersedes the previous version; revocation flips status and stamps the revoking ledger entry.
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
CREATE UNIQUE INDEX authorities_one_active ON authorities(tenant_id, agent_id)
  WHERE status = 'ACTIVE';
CREATE UNIQUE INDEX authorities_version ON authorities(tenant_id, agent_id, version);
CREATE INDEX authorities_agent ON authorities(tenant_id, agent_id, created_at DESC);

CREATE TABLE principals (
  id               text NOT NULL,              -- 'user:monty@acme.co'
  tenant_id        text NOT NULL REFERENCES tenants(id),
  display_name     text,
  telegram_user_id bigint,                     -- approver mapping
  roles            text[] NOT NULL DEFAULT '{}',  -- e.g. {finance-lead}
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX principals_tg ON principals(telegram_user_id);

-- Accountability is a named human: an agent's owner must be a real principal in the same tenant.
ALTER TABLE agents ADD CONSTRAINT agents_owner_fk
  FOREIGN KEY (tenant_id, owner_principal) REFERENCES principals(tenant_id, id);

CREATE TABLE policies (
  tenant_id    text NOT NULL REFERENCES tenants(id),
  version      int  NOT NULL,
  doc_yaml     text NOT NULL,
  doc_hash     text NOT NULL,
  status       text NOT NULL CHECK (status IN ('draft','active','retired')),
  draft_id     text,                            -- ULID for drafts
  activated_at timestamptz,
  PRIMARY KEY (tenant_id, version)
);
CREATE UNIQUE INDEX policies_one_active ON policies(tenant_id) WHERE status = 'active';

-- per-tenant sequence source (locked row per insert)
CREATE TABLE ledger_seq (
  tenant_id text PRIMARY KEY REFERENCES tenants(id),
  last_seq  bigint NOT NULL DEFAULT 0
);

CREATE TABLE ledger_entries (
  tenant_id    text   NOT NULL REFERENCES tenants(id),
  seq          bigint NOT NULL,
  entry_id     text   NOT NULL UNIQUE,          -- ULID
  kind         text   NOT NULL CHECK (kind IN
                 ('VERDICT','APPROVAL','OUTCOME','POLICY_ACTIVATED','AGENT_SUSPENDED',
                  'AGENT_REGISTERED','AGENT_REINSTATED','AUTHORITY_GRANTED','AUTHORITY_REVOKED')),
  payload      jsonb  NOT NULL,                 -- full entry incl. chain fields (see SPEC 4.1)
  params_hash  text,
  prev_hash    text   NOT NULL,
  entry_hash   text   NOT NULL,
  ts           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, seq)
);
CREATE INDEX ledger_kind ON ledger_entries(tenant_id, kind);
CREATE INDEX ledger_ts   ON ledger_entries(tenant_id, ts);

-- Pattern B credential custody (0003): Charter holds the tool secret so an agent that bypasses the
-- gate has nothing to bypass it with. The endpoint/method/scheme are ADMIN-registered — if a caller
-- could name the URL, this would be an SSRF proxy with production credentials attached.
CREATE TABLE tool_credentials (
  tenant_id     text NOT NULL REFERENCES tenants(id),
  tool          text NOT NULL,
  endpoint_url  text NOT NULL,
  method        text NOT NULL DEFAULT 'POST'
                  CHECK (method IN ('GET','POST','PUT','PATCH','DELETE')),
  auth_scheme   text NOT NULL CHECK (auth_scheme IN ('bearer','header','basic')),
  auth_header   text,
  secret_ct     bytea NOT NULL,           -- AES-256-GCM; plaintext never lands in a column or a log
  secret_iv     bytea NOT NULL,
  secret_tag    bytea NOT NULL,
  secret_fp     text  NOT NULL,           -- SHA-256 prefix: identifies the key without revealing it
  status        text  NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REVOKED')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz,
  registered_entry_id text NOT NULL,
  PRIMARY KEY (tenant_id, tool)
);
CREATE INDEX tool_credentials_status ON tool_credentials(tenant_id, status);

-- Admin scoped to ONE tenant (0004). The global CHARTER_ADMIN_KEY can read every ledger and act
-- anywhere; this is the same powers bounded to a single tenant, so someone can be given a real
-- console without being given the real tenant. The gate PINS the tenant on the request rather than
-- validating a parameter, so a route that forgets to check still cannot be redirected.
CREATE TABLE tenant_admin_keys (
  fingerprint  text PRIMARY KEY,
  tenant_id    text NOT NULL REFERENCES tenants(id),
  label        text NOT NULL,
  status       text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REVOKED')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz
);
CREATE INDEX tenant_admin_keys_tenant ON tenant_admin_keys(tenant_id, status);

-- idempotency cache for /actions/check
CREATE TABLE idempotency_keys (
  tenant_id  text NOT NULL,
  key        text NOT NULL,
  response   jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);

CREATE TABLE holds (
  id                 text PRIMARY KEY,          -- ULID
  tenant_id          text NOT NULL REFERENCES tenants(id),
  verdict_entry_id   text NOT NULL REFERENCES ledger_entries(entry_id),
  status             text NOT NULL DEFAULT 'PENDING'
                     CHECK (status IN ('PENDING','APPROVED','REJECTED','EXPIRED')),
  approvers_snapshot jsonb NOT NULL,            -- resolved principal ids at creation
  initiating_principal text NOT NULL,
  ttl_at             timestamptz NOT NULL,
  decided_by         text,
  decided_at         timestamptz,
  telegram_message   jsonb,                     -- chat_id + message_id for editing
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX holds_pending ON holds(status, ttl_at) WHERE status = 'PENDING';

CREATE TABLE limit_counters (
  tenant_id    text NOT NULL,
  rule_id      text NOT NULL,
  key          text NOT NULL,                   -- 'agent:support-agent' | 'principal:user:x'
  window_start timestamptz NOT NULL,            -- 1-minute buckets
  event_count  bigint NOT NULL DEFAULT 0,
  event_sum    bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, rule_id, key, window_start)
);

CREATE TABLE checkpoints (
  id          text PRIMARY KEY,                 -- ULID
  tenant_id   text NOT NULL REFERENCES tenants(id),
  seq_from    bigint NOT NULL,
  seq_to      bigint NOT NULL,
  merkle_root text NOT NULL,
  signature   text NOT NULL,                    -- base64 Ed25519 over JCS payload (D5)
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX checkpoints_range ON checkpoints(tenant_id, seq_from, seq_to);

-- ===== append-only enforcement =====
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'ledger is append-only (%.%)', TG_TABLE_NAME, TG_OP; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_no_update BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER checkpoints_no_update BEFORE UPDATE OR DELETE ON checkpoints
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ===== roles =====
-- run as superuser; passwords via env in docker compose init
-- CREATE ROLE charter_gate LOGIN PASSWORD '...';
-- CREATE ROLE charter_verifier LOGIN PASSWORD '...';
GRANT SELECT, INSERT ON ledger_entries, checkpoints TO charter_gate;
GRANT SELECT, INSERT, UPDATE ON tenants, agents, principals, policies, ledger_seq,
  holds, limit_counters, idempotency_keys, authorities, tool_credentials,
  tenant_admin_keys TO charter_gate;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO charter_verifier;
-- NOTE: no UPDATE/DELETE on ledger_entries/checkpoints for anyone but superuser;
-- the trigger blocks even superuser unless it disables the trigger (tamper tests do exactly
-- that deliberately: ALTER TABLE ledger_entries DISABLE TRIGGER ledger_no_update).
