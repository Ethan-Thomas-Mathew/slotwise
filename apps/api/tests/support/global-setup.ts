import pg from 'pg';
import './env';
import { migrateToLatest } from '../../src/db/migrate';

/**
 * Runs once before all tests: recreates the `slotwise_test` database from
 * scratch and applies every migration, so each test run starts clean.
 */
export default async function setup() {
  const ownerUrl = new URL(process.env.MIGRATION_DATABASE_URL!);
  const dbName = ownerUrl.pathname.slice(1);
  const adminUrl = new URL(ownerUrl);
  adminUrl.pathname = '/postgres';

  const client = new pg.Client({ connectionString: adminUrl.toString() });
  await client.connect();
  await client.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await client.query(`CREATE DATABASE ${dbName}`);
  await client.end();

  await migrateToLatest(ownerUrl.toString());
}
