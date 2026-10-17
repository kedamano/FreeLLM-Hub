import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { openTestDatabase, type TestDatabase } from '../helpers/sqlite';
import { runMigrations } from '../../src/core/database/migrations';

const holder = vi.hoisted(() => ({ db: null as unknown as TestDatabase }));
vi.mock('../../src/core/database/database', () => ({ getDatabase: () => holder.db }));

const notifications = vi.hoisted(() => ({ list: [] as Array<{ title: string; body: string }> }));

vi.mock('../../src/main/services/update-service', () => ({
  notify: (title: string, body: string) => notifications.list.push({ title, body }),
}));

import {
  budgetConfigKey,
  BUDGET_LAST_NOTIFY_KEY,
  checkBudgets,
  getBudgetUsage,
  readBudgetConfig,
} from '../../src/usage/budget-service';

const settings = new Map<string, string>();
const settingsLike = {
  readSetting: (key: string) => settings.get(key) ?? null,
  writeSetting: (key: string, value: string) => settings.set(key, value),
};

function insertCall(overrides: Record<string, unknown> = {}): void {
  holder.db
    .prepare(
      `INSERT INTO call_logs
         (id, request_id, provider_id, model_id, status, timestamp, prompt_tokens, completion_tokens,
          cost_usd, saved_cost_usd, profile_id)
       VALUES (?, ?, 'groq', 'llama', 'success', ?, 0, 0, ?, 0, ?)`
    )
    .run(
      overrides.id ?? `c${Math.random()}`,
      overrides.requestId ?? `r${Math.random()}`,
      overrides.timestamp ?? new Date().toISOString(),
      overrides.costUsd ?? 0,
      overrides.profileId ?? 'default'
    );
}

beforeEach(async () => {
  holder.db = (await openTestDatabase()).db;
  runMigrations(holder.db as never);
  settings.clear();
  notifications.list = [];
});

describe('budget service', () => {
  it('aggregates today and this month from the ledger, per profile', () => {
    insertCall({ id: 'a', requestId: 'r1', costUsd: 1.5 });
    insertCall({ id: 'b', requestId: 'r2', costUsd: 0.5 });
    insertCall({ id: 'c', requestId: 'r3', costUsd: 9, profileId: 'work' });
    // Yesterday's spend must not count toward today.
    insertCall({ id: 'd', requestId: 'r4', costUsd: 100, timestamp: '2026-01-01T00:00:00.000Z' });

    const usage = getBudgetUsage('default');
    expect(usage.costTodayUsd).toBeCloseTo(2, 6);
    // The month aggregate includes today's rows too.
    expect(usage.costMonthUsd).toBeCloseTo(2, 6);
    expect(getBudgetUsage('work').costTodayUsd).toBeCloseTo(9, 6);
  });

  it('reads the profile-scoped config', () => {
    settings.set(budgetConfigKey('work'), '{"dailyCostUsd":2}');
    expect(readBudgetConfig('work', settingsLike).dailyCostUsd).toBe(2);
    expect(readBudgetConfig('default', settingsLike)).toEqual({});
  });

  it('notifies once per period and stays quiet until the key changes', () => {
    settings.set(budgetConfigKey('default'), '{"dailyCostUsd":1}');
    insertCall({ id: 'a', requestId: 'r1', costUsd: 2 });

    const first = checkBudgets('default', settingsLike);
    expect(first.level).toBe('exceeded');
    expect(notifications.list).toHaveLength(1);
    expect(settings.get(BUDGET_LAST_NOTIFY_KEY)).toBeTruthy();

    // A second sweep in the same period must not re-announce.
    insertCall({ id: 'b', requestId: 'r2', costUsd: 5 });
    checkBudgets('default', settingsLike);
    expect(notifications.list).toHaveLength(1);
  });

  it('escalates warn -> exceeded with a new notification', () => {
    settings.set(budgetConfigKey('default'), '{"dailyCostUsd":10,"warnAtPercent":0.8}');
    insertCall({ id: 'a', requestId: 'r1', costUsd: 8.5 });
    checkBudgets('default', settingsLike);
    expect(notifications.list[0]?.title).toBe('预算接近上限');

    insertCall({ id: 'b', requestId: 'r2', costUsd: 3 });
    checkBudgets('default', settingsLike);
    expect(notifications.list[1]?.title).toBe('预算已超限');
  });

  it('stays silent when no budget is configured', () => {
    insertCall({ id: 'a', requestId: 'r1', costUsd: 99 });
    const evaluation = checkBudgets('default', settingsLike);
    expect(evaluation.level).toBe('ok');
    expect(notifications.list).toHaveLength(0);
  });
});
