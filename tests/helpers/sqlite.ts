import { createRequire } from 'node:module';

/**
 * Test database factory.
 *
 * `better-sqlite3` is a native module: when a developer has run `npm run rebuild:electron`
 * the binary in `node_modules` matches the Electron ABI and cannot be loaded by the Node
 * that vitest runs on. Without a fallback the whole SQLite-backed suite silently skips,
 * which means the specs nobody just ran are effectively untested.
 *
 * So: use better-sqlite3 when it loads, otherwise drive the same API surface on top of
 * Node's built-in `node:sqlite`. The shim covers exactly what the code under test uses
 * (`prepare().get/all/run`, `exec`, `pragma`, `transaction`) and returns plain objects.
 */
export interface TestDatabase {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  };
  exec(sql: string): void;
  pragma(sql: string, options?: { simple?: boolean }): unknown;
  transaction<T>(fn: () => T): (() => T) & {
    deferred(): T;
    immediate(): T;
    exclusive(): T;
  };
  close(): void;
}

type NativeDatabase = TestDatabase;

let betterSqlite: (new (path: string) => NativeDatabase) | null | undefined;

function loadBetterSqlite() {
  if (betterSqlite !== undefined) return betterSqlite;
  try {
    const require = createRequire(import.meta.url);
    const Database = require('better-sqlite3') as new (path: string) => NativeDatabase;
    const probe = new Database(':memory:');
    probe.close();
    betterSqlite = Database;
  } catch {
    betterSqlite = null;
  }
  return betterSqlite;
}

/** Plain objects, because node:sqlite hands back null-prototype rows. */
function plain<T>(row: T): T {
  if (row === null || typeof row !== 'object') return row;
  return { ...(row as Record<string, unknown>) } as T;
}

function wrapNodeSqlite(raw: {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  };
  exec(sql: string): void;
  close(): void;
}): TestDatabase {
  const statementCache = new Map<
    string,
    ReturnType<typeof raw.prepare>
  >();

  const statement = (sql: string) => {
    let cached = statementCache.get(sql);
    if (!cached) {
      cached = raw.prepare(sql);
      statementCache.set(sql, cached);
    }
    return cached;
  };

  const toParam = (value: unknown) => (value === undefined ? null : value);

  return {
    prepare: (sql) => ({
      get: (...params) => plain(statement(sql).get(...params.map(toParam))) ?? undefined,
      all: (...params) => statement(sql).all(...params.map(toParam)).map((row) => plain(row)),
      run: (...params) => {
        const result = statement(sql).run(...params.map(toParam));
        return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
      },
    }),
    exec: (sql) => raw.exec(sql),
    pragma: (sql, options) => {
      if (options?.simple) {
        const row = raw.prepare(`PRAGMA ${sql}`).get();
        if (!row) return undefined;
        return Object.values(row)[0];
      }
      raw.exec(`PRAGMA ${sql}`);
      return undefined;
    },
    transaction: (fn) => {
      const run = (begin: string): unknown => {
        raw.exec(begin);
        try {
          // better-sqlite3 returns the callback's value from the wrapped transaction.
          const result = fn();
          raw.exec('COMMIT');
          return result;
        } catch (err) {
          try {
            raw.exec('ROLLBACK');
          } catch {
            /* the transaction may already have been aborted by SQLite */
          }
          throw err;
        }
      };
      // better-sqlite3 hands back a callable with the three lock modes attached.
      const transaction = Object.assign(() => run('BEGIN'), {
        deferred: () => run('BEGIN DEFERRED'),
        immediate: () => run('BEGIN IMMEDIATE'),
        exclusive: () => run('BEGIN EXCLUSIVE'),
      });
      return transaction;
    },
    close: () => raw.close(),
  };
}

function createNodeSqliteDatabase(): TestDatabase | null {
  try {
    // Required rather than imported: Vite's module runner rewrites bare `node:` imports
    // and can fail to resolve the newer builtins, while `require` reaches the real one.
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require('node:sqlite') as {
      DatabaseSync: new (path: string) => {
        prepare(sql: string): {
          get(...params: unknown[]): unknown;
          all(...params: unknown[]): unknown[];
          run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
        };
        exec(sql: string): void;
        close(): void;
      };
    };
    return wrapNodeSqlite(new DatabaseSync(':memory:'));
  } catch {
    return null;
  }
}

/** Synchronous when better-sqlite3 works; the fallback only adds an await at the caller. */
export function openBetterSqlite(): TestDatabase | null {
  const Database = loadBetterSqlite();
  return Database ? new Database(':memory:') : null;
}

export async function openTestDatabase(): Promise<{
  db: TestDatabase;
  driver: 'better-sqlite3' | 'node:sqlite';
}> {
  const native = openBetterSqlite();
  if (native) return { db: native, driver: 'better-sqlite3' };
  const shim = createNodeSqliteDatabase();
  if (shim) return { db: shim, driver: 'node:sqlite' };
  throw new Error(
    '没有可用的 SQLite 驱动：better-sqlite3 原生模块与当前 Node 不匹配，且 node:sqlite 不可用'
  );
}
