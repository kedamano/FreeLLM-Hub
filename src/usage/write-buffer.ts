import type Database from 'better-sqlite3';
import { getDatabase } from '../core/database/database.js';
import { loggerFor } from '../core/log/logger.js';

const log = loggerFor('write-buffer');

/**
 * Gateway traffic used to commit once per statement: a single request wrote an audit
 * row, a `request.received` event, several decision events, a completion update, a
 * final event and one call-log row per attempt — each its own transaction, each with
 * its own WAL sync. Writes now queue up and land in one immediate transaction, which
 * keeps the trail in order while collapsing those commits into one.
 *
 * Queueing is best-effort like the writes it replaces: a statement that fails is
 * counted and skipped, never thrown at the data path.
 */

/** Rows that trigger an eager flush, so a burst cannot grow the queue unbounded. */
export const WRITE_BATCH_MAX_ROWS = 64;

/** How long a queued write may stay invisible when traffic stops. */
export const WRITE_FLUSH_INTERVAL_MS = 200;

export type QueuedWrite = (db: Database.Database) => void;

let batch: QueuedWrite[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let draining = false;
let droppedWrites = 0;

function cancelTimer(): void {
  if (timer === null) return;
  clearTimeout(timer);
  timer = null;
}

/**
 * Queue one statement. Runs inside the next flush, in the order it was queued.
 *
 * Every bound value must already be resolved when queueing: the closure runs later,
 * possibly after the active profile or the clock moved on, and a row written under the
 * wrong profile is worse than a slow write.
 */
export function queueWrite(write: QueuedWrite): void {
  batch.push(write);
  if (batch.length >= WRITE_BATCH_MAX_ROWS) {
    flushQueuedWrites();
    return;
  }
  if (timer === null) {
    timer = setTimeout(() => {
      timer = null;
      flushQueuedWrites();
    }, WRITE_FLUSH_INTERVAL_MS);
    timer.unref?.();
  }
}

/**
 * Commit everything queued and return the number of statements attempted. Safe to call
 * from anywhere, including between queued writes; re-entrant calls are ignored so a
 * flush can never nest inside its own transaction.
 */
export function flushQueuedWrites(): number {
  cancelTimer();
  if (batch.length === 0 || draining) return 0;

  const queued = batch;
  batch = [];
  draining = true;
  let failed = 0;
  try {
    const db = getDatabase();
    const runBatch = db.transaction(() => {
      for (const write of queued) {
        try {
          write(db);
        } catch {
          failed += 1;
        }
      }
    });
    runBatch.immediate();
    droppedWrites += failed;
  } catch {
    // The whole transaction failed (a competing process held the write lock past
    // `busy_timeout`); nothing was committed, so report the batch as dropped.
    droppedWrites += queued.length;
    failed = queued.length;
  } finally {
    draining = false;
  }
  // Losing telemetry rows is acceptable; losing them invisibly is not.
  if (failed > 0) {
    log.warn({ failed, queued: queued.length }, 'queued writes were dropped');
  }
  return queued.length;
}

/** Statements waiting to be committed. */
export function pendingWriteCount(): number {
  return batch.length;
}

/** Statements lost to write errors since process start, for the diagnostics panel. */
export function droppedWriteCount(): number {
  return droppedWrites;
}

/**
 * Connection for a read. Draining first is what keeps the panels honest: a request
 * that just finished is visible in the audit list even though its rows were still
 * sitting in the queue a microsecond ago.
 */
export function readDatabase(): Database.Database {
  flushQueuedWrites();
  return getDatabase();
}

/** Drop queued writes without committing them. Test-only isolation between databases. */
export function clearQueuedWrites(): void {
  cancelTimer();
  batch = [];
}

