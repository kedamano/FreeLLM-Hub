import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openTestDatabase, type TestDatabase } from '../helpers/sqlite';

// The module logs through the structured logger (pino child), not console — spy there.
const logWarn = vi.hoisted(() => vi.fn());
vi.mock('../../src/core/log/logger', () => ({
  loggerFor: () => ({ warn: logWarn, info: logWarn, error: logWarn, debug: logWarn }),
}));
import { runMigrations } from '../../src/core/database/migrations';

const holder = vi.hoisted(() => ({ db: null as unknown as TestDatabase }));

vi.mock('../../src/core/database/database', () => ({
  getDatabase: () => holder.db,
}));

import {
  WRITE_BATCH_MAX_ROWS,
  WRITE_FLUSH_INTERVAL_MS,
  clearQueuedWrites,
  droppedWriteCount,
  flushQueuedWrites,
  pendingWriteCount,
  queueWrite,
  readDatabase,
} from '../../src/usage/write-buffer';
import { prepared } from '../../src/core/database/statement-cache';
import { recordCall, queryCallLogs } from '../../src/usage/usage-recorder';
import {
  beginRequestAudit,
  completeRequestAudit,
  listRequestAudit,
  recordAuditEvent,
  getRequestAuditDetail,
} from '../../src/usage/audit-recorder';
import { createQuotaPersistence } from '../../src/usage/quota-store';
import { invalidateActiveProfileCache } from '../../src/core/settings/profile-store';

const INSERT_ROW =
  'INSERT INTO call_logs (id, request_id, timestamp, provider_id, model_id, status, duration_ms, prompt_tokens, completion_tokens) VALUES (?,?,?,?,?,?,?,?,?)';

function callRow(id: string) {
  return {
    requestId: `req-${id}`,
    providerId: 'groq' as const,
    modelId: 'llama-3.3-70b',
    status: 'success' as const,
    durationMs: 10,
    promptTokens: 5,
    completionTokens: 5,
  };
}

function countOf(table: 'call_logs' | 'request_audit' | 'request_audit_events' | 'quota_tracking') {
  return (holder.db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number }).c;
}

/** Count how many transactions the buffer opens, which is how many commits it costs. */
function trackTransactions(): { count: () => number } {
  let opened = 0;
  const db = holder.db;
  const original = db.transaction.bind(db);
  db.transaction = ((fn: () => unknown) => {
    opened += 1;
    return original(fn);
  }) as TestDatabase['transaction'];
  return { count: () => opened };
}

beforeEach(async () => {
  clearQueuedWrites();
  holder.db = (await openTestDatabase()).db;
  holder.db.pragma('foreign_keys = ON');
  runMigrations(holder.db as never);
  invalidateActiveProfileCache();
});

afterEach(() => {
  clearQueuedWrites();
  vi.useRealTimers();
});

describe('write buffer batching', () => {
  it('holds a queued write back until the flush commits it', () => {
    queueWrite((db) => prepared(db, INSERT_ROW).run('a', 'r-a', 'now', 'groq', 'm', 'success', 1, 1, 1));

    expect(pendingWriteCount()).toBe(1);
    expect(countOf('call_logs')).toBe(0);

    expect(flushQueuedWrites()).toBe(1);
    expect(countOf('call_logs')).toBe(1);
    expect(pendingWriteCount()).toBe(0);
  });

  it('commits a whole burst in one transaction', () => {
    const transactions = trackTransactions();
    for (let i = 0; i < 12; i++) recordCall(callRow(`${i}`));

    expect(pendingWriteCount()).toBe(12);
    expect(transactions.count()).toBe(0);

    flushQueuedWrites();
    expect(transactions.count()).toBe(1);
    expect(countOf('call_logs')).toBe(12);
  });

  it('flushes on its own once a batch reaches the size ceiling', () => {
    for (let i = 0; i < WRITE_BATCH_MAX_ROWS; i++) recordCall(callRow(`${i}`));
    expect(countOf('call_logs')).toBe(WRITE_BATCH_MAX_ROWS);
    expect(pendingWriteCount()).toBe(0);
  });

  it('flushes on a timer so an idle queue cannot hold writes hostage', () => {
    vi.useFakeTimers();
    recordCall(callRow('t'));
    expect(countOf('call_logs')).toBe(0);
    vi.advanceTimersByTime(WRITE_FLUSH_INTERVAL_MS);
    expect(countOf('call_logs')).toBe(1);
  });

  it('drains before a read so a finished request is immediately visible', () => {
    beginRequestAudit({ requestId: 'drain-1', route: '/v1/chat/completions' });
    completeRequestAudit({ requestId: 'drain-1', status: 'success', totalTokens: 42 });

    expect(pendingWriteCount()).toBeGreaterThan(0);
    expect(listRequestAudit({ requestId: 'drain-1' }).total).toBe(1);
    expect(pendingWriteCount()).toBe(0);
    expect(getRequestAuditDetail('drain-1')?.request.totalTokens).toBe(42);
    expect(queryCallLogs().items).toHaveLength(0);
  });

  it('binds values when queueing, not when flushing', () => {
    // A profile switch between the write and its flush must not re-tag the row.
    const first = createQuotaPersistence('work');
    first.save({
      providerId: 'groq',
      requestCount: 3,
      tokenCount: 300,
      periodStart: new Date(Date.now() - 1000).toISOString(),
      periodEnd: new Date(Date.now() + 86400_000).toISOString(),
    });
    const second = createQuotaPersistence('personal');
    second.save({
      providerId: 'groq',
      requestCount: 9,
      tokenCount: 900,
      periodStart: new Date(Date.now() - 1000).toISOString(),
      periodEnd: new Date(Date.now() + 86400_000).toISOString(),
    });
    flushQueuedWrites();

    expect(second.load()[0].requestCount).toBe(9);
    expect(first.load()[0].requestCount).toBe(3);
  });

  it('keeps one request’s decision trail in enqueue order', () => {
    beginRequestAudit({ requestId: 'seq-1', route: '/v1/chat/completions' });
    recordAuditEvent({ requestId: 'seq-1', event: 'candidate.skipped', providerId: 'groq', reason: 'quota' });
    recordAuditEvent({ requestId: 'seq-1', event: 'attempt.start', providerId: 'ollama' });
    completeRequestAudit({ requestId: 'seq-1', status: 'success' });

    const events = getRequestAuditDetail('seq-1')?.events ?? [];
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
    expect(events.map((event) => event.event)).toEqual([
      'request.received',
      'candidate.skipped',
      'attempt.start',
      'request.completed',
    ]);
  });

  it('accumulates quota increments that share a flush', () => {
    const persistence = createQuotaPersistence('default');
    const periodStart = new Date(Date.now() - 1000).toISOString();
    const periodEnd = new Date(Date.now() + 86400_000).toISOString();
    for (let i = 0; i < 4; i++) {
      persistence.add({ providerId: 'groq', periodStart, periodEnd, requests: 1, tokens: 10, costUsd: 0 });
    }
    flushQueuedWrites();
    expect(persistence.load()[0]).toMatchObject({ requestCount: 4, tokenCount: 40 });
  });

  it('drops a single bad statement without losing its batch', () => {
    logWarn.mockClear();
    const before = droppedWriteCount();

    queueWrite(() => {
      throw new Error('constraint failed');
    });
    recordCall(callRow('good'));
    flushQueuedWrites();

    expect(countOf('call_logs')).toBe(1);
    expect(droppedWriteCount()).toBe(before + 1);
    expect(logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ failed: expect.any(Number) }),
      expect.stringContaining('dropped')
    );
  });

  it('reports the whole batch as lost when the transaction itself fails', () => {
    logWarn.mockClear();
    const broken = {
      prepare: () => ({ run: () => undefined }),
      transaction: () => {
        throw new Error('SQLITE_BUSY');
      },
    } as unknown as TestDatabase;
    const original = holder.db;
    holder.db = broken;

    const before = droppedWriteCount();
    recordCall(callRow('lost'));
    expect(flushQueuedWrites()).toBe(1);
    expect(droppedWriteCount()).toBe(before + 1);
    // The log contract is one shape for both failure kinds: counts + a stable message.
    expect(logWarn).toHaveBeenCalledWith(
      { failed: 1, queued: 1 },
      'queued writes were dropped'
    );

    holder.db = original;
  });

  it('readDatabase is the drain-plus-connection shortcut reads use', () => {
    recordCall(callRow('rd'));
    expect(pendingWriteCount()).toBe(1);
    const db = readDatabase();
    expect(pendingWriteCount()).toBe(0);
    expect(db).toBe(holder.db);
  });

  it('clearQueuedWrites discards pending rows instead of committing them', () => {
    recordCall(callRow('x'));
    clearQueuedWrites();
    expect(flushQueuedWrites()).toBe(0);
    expect(countOf('call_logs')).toBe(0);
  });
});

describe('statement cache', () => {
  it('reuses one compiled statement per connection and sql', () => {
    const first = prepared(holder.db, INSERT_ROW);
    expect(prepared(holder.db, INSERT_ROW)).toBe(first);
  });

  it('never hands a statement prepared for one connection to another', async () => {
    const other = (await openTestDatabase()).db;
    const first = prepared(holder.db, INSERT_ROW);
    expect(prepared(other, INSERT_ROW)).not.toBe(first);
    other.close();
  });
});
