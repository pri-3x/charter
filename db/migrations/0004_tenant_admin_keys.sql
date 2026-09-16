-- 0004_tenant_admin_keys.sql — admin FOR ONE TENANT, rather than admin for everything.
--
-- Until now there was exactly one admin credential: a shared secret in CHARTER_ADMIN_KEY that can
-- read every ledger, create agents anywhere, grant authority and register payment credentials. That
-- is the right shape for an operator and the wrong shape for everyone else — there was no way to let
-- someone try Charter without handing them the keys to the real tenant.
--
-- A tenant admin key is the same powers, bounded to one tenant. The binding is not advisory: the
-- gate pins the tenant on the request rather than checking a parameter, so a route that forgets to
-- check still cannot be pointed somewhere else (see requireAdmin in routes.ts).
--
-- Keys are stored as SHA-256 fingerprints, never raw, exactly like agent keys.

CREATE TABLE tenant_admin_keys (
  fingerprint  text PRIMARY KEY,                    -- sha256 of the raw key
  tenant_id    text NOT NULL REFERENCES tenants(id),
  label        text NOT NULL,                       -- who or what this was issued for
  status       text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REVOKED')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz
);
CREATE INDEX tenant_admin_keys_tenant ON tenant_admin_keys(tenant_id, status);

GRANT SELECT, INSERT, UPDATE ON tenant_admin_keys TO charter_gate;
