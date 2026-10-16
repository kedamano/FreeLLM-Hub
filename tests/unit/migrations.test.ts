import { describe, it, expect, beforeEach } from 'vitest';
import { openTestDatabase, type TestDatabase } from '../helpers/sqlite';
import {
  MIGRATIONS,
  CURRENT_SCHEMA_VERSION,
  getSchemaVersion,
  pendingMigrations,
  runMigrations,
} from '../../src/core/database/migrations';

// The migration runner is typed against better-sqlite3. These specs may run on the
// node:sqlite shim when the native binary does not match the vitest runtime, so the
// boundary is cast once here instead of repeating `as never` at every call site.
const migrate = (database: TestDatabase) => runMigrations(database as never);
const version = (database: TestDatabase) => getSchemaVersion(database as never);
const pending = (database: TestDatabase) => pendingMigrations(database as never);

function columns(database: TestDatabase, table: string): string[] {
  return (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (column) => column.name
  );
}

function tables(database: TestDatabase): string[] {
  return (
    database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
      name: string;
    }>
  ).map((row) => row.name);
}

let db: TestDatabase;

beforeEach(async () => {
  db = (await openTestDatabase()).db;
});

describe('versioned migrations', () => {
  it('numbers migrations contiguously and tracks the highest version', () => {
    const versions = MIGRATIONS.map((migration) => migration.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(new Set(versions).size).toBe(versions.length);
    expect(CURRENT_SCHEMA_VERSION).toBe(Math.max(...versions));
    expect(MIGRATIONS.every((migration) => migration.name.length > 0)).toBe(true);
  });

  it('creates the full schema on an empty database and records the version', () => {
    const result = migrate(db);
    expect(result.from).toBe(0);
    expect(result.to).toBe(CURRENT_SCHEMA_VERSION);
    expect(result.applied).toHaveLength(MIGRATIONS.length);
    expect(version(db)).toBe(CURRENT_SCHEMA_VERSION);

    for (const table of [
      'providers',
      'models',
      'call_logs',
      'settings',
      'quota_tracking',
      'credentials',
      'request_audit',
      'request_audit_events',
      'profiles',
      'oauth_flows',
    ]) {
      expect(tables(db)).toContain(table);
    }
  });

  it('adds the cost and audit columns call_logs needs without losing rows', () => {
    // Emulate a database created before column-level migrations existed.
    db.exec(`
      CREATE TABLE call_logs (
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
      INSERT INTO call_logs (id, request_id, provider_id, model_id, status)
      VALUES ('log-1', 'req-1', 'groq', 'llama-3.3', 'success');
      CREATE TABLE quota_tracking (
        provider_id TEXT NOT NULL,
        model_id TEXT,
        period_start TEXT NOT NULL,
        period_end TEXT NOT NULL,
        request_count INTEGER NOT NULL DEFAULT 0,
        token_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (provider_id, model_id, period_start)
      );
      INSERT INTO quota_tracking (provider_id, model_id, period_start, period_end, request_count, token_count)
      VALUES ('groq', '', '2026-10-16T00:00:00.000Z', '2026-10-17T00:00:00.000Z', 3, 900);
    `);

    migrate(db);

    expect(columns(db, 'call_logs')).toEqual(
      expect.arrayContaining([
        'profile_id',
        'status_code',
        'stream',
        'total_tokens',
        'attempt',
        'cost_usd',
        'reference_cost_usd',
        'saved_cost_usd',
        'pricing_type',
        'currency',
      ])
    );
    expect(db.prepare('SELECT id, stream, cost_usd FROM call_logs').get()).toEqual({
      id: 'log-1',
      stream: 0,
      cost_usd: 0,
    });

    // quota_tracking is rebuilt so profile_id can join the primary key.
    expect(columns(db, 'quota_tracking')).toEqual(
      expect.arrayContaining(['profile_id', 'provider_id', 'model_id', 'cost_usd'])
    );
    expect(db.prepare('SELECT * FROM quota_tracking').get()).toMatchObject({
      profile_id: 'default',
      provider_id: 'groq',
      model_id: '',
      request_count: 3,
      token_count: 900,
    });
  });

  it('is idempotent and only reports pending work once', () => {
    migrate(db);
    expect(pending(db)).toEqual([]);
    const second = migrate(db);
    expect(second.applied).toEqual([]);
    expect(second.to).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('runs each migration inside a transaction so a failure stops at the last good version', () => {
    db.exec("CREATE TABLE must_be_empty (id TEXT); INSERT INTO must_be_empty VALUES ('x')");
    expect(version(db)).toBe(0);
    expect(() => {
      for (const migration of MIGRATIONS) {
        migration.up(db as never);
        if (migration.version === CURRENT_SCHEMA_VERSION) {
          throw new Error('boom');
        }
      }
    }).toThrow('boom');
    // user_version is only bumped by runMigrations, never by a bare up() call.
    expect(version(db)).toBe(0);
  });

  it('resumes from the recorded version after an interrupted upgrade', () => {
    const half = Math.floor(MIGRATIONS.length / 2);
    for (const migration of MIGRATIONS.slice(0, half)) {
      migration.up(db as never);
      db.pragma(`user_version = ${migration.version}`);
    }
    expect(version(db)).toBe(half);

    const resumed = migrate(db);
    expect(resumed.from).toBe(half);
    expect(resumed.applied.map((migration) => migration.version)).toEqual(
      MIGRATIONS.slice(half).map((migration) => migration.version)
    );
    expect(version(db)).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('refuses to open a database newer than the running build', () => {
    migrate(db);
    db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION + 5}`);
    expect(() => migrate(db)).toThrow(/schema 版本/);
  });
});
