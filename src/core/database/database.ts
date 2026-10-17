import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { getAppConfig } from '../config/app-config';
import {
  CURRENT_SCHEMA_VERSION,
  getSchemaVersion,
  runMigrations as runSchemaMigrations,
  type Migration,
} from './migrations';

export type { Migration };
export { CURRENT_SCHEMA_VERSION, getSchemaVersion, pendingMigrations } from './migrations';
export { runMigrations } from './migrations';

let dbInstance: Database.Database | null = null;

export function getDatabase(): Database.Database {
  if (dbInstance) return dbInstance;

  const { dbPath } = getAppConfig();
  const dir = dirname(dbPath);
  if (dbPath !== ':memory:' && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  dbInstance = new Database(dbPath);
  dbInstance.pragma('journal_mode = WAL');
  // WAL + NORMAL drops the per-commit fsync that dominated the gateway write path.
  // A process crash still loses nothing; only a power loss can discard recent commits.
  dbInstance.pragma('synchronous = NORMAL');
  dbInstance.pragma('journal_size_limit = 67108864');
  dbInstance.pragma('foreign_keys = ON');
  dbInstance.pragma('busy_timeout = 5000');

  migrateDatabase(dbInstance);
  return dbInstance;
}

/**
 * Bring a database up to `CURRENT_SCHEMA_VERSION`. Kept separate from
 * `getDatabase()` so tests (and the diagnostics panel) can migrate an in-memory
 * database with exactly the same code path production uses.
 */
export function migrateDatabase(
  db: Database.Database,
  options: { onMigrate?: (migration: Migration) => void } = {}
): ReturnType<typeof runSchemaMigrations> {
  return runSchemaMigrations(db, options);
}

export function closeDatabase(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

/** Identity of the schema currently on disk, for logs and the support panel. */
export function getDatabaseInfo(): { dbPath: string; schemaVersion: number; targetVersion: number } {
  const db = getDatabase();
  return {
    dbPath: getAppConfig().dbPath,
    schemaVersion: getSchemaVersion(db),
    targetVersion: CURRENT_SCHEMA_VERSION,
  };
}

/**
 * Create a throwaway database with the full current schema applied. Used by
 * integration tests so they exercise real SQLite instead of copied schema strings.
 */
export function createSchemaDatabase(dbPath = ':memory:'): Database.Database {
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  migrateDatabase(db);
  return db;
}
