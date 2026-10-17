import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openTestDatabase, type TestDatabase } from '../helpers/sqlite';
import { runMigrations } from '../../src/core/database/migrations';

const holder = vi.hoisted(() => ({ db: null as unknown as TestDatabase }));

vi.mock('../../src/core/database/database', () => ({
  getDatabase: () => holder.db,
}));

import { createQuotaPersistence } from '../../src/usage/quota-store';
import { clearQueuedWrites, flushQueuedWrites } from '../../src/usage/write-buffer';
import { invalidateActiveProfileCache } from '../../src/core/settings/profile-store';

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

beforeEach(async () => {
  // Each case gets a fresh database, so anything still queued belongs to the previous one.
  clearQueuedWrites();
  // Build the schema from the real migrations instead of a copied DDL string, so a
  // change to `quota_tracking` (profile_id and cost_usd landed in v4/v5) cannot drift
  // away from what this spec exercises.
  holder.db = (await openTestDatabase()).db;
  runMigrations(holder.db as never);
  invalidateActiveProfileCache();
});

describe('sqlite quota persistence', () => {
  it('round-trips a provider level bucket with its cost', () => {
    const persistence = createQuotaPersistence('default');
    const periodStart = iso(-3600_000);
    const periodEnd = iso(3600_000);

    persistence.save({
      providerId: 'groq',
      modelId: undefined,
      requestCount: 12,
      tokenCount: 4200,
      costUsd: 0.05,
      periodStart,
      periodEnd,
    });

    expect(persistence.load()).toEqual([
      {
        providerId: 'groq',
        modelId: undefined,
        requestCount: 12,
        tokenCount: 4200,
        costUsd: 0.05,
        periodStart,
        periodEnd,
      },
    ]);
  });

  it('updates the active period instead of inserting duplicates', () => {
    const persistence = createQuotaPersistence('default');
    const periodStart = iso(-3600_000);
    const periodEnd = iso(3600_000);
    const row = {
      providerId: 'openrouter',
      modelId: 'llama-3.3',
      periodStart,
      periodEnd,
    };

    persistence.save({ ...row, requestCount: 1, tokenCount: 100 });
    persistence.save({ ...row, requestCount: 2, tokenCount: 250 });

    const loaded = persistence.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].requestCount).toBe(2);
    expect(loaded[0].tokenCount).toBe(250);
  });

  it('ignores periods that already rolled over', () => {
    const persistence = createQuotaPersistence('default');
    const past = iso(-7200_000);

    persistence.save({
      providerId: 'xai',
      modelId: undefined,
      requestCount: 50,
      tokenCount: 5000,
      periodStart: past,
      periodEnd: past,
    });

    expect(persistence.load()).toEqual([]);
    expect(holder.db.prepare('SELECT COUNT(*) as c FROM quota_tracking').get()).toEqual({ c: 1 });
  });

  it('keeps model level and provider level buckets separate', () => {
    const persistence = createQuotaPersistence('default');
    const periodStart = iso(-3600_000);
    const periodEnd = iso(3600_000);

    persistence.save({ providerId: 'gemini', modelId: undefined, requestCount: 2, tokenCount: 200, periodStart, periodEnd });
    persistence.save({ providerId: 'gemini', modelId: 'flash', requestCount: 1, tokenCount: 100, periodStart, periodEnd });

    const loaded = persistence
      .load()
      .sort((a, b) => (a.modelId ?? '').localeCompare(b.modelId ?? ''));
    expect(loaded.map((r) => [r.modelId, r.requestCount])).toEqual([
      [undefined, 2],
      ['flash', 1],
    ]);
  });

  it('accumulates increments into the open window', () => {
    const persistence = createQuotaPersistence('default');
    const periodStart = iso(-3600_000);
    const periodEnd = iso(3600_000);
    const bucket = {
      providerId: 'groq' as const,
      modelId: undefined,
      periodStart,
      periodEnd,
    };

    persistence.add({ ...bucket, requests: 1, tokens: 100, costUsd: 0.01 });
    persistence.add({ ...bucket, requests: 1, tokens: 250, costUsd: 0.02 });

    const loaded = persistence.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].requestCount).toBe(2);
    expect(loaded[0].tokenCount).toBe(350);
    expect(loaded[0].costUsd).toBeCloseTo(0.03);
  });

  it('sums the writes of two managers bound to the same database file', () => {
    // Stand-in for the desktop window and a `--web` process sharing `.web-data`:
    // neither may publish its own snapshot over the other's usage.
    const periodStart = iso(-3600_000);
    const periodEnd = iso(3600_000);
    const first = createQuotaPersistence('default');
    const second = createQuotaPersistence('default');

    first.add({ providerId: 'openrouter', modelId: 'llama-3.3', periodStart, periodEnd, requests: 3, tokens: 900, costUsd: 0.4 });
    second.add({ providerId: 'openrouter', modelId: 'llama-3.3', periodStart, periodEnd, requests: 2, tokens: 400, costUsd: 0.1 });

    const loaded = first.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].requestCount).toBe(5);
    expect(loaded[0].tokenCount).toBe(1300);
    expect(loaded[0].costUsd).toBeCloseTo(0.5);
  });

  it('resolves the profile lazily so a mid-session switch reads the right counters', () => {
    let active = 'work';
    const persistence = createQuotaPersistence(() => active);
    const periodStart = iso(-3600_000);
    const periodEnd = iso(3600_000);

    persistence.save({ providerId: 'groq', requestCount: 3, tokenCount: 300, periodStart, periodEnd });
    active = 'personal';
    persistence.save({ providerId: 'groq', requestCount: 9, tokenCount: 900, periodStart, periodEnd });

    active = 'work';
    expect(persistence.load()[0].requestCount).toBe(3);
    active = 'personal';
    expect(persistence.load()[0].requestCount).toBe(9);
  });

  it('falls back to the default profile for an empty id', () => {
    const persistence = createQuotaPersistence(() => '');
    persistence.save({
      providerId: 'groq',
      requestCount: 1,
      tokenCount: 10,
      periodStart: iso(-3600_000),
      periodEnd: iso(3600_000),
    });
    flushQueuedWrites();
    const row = holder.db.prepare('SELECT profile_id FROM quota_tracking').get() as {
      profile_id: string;
    };
    expect(row.profile_id).toBe('default');
  });
});
