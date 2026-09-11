-- 0003_credential_custody.sql — Pattern B: Charter holds the tool credential (SPEC §7, D1).
--
-- Under Pattern A the agent holds the real tool function, and that function holds the secret. The
-- gate is therefore advisory: an agent that simply never calls Charter is not governed by it, which
-- is what TEST_PLAN A4 demonstrates. Pattern A is not removed — it stays the easy on-ramp — but it
-- cannot be the whole story for money.
--
-- Pattern B moves the secret behind the gate. The agent is given a tool NAME, never a key; Charter
-- stores the credential encrypted, evaluates the action exactly as it would for /v1/actions/check,
-- and only then makes the outbound call itself. An agent that skips Charter now has nothing to skip
-- Charter WITH: it holds no credential, so the bypass does not merely get logged, it fails.
--
-- What is deliberately NOT stored here: anything the caller supplies. The endpoint, method and auth
-- scheme are registered by an ADMIN, once. If the agent could name the URL, Charter would be an
-- SSRF proxy that helpfully attaches production credentials to whatever it was pointed at.

CREATE TABLE tool_credentials (
  tenant_id     text NOT NULL REFERENCES tenants(id),
  tool          text NOT NULL,

  -- ===== egress descriptor: operator-supplied, never agent-supplied =====
  endpoint_url  text NOT NULL,
  method        text NOT NULL DEFAULT 'POST'
                  CHECK (method IN ('GET','POST','PUT','PATCH','DELETE')),
  -- how the secret is presented to the upstream tool
  auth_scheme   text NOT NULL CHECK (auth_scheme IN ('bearer','header','basic')),
  auth_header   text,  -- header name when auth_scheme = 'header' (e.g. 'X-Api-Key')

  -- ===== the secret, AES-256-GCM =====
  -- Split across three columns rather than one blob so a partial read is useless and so the tag is
  -- unmistakably authenticated data rather than something a later migration might "optimise" away.
  secret_ct     bytea NOT NULL,
  secret_iv     bytea NOT NULL,
  secret_tag    bytea NOT NULL,
  -- SHA-256 of the plaintext, truncated. Lets an operator confirm WHICH key is installed, and lets
  -- a rotation be evidenced in the ledger, without the ledger ever containing the secret.
  secret_fp     text NOT NULL,

  status        text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REVOKED')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz,
  -- the CREDENTIAL_REGISTERED entry that put this row here
  registered_entry_id text NOT NULL,

  PRIMARY KEY (tenant_id, tool)
);

CREATE INDEX tool_credentials_status ON tool_credentials(tenant_id, status);

-- Registration and revocation are ledger events like everything else: an auditor asking "when did
-- Charter start holding the payment key, and who put it there?" gets an answer from the same chain
-- as every verdict. The entries carry the fingerprint, never the secret.
ALTER TABLE ledger_entries DROP CONSTRAINT ledger_entries_kind_check;
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_kind_check CHECK (kind IN
  ('VERDICT','APPROVAL','OUTCOME','POLICY_ACTIVATED','AGENT_SUSPENDED',
   'AGENT_REGISTERED','AGENT_REINSTATED','AUTHORITY_GRANTED','AUTHORITY_REVOKED',
   'CREDENTIAL_REGISTERED','CREDENTIAL_REVOKED'));

GRANT SELECT, INSERT, UPDATE ON tool_credentials TO charter_gate;
