-- Runs once at container init (before migrations). Creates the two app roles the schema GRANTs to.
-- Passwords match env.example DATABASE_URL / VERIFIER_DATABASE_URL.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mandate_gate') THEN
    CREATE ROLE mandate_gate LOGIN PASSWORD 'gatepass';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mandate_verifier') THEN
    CREATE ROLE mandate_verifier LOGIN PASSWORD 'verifypass';
  END IF;
END
$$;

-- Both roles need to connect to the mandate db and use the public schema.
GRANT CONNECT ON DATABASE mandate TO mandate_gate, mandate_verifier;
GRANT USAGE ON SCHEMA public TO mandate_gate, mandate_verifier;
