import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { getAppConfig } from '../config/app-config';

let dbInstance: Database.Database | null = null;

export function getDatabase(): Database.Database {
  if (dbInstance) return dbInstance;

  const { dbPath } = getAppConfig();
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  dbInstance = new Database(dbPath);
  dbInstance.pragma('journal_mode = WAL');
  dbInstance.pragma('foreign_keys = ON');
  dbInstance.pragma('busy_timeout = 5000');

  runMigrations(dbInstance);
  return dbInstance;
}

export function closeDatabase(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

function runMigrations(db: Database.Database): void {
  // Circuit breaker state is deliberately in-memory only: a restart should give a
  // failing provider a fresh chance, so there is no persisted breaker table.
  db.exec(`
    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      auth_type TEXT NOT NULL DEFAULT 'api-key',
      base_url TEXT NOT NULL,
      api_version TEXT,
      is_enabled INTEGER NOT NULL DEFAULT 1,
      is_built_in INTEGER NOT NULL DEFAULT 0,
      credential_status TEXT NOT NULL DEFAULT 'unconfigured',
      settings TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS models (
      id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      description TEXT,
      capabilities TEXT NOT NULL,
      pricing TEXT NOT NULL,
      rate_limits TEXT,
      status TEXT NOT NULL DEFAULT 'unknown',
      discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_checked_at TEXT,
      PRIMARY KEY (id, provider_id),
      FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS call_logs (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      task_type TEXT,
      status TEXT NOT NULL,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      error_message TEXT
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS quota_tracking (
      provider_id TEXT NOT NULL,
      model_id TEXT,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      request_count INTEGER NOT NULL DEFAULT 0,
      token_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (provider_id, model_id, period_start)
    );

    CREATE INDEX IF NOT EXISTS idx_models_provider ON models(provider_id);
    CREATE INDEX IF NOT EXISTS idx_models_status ON models(status);
    CREATE INDEX IF NOT EXISTS idx_call_logs_timestamp ON call_logs(timestamp);
    CREATE INDEX IF NOT EXISTS idx_call_logs_provider ON call_logs(provider_id);
  `);
}
