import type Database from 'better-sqlite3';

/**
 * Versioned SQLite migrations.
 *
 * The database schema used to live in a single `CREATE TABLE IF NOT EXISTS` blob,
 * which is fine while every change is additive-table only: an `ALTER TABLE ADD
 * COLUMN` wrapped in `IF NOT EXISTS` semantics does not exist in SQLite, so a
 * re-run silently does nothing on an existing database and existing installs never
 * get the new column. Every schema change from now on is an ordered migration
 * recorded in `PRAGMA user_version`, so upgrading a user's database is explicit.
 *
 * Rules for adding a migration:
 * - append it, never edit or reorder an already-released version;
 * - a migration must be safe to run against a database created by any older
 *   released version (use the `addColumnIfMissing` / `IF NOT EXISTS` helpers);
 * - anything that changes a PRIMARY KEY needs a table rebuild (see v5).
 */
export interface Migration {
  version: number;
  name: string;
  up: (db: Database.Database) => void;
}

interface TableColumn {
  name: string;
}

/** Read the schema version stored in `PRAGMA user_version` (0 = never migrated). */
export function getSchemaVersion(db: Database.Database): number {
  const value = db.pragma('user_version', { simple: true });
  return typeof value === 'number' ? value : Number(value) || 0;
}

export function setSchemaVersion(db: Database.Database, version: number): void {
  db.pragma(`user_version = ${Math.trunc(version)}`);
}

/** Add a column only when it is absent, so re-running a migration is harmless. */
export function addColumnIfMissing(
  db: Database.Database,
  table: string,
  column: string,
  definition: string
): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as TableColumn[];
  if (columns.some((entry) => entry.name === column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return true;
}

const BASELINE_SQL = `
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
`;

/**
 * The encrypted credential rows are created by `CredentialStore` on first use, so
 * the baseline keeps its own copy. Materialising the table here as well means a
 * freshly migrated database already has every table, which lets integration tests
 * run against real SQLite instead of hand-copied schema strings.
 */
const CREDENTIALS_SQL = `
    CREATE TABLE IF NOT EXISTS credentials (
      id TEXT PRIMARY KEY,
      encrypted_value TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
`;

const REQUEST_AUDIT_SQL = `
    -- One row per gateway-facing request: the terminal audit record.
    CREATE TABLE IF NOT EXISTS request_audit (
      request_id TEXT PRIMARY KEY,
      profile_id TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      route TEXT NOT NULL,
      method TEXT NOT NULL DEFAULT 'POST',
      stream INTEGER NOT NULL DEFAULT 0,
      requested_model TEXT,
      task_type TEXT,
      status TEXT NOT NULL,
      status_code INTEGER,
      provider_id TEXT,
      model_id TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      time_to_first_token_ms INTEGER,
      error_code TEXT,
      error_message TEXT,
      params TEXT,
      client_address TEXT,
      credential_source TEXT
    );

    -- Ordered lifecycle trail for a single request (why each candidate lost).
    CREATE TABLE IF NOT EXISTS request_audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      at TEXT NOT NULL DEFAULT (datetime('now')),
      event TEXT NOT NULL,
      provider_id TEXT,
      model_id TEXT,
      attempt INTEGER,
      status TEXT,
      status_code INTEGER,
      reason TEXT,
      duration_ms INTEGER,
      detail TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_request_audit_started ON request_audit(started_at);
    CREATE INDEX IF NOT EXISTS idx_request_audit_status ON request_audit(status);
    CREATE INDEX IF NOT EXISTS idx_request_audit_provider ON request_audit(provider_id);
    CREATE INDEX IF NOT EXISTS idx_audit_events_request ON request_audit_events(request_id);
    CREATE INDEX IF NOT EXISTS idx_audit_events_at ON request_audit_events(at);
`;

const PROFILES_SQL = `
    CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      is_default INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 0,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_single_active ON profiles(is_active) WHERE is_active = 1;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_single_default ON profiles(is_default) WHERE is_default = 1;
`;

/**
 * Per-profile usage buckets need `profile_id` inside the primary key, which SQLite
 * cannot express with ALTER TABLE, so the table is rebuilt in place.
 */
function rebuildQuotaTrackingWithProfile(db: Database.Database): void {
  const columns = db.prepare('PRAGMA table_info(quota_tracking)').all() as TableColumn[];
  if (columns.some((column) => column.name === 'profile_id')) return;

  db.exec(`
    CREATE TABLE quota_tracking_next (
      profile_id TEXT NOT NULL DEFAULT 'default',
      provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL DEFAULT '',
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      request_count INTEGER NOT NULL DEFAULT 0,
      token_count INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (profile_id, provider_id, model_id, period_start)
    );

    INSERT OR IGNORE INTO quota_tracking_next
      (profile_id, provider_id, model_id, period_start, period_end, request_count, token_count)
    SELECT 'default', provider_id, COALESCE(model_id, ''), period_start, period_end, request_count, token_count
    FROM quota_tracking;

    DROP TABLE quota_tracking;
    ALTER TABLE quota_tracking_next RENAME TO quota_tracking;
    CREATE INDEX IF NOT EXISTS idx_quota_tracking_period ON quota_tracking(period_start);
  `);
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'baseline-schema',
    up: (db) => {
      db.exec(BASELINE_SQL);
    },
  },
  {
    version: 2,
    name: 'credentials-table',
    up: (db) => {
      db.exec(CREDENTIALS_SQL);
    },
  },
  {
    version: 3,
    name: 'gateway-request-audit',
    up: (db) => {
      db.exec(REQUEST_AUDIT_SQL);
      addColumnIfMissing(db, 'call_logs', 'profile_id', 'TEXT');
      addColumnIfMissing(db, 'call_logs', 'status_code', 'INTEGER');
      addColumnIfMissing(db, 'call_logs', 'stream', 'INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing(db, 'call_logs', 'total_tokens', 'INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing(db, 'call_logs', 'attempt', 'INTEGER NOT NULL DEFAULT 1');
      db.exec('CREATE INDEX IF NOT EXISTS idx_call_logs_request ON call_logs(request_id);');
    },
  },
  {
    version: 4,
    name: 'cost-ledger',
    up: (db) => {
      addColumnIfMissing(db, 'call_logs', 'cost_usd', 'REAL NOT NULL DEFAULT 0');
      addColumnIfMissing(db, 'call_logs', 'reference_cost_usd', 'REAL NOT NULL DEFAULT 0');
      addColumnIfMissing(db, 'call_logs', 'saved_cost_usd', 'REAL NOT NULL DEFAULT 0');
      addColumnIfMissing(db, 'call_logs', 'pricing_type', 'TEXT');
      addColumnIfMissing(db, 'call_logs', 'currency', "TEXT NOT NULL DEFAULT 'USD'");
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_call_logs_model ON call_logs(model_id);
        CREATE INDEX IF NOT EXISTS idx_call_logs_status ON call_logs(status);
        CREATE INDEX IF NOT EXISTS idx_call_logs_profile ON call_logs(profile_id);
      `);
    },
  },
  {
    version: 5,
    name: 'config-profiles',
    up: (db) => {
      db.exec(PROFILES_SQL);
      rebuildQuotaTrackingWithProfile(db);
      addColumnIfMissing(db, 'quota_tracking', 'cost_usd', 'REAL NOT NULL DEFAULT 0');
      addColumnIfMissing(db, 'request_audit', 'cost_usd', 'REAL NOT NULL DEFAULT 0');
      addColumnIfMissing(db, 'request_audit', 'saved_cost_usd', 'REAL NOT NULL DEFAULT 0');
      db.exec('CREATE INDEX IF NOT EXISTS idx_request_audit_profile ON request_audit(profile_id);');
    },
  },
  {
    version: 6,
    name: 'oauth-credentials',
    up: (db) => {
      addColumnIfMissing(db, 'credentials', 'kind', "TEXT NOT NULL DEFAULT 'api-key'");
      addColumnIfMissing(db, 'credentials', 'provider_id', 'TEXT');
      addColumnIfMissing(db, 'credentials', 'token_type', 'TEXT');
      addColumnIfMissing(db, 'credentials', 'scope', 'TEXT');
      addColumnIfMissing(db, 'credentials', 'expires_at', 'TEXT');
      addColumnIfMissing(db, 'credentials', 'refreshable', 'INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing(db, 'credentials', 'status', "TEXT NOT NULL DEFAULT 'active'");
      addColumnIfMissing(db, 'credentials', 'last_refreshed_at', 'TEXT');
      addColumnIfMissing(db, 'credentials', 'label', 'TEXT');
      db.exec(`
        CREATE TABLE IF NOT EXISTS oauth_flows (
          state TEXT PRIMARY KEY,
          provider_id TEXT NOT NULL,
          profile_id TEXT,
          code_verifier TEXT NOT NULL,
          redirect_uri TEXT NOT NULL,
          client_id TEXT,
          scopes TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          error TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          expires_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_oauth_flows_provider ON oauth_flows(provider_id);
        CREATE INDEX IF NOT EXISTS idx_oauth_credentials_expiry ON credentials(expires_at);
        CREATE INDEX IF NOT EXISTS idx_oauth_credentials_provider ON credentials(provider_id);
      `);
    },
  },
];

export const CURRENT_SCHEMA_VERSION = MIGRATIONS.reduce(
  (highest, migration) => Math.max(highest, migration.version),
  0
);

/** Migrations that would run on the given database, without applying them. */
export function pendingMigrations(db: Database.Database): Migration[] {
  const current = getSchemaVersion(db);
  return MIGRATIONS.filter((migration) => migration.version > current).sort(
    (a, b) => a.version - b.version
  );
}

/**
 * Apply every migration newer than `PRAGMA user_version`, each inside its own
 * transaction so a failure leaves the database at the last good version.
 */
export function runMigrations(
  db: Database.Database,
  options: { onMigrate?: (migration: Migration) => void } = {}
): { from: number; to: number; applied: Migration[] } {
  const from = getSchemaVersion(db);
  if (from > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `数据库 schema 版本 ${from} 高于当前程序支持的 ${CURRENT_SCHEMA_VERSION}，请升级 FreeLLM Hub 后再打开该数据目录。`
    );
  }

  const applied: Migration[] = [];
  for (const migration of pendingMigrations(db)) {
    db.transaction(() => {
      migration.up(db);
      setSchemaVersion(db, migration.version);
    })();
    applied.push(migration);
    options.onMigrate?.(migration);
  }

  return { from, to: getSchemaVersion(db), applied };
}
