CREATE SCHEMA IF NOT EXISTS scholarship_private;
REVOKE ALL ON SCHEMA scholarship_private FROM PUBLIC;
CREATE TABLE IF NOT EXISTS scholarship_private.schema_migrations (version INTEGER PRIMARY KEY);
CREATE TABLE IF NOT EXISTS scholarship_private.chapters (workspace TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS scholarship_private.members (workspace TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('chair','member')), tier INTEGER, credits DOUBLE PRECISION, active INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(workspace,id));
CREATE TABLE IF NOT EXISTS scholarship_private.identities (workspace TEXT NOT NULL, provider TEXT NOT NULL, subject TEXT NOT NULL, member_id TEXT NOT NULL, PRIMARY KEY(workspace,provider,subject), FOREIGN KEY(workspace,member_id) REFERENCES scholarship_private.members(workspace,id));
CREATE TABLE IF NOT EXISTS scholarship_private.sessions (id TEXT PRIMARY KEY, workspace TEXT NOT NULL, member_id TEXT NOT NULL, csrf TEXT NOT NULL, expires BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS scholarship_private.transactions (id TEXT PRIMARY KEY, kind TEXT NOT NULL, session_id TEXT, data TEXT NOT NULL, expires BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS scholarship_private.uploads (id TEXT PRIMARY KEY, workspace TEXT NOT NULL, owner TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, size BIGINT NOT NULL, filename TEXT NOT NULL, created_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ready', backend TEXT NOT NULL DEFAULT 'local', final_path TEXT);
CREATE TABLE IF NOT EXISTS scholarship_private.integrations (workspace TEXT NOT NULL, member_id TEXT NOT NULL, data TEXT NOT NULL, revision TEXT NOT NULL, PRIMARY KEY(workspace,member_id));
CREATE TABLE IF NOT EXISTS scholarship_private.canvas_generations (workspace TEXT NOT NULL, member_id TEXT NOT NULL, generation TEXT NOT NULL, PRIMARY KEY(workspace,member_id));
CREATE TABLE IF NOT EXISTS scholarship_private.canvas_leases (workspace TEXT NOT NULL, member_id TEXT NOT NULL, owner TEXT NOT NULL, expires BIGINT NOT NULL, PRIMARY KEY(workspace,member_id));
CREATE TABLE IF NOT EXISTS scholarship_private.audit (id BIGSERIAL PRIMARY KEY, workspace TEXT NOT NULL, at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, subject TEXT NOT NULL, detail TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS sessions_expiry ON scholarship_private.sessions(expires);
CREATE INDEX IF NOT EXISTS audit_workspace ON scholarship_private.audit(workspace,id);
-- The portal uses the owning postgres connection; browser roles have no policies.
-- RLS is an additional deny-by-default guard if the schema is ever exposed.
ALTER TABLE scholarship_private.schema_migrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE scholarship_private.chapters ENABLE ROW LEVEL SECURITY;
ALTER TABLE scholarship_private.members ENABLE ROW LEVEL SECURITY;
ALTER TABLE scholarship_private.identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE scholarship_private.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE scholarship_private.transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE scholarship_private.uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE scholarship_private.integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE scholarship_private.canvas_generations ENABLE ROW LEVEL SECURITY;
ALTER TABLE scholarship_private.canvas_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE scholarship_private.audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA scholarship_private FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA scholarship_private FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA scholarship_private REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA scholarship_private REVOKE ALL ON SEQUENCES FROM PUBLIC;
DO $$
DECLARE role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA scholarship_private FROM %I',role_name);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA scholarship_private FROM %I',role_name);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA scholarship_private FROM %I',role_name);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA scholarship_private REVOKE ALL ON TABLES FROM %I',role_name);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA scholarship_private REVOKE ALL ON SEQUENCES FROM %I',role_name);
    END IF;
  END LOOP;
END $$;
INSERT INTO scholarship_private.chapters(workspace,data) VALUES ('chapter','{"submissions":[]}') ON CONFLICT(workspace) DO NOTHING;
INSERT INTO scholarship_private.schema_migrations(version) VALUES (1) ON CONFLICT DO NOTHING;
