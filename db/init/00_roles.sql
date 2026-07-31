-- Runs once at container init (before migrations). Creates the two app roles the schema GRANTs to.
-- Passwords match env.example DATABASE_URL / VERIFIER_DATABASE_URL.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'charter_gate') THEN
    CREATE ROLE charter_gate LOGIN PASSWORD 'gatepass';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'charter_verifier') THEN
    CREATE ROLE charter_verifier LOGIN PASSWORD 'verifypass';
  END IF;
END
$$;

-- Both roles need to connect to the charter db and use the public schema.
GRANT CONNECT ON DATABASE charter TO charter_gate, charter_verifier;
GRANT USAGE ON SCHEMA public TO charter_gate, charter_verifier;
