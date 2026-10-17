import type Database from 'better-sqlite3';

/**
 * Compiling a statement costs more than running it when the same SQL is prepared on
 * every call, which is what the per-request write path used to do (~10 prepares per
 * gateway request). Keyed by connection so a test's fresh in-memory database never
 * sees a statement prepared against another one.
 */
const caches = new WeakMap<Database.Database, Map<string, Database.Statement>>();

export function prepared(db: Database.Database, sql: string): Database.Statement {
  let bySql = caches.get(db);
  if (!bySql) {
    bySql = new Map();
    caches.set(db, bySql);
  }
  let statement = bySql.get(sql);
  if (!statement) {
    statement = db.prepare(sql);
    bySql.set(sql, statement);
  }
  return statement;
}
