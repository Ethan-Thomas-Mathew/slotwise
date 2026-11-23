-- Creates the database roles Slotwise needs. Runs once as the Postgres superuser.
--
-- Two roles, on purpose:
--   slotwise_owner : owns the tables and runs migrations.
--   slotwise_app   : what the running API connects as. It does NOT own any table,
--                    so Row-Level Security always applies to it.
-- (A table's owner skips RLS unless FORCE ROW LEVEL SECURITY is set. We do both.)

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'slotwise_owner') THEN
    CREATE ROLE slotwise_owner LOGIN PASSWORD 'owner_password' CREATEDB;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'slotwise_app') THEN
    CREATE ROLE slotwise_app LOGIN PASSWORD 'app_password' NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;

-- Every table/sequence the owner creates is automatically usable by the app role.
ALTER DEFAULT PRIVILEGES FOR ROLE slotwise_owner
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO slotwise_app;
ALTER DEFAULT PRIVILEGES FOR ROLE slotwise_owner
  GRANT USAGE, SELECT ON SEQUENCES TO slotwise_app;
ALTER DEFAULT PRIVILEGES FOR ROLE slotwise_owner
  GRANT EXECUTE ON FUNCTIONS TO slotwise_app;

SELECT 'CREATE DATABASE slotwise OWNER slotwise_owner'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'slotwise')\gexec
