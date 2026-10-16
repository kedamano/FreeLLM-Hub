import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

let db: Database.Database;

vi.mock('../../src/core/database/database', () => ({
  getDatabase: () => db,
}));

import { createQuotaPersistence } from '../../src/usage/quota-store';

const SCHEMA = `
  CREATE TABLE quota_tracking (
    provider_id TEXT NOT NULL,
    model_id TEXT,
    period_start TEXT NOT NULL,
    period_end TEXT NOT NULL,
    request_count INTEGER NOT NULL DEFAULT 0,
    token_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (provider_id, model_id, period_start)
  );
`;

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(SCHEMA);
});

describe('sqlite quota persistence', () => {
  it('round-trips a provider level bucket', () => {
    const persistence = createQuotaPersistence();
    const periodStart = iso(-3600_000);
    const periodEnd = iso(3600_000);

    persistence.save({
      providerId: 'groq',
      modelId: undefined,
      requestCount: 12,
      tokenCount: 4200,
      periodStart,
      periodEnd,
    });

    expect(persistence.load()).toEqual([
      {
        providerId: 'groq',
        modelId: undefined,
        requestCount: 12,
        tokenCount: 4200,
        periodStart,
        periodEnd,
      },
    ]);
  });

  it('updates the active period instead of inserting duplicates', () => {
    const persistence = createQuotaPersistence();
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
    const persistence = createQuotaPersistence();
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
    expect(db.prepare('SELECT COUNT(*) as c FROM quota_tracking').get()).toEqual({ c: 1 });
  });

  it('keeps model level and provider level buckets separate', () => {
    const persistence = createQuotaPersistence();
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
});
