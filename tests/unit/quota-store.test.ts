import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openTestDatabase, type TestDatabase } from '../helpers/sqlite';
import { runMigrations } from '../../src/core/database/migrations';

const holder = vi.hoisted(() => ({ db: null as unknown as TestDatabase }));

vi.mock('../../src/core/database/database', () => ({
  getDatabase: () => holder.db,
}));

import { createQuotaPersistence } from '../../src/usage/quota-store';
import { invalidateActiveProfileCache } from '../../src/core/settings/profile-store';

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

beforeEach(async () => {
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
    const row = holder.db.prepare('SELECT profile_id FROM quota_tracking').get() as {
      profile_id: string;
    };
    expect(row.profile_id).toBe('default');
  });
});
