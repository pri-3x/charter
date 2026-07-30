-- Mandate POC schema (PostgreSQL 16). Applied by db/migrations/0001_init.sql (copy of this file).
-- Roles: mandate_gate (app), mandate_verifier (read-only). Create DB as superuser, then:

CREATE TABLE tenants (
  id            text PRIMARY KEY,              -- 'acme-fintech'
  name          text NOT NULL,
  approver_chat text,                          -- telegram chat id for escalations
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agents (
  id              text NOT NULL,               -- 'support-agent'
  tenant_id       text NOT NULL REFERENCES tenants(id),
  name            text NOT NULL,
  key_fingerprint text NOT NULL,               -- sha256 of API key
  max_autonomy    text NOT NULL DEFAULT 'ALLOW' CHECK (max_autonomy IN ('ALLOW','ESCALATE')),
  status          text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE UNIQUE INDEX agents_key_fp ON agents(key_fingerprint);

CREATE TABLE principals (
  id               text NOT NULL,              -- 'user:monty@acme.co'
  tenant_id        text NOT NULL REFERENCES tenants(id),
  display_name     text,
  telegram_user_id bigint,                     -- approver mapping
  roles            text[] NOT NULL DEFAULT '{}',  -- e.g. {finance-lead}
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX principals_tg ON principals(telegram_user_id);

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
                 ('VERDICT','APPROVAL','OUTCOME','POLICY_ACTIVATED','AGENT_SUSPENDED')),
  payload      jsonb  NOT NULL,                 -- full entry incl. chain fields (see SPEC 4.1)
  params_hash  text,
  prev_hash    text   NOT NULL,
  entry_hash   text   NOT NULL,
  ts           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, seq)
);
CREATE INDEX ledger_kind ON ledger_entries(tenant_id, kind);
CREATE INDEX ledger_ts   ON ledger_entries(tenant_id, ts);

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
-- CREATE ROLE mandate_gate LOGIN PASSWORD '...';
-- CREATE ROLE mandate_verifier LOGIN PASSWORD '...';
GRANT SELECT, INSERT ON ledger_entries, checkpoints TO mandate_gate;
GRANT SELECT, INSERT, UPDATE ON tenants, agents, principals, policies, ledger_seq,
  holds, limit_counters, idempotency_keys TO mandate_gate;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO mandate_verifier;
-- NOTE: no UPDATE/DELETE on ledger_entries/checkpoints for anyone but superuser;
-- the trigger blocks even superuser unless it disables the trigger (tamper tests do exactly
-- that deliberately: ALTER TABLE ledger_entries DISABLE TRIGGER ledger_no_update).
