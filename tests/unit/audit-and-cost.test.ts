import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openTestDatabase, type TestDatabase } from '../helpers/sqlite';
import { runMigrations } from '../../src/core/database/migrations';

const holder = vi.hoisted(() => ({ db: null as unknown as TestDatabase }));

vi.mock('../../src/core/database/database', () => ({
  getDatabase: () => holder.db,
}));

import {
  auditRejectedRequest,
  beginRequestAudit,
  completeRequestAudit,
  deleteOldAuditRecords,
  getAuditSummary,
  getInFlightRequestCount,
  getRequestAuditDetail,
  listRequestAudit,
  recordAuditEvent,
} from '../../src/usage/audit-recorder';
import { MAX_AUDIT_PAGE_SIZE, normalizeAuditQuery } from '../../src/usage/audit-query';
import { recordCall, queryCallLogs } from '../../src/usage/usage-recorder';
import { createQuotaPersistence } from '../../src/usage/quota-store';
import {
  getCostSummary,
  getDailyStatsByProvider,
  getDashboardStats,
  getProviderHealth,
  getProviderStatistics,
  getProviderQuotaUsage,
} from '../../src/usage/statistics';
import { purgeOldLogs, purgeAuditAndLogs } from '../../src/usage/log-retention';
import { clearPricingCache } from '../../src/usage/cost-model';
import { invalidateActiveProfileCache } from '../../src/core/settings/profile-store';

function seedModels() {
  holder.db.prepare('INSERT INTO providers (id, display_name, auth_type, base_url) VALUES (?,?,?,?)').run(
    'groq',
    'Groq',
    'api-key',
    'https://api.groq.com/openai/v1'
  );
  holder.db
    .prepare(
      `INSERT INTO models (id, provider_id, display_name, capabilities, pricing, status)
       VALUES (?,?,?,?,?, 'available')`
    )
    .run(
      'llama-3.3-70b',
      'groq',
      'Llama 3.3',
      JSON.stringify({ supported: ['chat'], contextWindow: 8192 }),
      JSON.stringify({ type: 'free', currency: 'USD' })
    );
}

beforeEach(async () => {
  holder.db = (await openTestDatabase()).db;
  holder.db.pragma('foreign_keys = ON');
  // The runner is typed for better-sqlite3; the specs may use the node:sqlite shim.
  runMigrations(holder.db as never);
  seedModels();
  clearPricingCache();
  invalidateActiveProfileCache();
});

describe('gateway request audit', () => {
  it('opens an in_progress row with a received event before dispatch', () => {
    beginRequestAudit({
      requestId: 'req-1',
      route: '/v1/chat/completions',
      stream: true,
      requestedModel: 'llama-3.3-70b',
      taskType: 'coding',
      clientAddress: '127.0.0.1',
      params: { maxTokens: 200, temperature: 0.2, messageCount: 2 },
    });

    const { items } = listRequestAudit({ requestId: 'req-1' });
    expect(items).toHaveLength(1);
    expect(items[0].status).toBe('in_progress');
    expect(items[0].stream).toBe(true);
    expect(items[0].params).toEqual({ maxTokens: 200, temperature: 0.2, messageCount: 2 });
    expect(getRequestAuditDetail('req-1')?.events.map((event) => event.event)).toEqual([
      'request.received',
    ]);
    expect(getInFlightRequestCount()).toBe(1);
  });

  it('is idempotent on the opening row so a duplicate id cannot double count', () => {
    beginRequestAudit({ requestId: 'req-dup', route: '/v1/chat/completions' });
    beginRequestAudit({ requestId: 'req-dup', route: '/v1/chat/completions' });
    expect(listRequestAudit({ requestId: 'req-dup' }).total).toBe(1);
  });

  it('numbers the decision trail in order and keeps the skip reason', () => {
    beginRequestAudit({ requestId: 'req-2', route: '/v1/chat/completions', requestedModel: 'x' });
    recordAuditEvent({ requestId: 'req-2', event: 'candidate.skipped', providerId: 'cerebras', modelId: 'qwen', reason: 'circuit_open' });
    recordAuditEvent({ requestId: 'req-2', event: 'candidate.skipped', providerId: 'groq', modelId: 'llama', reason: 'rate_limited', detail: { retryAfterMs: 4000 } });
    recordAuditEvent({ requestId: 'req-2', event: 'attempt.start', providerId: 'groq', modelId: 'llama', attempt: 0 });
    completeRequestAudit({ requestId: 'req-2', status: 'rate_limited', statusCode: 429, providerId: 'groq', modelId: 'llama', attempts: 1 });

    const detail = getRequestAuditDetail('req-2');
    // The opening `request.received` event is written by beginRequestAudit itself, so the
    // trail is received -> two skips -> attempt -> terminal outcome, numbered in order.
    expect(detail?.events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(detail?.events.map((event) => event.event)).toEqual([
      'request.received',
      'candidate.skipped',
      'candidate.skipped',
      'attempt.start',
      'request.failed',
    ]);
    expect(detail?.events[2].detail).toEqual({ retryAfterMs: 4000 });
    expect(detail?.events[1].reason).toBe('circuit_open');
    expect(detail?.request.status).toBe('rate_limited');
    expect(detail?.request.statusCode).toBe(429);
  });

  it('never overwrites a completed record with a later in_progress default', () => {
    beginRequestAudit({ requestId: 'req-3', route: '/v1/chat/completions' });
    completeRequestAudit({ requestId: 'req-3', status: 'success', statusCode: 200, durationMs: 42 });
    completeRequestAudit({ requestId: 'req-3', status: 'success', providerId: 'groq' });

    const row = getRequestAuditDetail('req-3')?.request;
    expect(row?.durationMs).toBe(42);
    expect(row?.providerId).toBe('groq');
    expect(listRequestAudit({ status: 'in_progress' }).total).toBe(0);
  });

  it('audits traffic that never reached a route handler', () => {
    auditRejectedRequest({
      requestId: 'req-auth',
      route: '/v1/chat/completions',
      statusCode: 401,
      errorCode: 'AUTH_REQUIRED',
      errorMessage: 'Missing authorization header',
    });

    const row = getRequestAuditDetail('req-auth')?.request;
    expect(row?.status).toBe('rejected');
    expect(row?.statusCode).toBe(401);
    expect(row?.errorCode).toBe('AUTH_REQUIRED');
    expect(getInFlightRequestCount()).toBe(0);
  });

  it('redacts bearer tokens before they are persisted', () => {
    auditRejectedRequest({
      requestId: 'req-secret',
      route: '/v1/chat/completions',
      statusCode: 400,
      errorCode: 'BAD_REQUEST',
      errorMessage: 'upstream rejected: Authorization: Bearer sk-abcdefghijklmnop',
    });
    const raw = holder.db
      .prepare('SELECT error_message FROM request_audit WHERE request_id = ?')
      .get('req-secret') as { error_message: string };
    expect(raw.error_message).not.toContain('sk-abcdefghijklmnop');
  });

  it('filters, paginates and searches without leaking rows from another profile', () => {
    for (let i = 0; i < 5; i++) {
      beginRequestAudit({ requestId: `req-${i}`, route: '/v1/chat/completions', profileId: 'work' });
      completeRequestAudit({
        requestId: `req-${i}`,
        status: i % 2 === 0 ? 'success' : 'error',
        statusCode: i % 2 === 0 ? 200 : 502,
        providerId: 'groq',
        modelId: 'llama-3.3-70b',
        errorCode: i % 2 === 0 ? undefined : 'SERVER_ERROR',
      });
    }
    beginRequestAudit({ requestId: 'other', route: '/v1/chat/completions', profileId: 'personal' });
    completeRequestAudit({ requestId: 'other', status: 'success' });

    expect(listRequestAudit({ profileId: 'work', limit: 100 }).total).toBe(5);
    expect(listRequestAudit({ profileId: 'work', failuresOnly: true, limit: 100 }).total).toBe(2);
    expect(listRequestAudit({ profileId: 'work', status: 'success', limit: 100 }).total).toBe(3);
    expect(listRequestAudit({ profileId: 'work', search: 'SERVER_ERROR', limit: 100 }).total).toBe(2);

    const page = listRequestAudit({ profileId: 'work', limit: 2, offset: 2 });
    expect(page.items).toHaveLength(2);
    expect(new Set(page.items.map((item) => item.requestId)).size).toBe(2);
  });

  it('summarises rates and latency without counting a live request as a failure', () => {
    beginRequestAudit({ requestId: 'ok-1', route: '/v1/chat/completions', profileId: 'default' });
    completeRequestAudit({ requestId: 'ok-1', status: 'success', statusCode: 200, durationMs: 100, providerId: 'groq', modelId: 'm', totalTokens: 30 });
    beginRequestAudit({ requestId: 'bad-1', route: '/v1/chat/completions', profileId: 'default' });
    completeRequestAudit({ requestId: 'bad-1', status: 'error', statusCode: 502, durationMs: 300, providerId: 'groq', modelId: 'm', errorCode: 'SERVER_ERROR', errorMessage: 'boom' });
    beginRequestAudit({ requestId: 'live-1', route: '/v1/chat/completions', profileId: 'default' });

    const summary = getAuditSummary({ days: 7, profileId: 'default' });
    expect(summary.requests).toBe(3);
    expect(summary.successRate).toBeCloseTo(0.5, 6);
    expect(summary.p50DurationMs).toBeGreaterThan(0);
    expect(summary.byStatus.find((row) => row.status === 'in_progress')?.count).toBe(1);
    expect(summary.topErrors[0]).toMatchObject({ code: 'SERVER_ERROR', count: 1 });
    expect(summary.providerBreakdown[0]).toMatchObject({ providerId: 'groq', requests: 2 });
    expect(summary.volumeSeries).toHaveLength(1);
  });

  it('deletes events together with their request', () => {
    beginRequestAudit({ requestId: 'old-1', route: '/v1/chat/completions' });
    recordAuditEvent({ requestId: 'old-1', event: 'attempt.start' });
    completeRequestAudit({ requestId: 'old-1', status: 'success' });

    const future = new Date(Date.now() + 60_000).toISOString();
    expect(deleteOldAuditRecords(future)).toBe(1);
    expect(holder.db.prepare('SELECT COUNT(*) as c FROM request_audit_events').get()).toEqual({ c: 0 });
  });

  it('retention sweeps audit rows alongside call logs', () => {
    beginRequestAudit({ requestId: 'r', route: '/v1/chat/completions' });
    completeRequestAudit({ requestId: 'r', status: 'success' });
    holder.db.prepare("UPDATE request_audit SET started_at = '2020-01-01T00:00:00.000Z'").run();
    holder.db.prepare("UPDATE call_logs SET timestamp = '2020-01-01T00:00:00.000Z'").run();
    recordCall({
      requestId: 'call-old',
      providerId: 'groq',
      modelId: 'llama-3.3-70b',
      status: 'success',
      durationMs: 10,
      promptTokens: 1,
      completionTokens: 1,
    });
    holder.db.prepare("UPDATE call_logs SET timestamp = '2020-01-01T00:00:00.000Z' WHERE request_id = 'call-old'").run();

    const removed = purgeAuditAndLogs(Date.now(), 30);
    expect(removed.auditRequests).toBe(1);
    expect(removed.callLogs).toBe(1);
  });
});

describe('cost ledger and quota ceilings', () => {
  function insertCall(overrides: Partial<Parameters<typeof recordCall>[0]> = {}) {
    recordCall({
      requestId: 'req-x',
      providerId: 'groq',
      modelId: 'llama-3.3-70b',
      status: 'success',
      durationMs: 120,
      promptTokens: 100,
      completionTokens: 50,
      ...overrides,
    });
  }

  it('prices a free call at zero and records the benchmark saving', () => {
    insertCall();
    const [row] = holder.db
      .prepare('SELECT cost_usd, reference_cost_usd, saved_cost_usd, pricing_type, total_tokens, profile_id FROM call_logs')
      .all() as Array<{
      cost_usd: number;
      reference_cost_usd: number;
      saved_cost_usd: number;
      pricing_type: string;
      total_tokens: number;
      profile_id: string;
    }>;

    expect(row.cost_usd).toBe(0);
    expect(row.reference_cost_usd).toBeGreaterThan(0);
    expect(row.saved_cost_usd).toBeCloseTo(row.reference_cost_usd, 6);
    expect(row.pricing_type).toBe('free');
    expect(row.total_tokens).toBe(150);
    expect(row.profile_id).toBe('default');
  });

  it('keeps the cost columns consistent when the caller supplies them', () => {
    insertCall({ cost: { costUsd: 0.002, referenceCostUsd: 0.01, savedCostUsd: 0.008 } });
    const summary = getCostSummary({ days: 1, profileId: 'default' });
    expect(summary.costUsd).toBeCloseTo(0.002, 6);
    expect(summary.savedCostUsd).toBeCloseTo(0.008, 6);
    expect(summary.savedRate).toBeCloseTo(0.8, 6);
  });

  it('aggregates by provider, model and day for the current profile only', () => {
    insertCall({ promptTokens: 1000, completionTokens: 500 });
    insertCall({ modelId: 'other', promptTokens: 10, completionTokens: 10, status: 'error' });
    insertCall({ providerId: 'cerebras', modelId: 'qwen', promptTokens: 200, completionTokens: 200, profileId: 'work' });

    const summary = getCostSummary({ days: 1, profileId: 'default' });
    expect(summary.requests).toBe(2);
    expect(summary.successfulRequests).toBe(1);
    expect(summary.tokens).toBe(1500 + 20);
    expect(summary.byProvider.map((row) => row.providerId)).toEqual(['groq']);
    expect(summary.byModel).toHaveLength(2);
    expect(summary.series).toHaveLength(1);
    expect(summary.series[0].requests).toBe(2);

    const workSeries = getDailyStatsByProvider(1, 'work');
    expect(workSeries).toEqual([
      expect.objectContaining({ providerId: 'cerebras', requests: 1, tokens: 400 }),
    ]);
  });

  it('densifies the series so a chart keeps every day in the window', () => {
    insertCall();
    const summary = getCostSummary({ days: 7, profileId: 'default' });
    expect(summary.series).toHaveLength(7);
    expect(summary.series.filter((point) => point.requests === 0)).toHaveLength(6);
  });

  it('merges configured ceilings with live usage for the quota panel', () => {
    holder.db
      .prepare('INSERT INTO settings (key, value) VALUES (?,?)')
      .run('provider-quota:groq', JSON.stringify({ maxRequestsPerDay: 10, maxTokensPerDay: 5000 }));
    insertCall({ promptTokens: 100, completionTokens: 50 });

    holder.db
      .prepare(
        `INSERT INTO quota_tracking (profile_id, provider_id, model_id, period_start, period_end, request_count, token_count, cost_usd)
         VALUES ('default','groq','',?,?,'4',900,0)`
      )
      .run(new Date(Date.now() - 3600_000).toISOString(), new Date(Date.now() + 86400_000).toISOString());

    const rows = getProviderQuotaUsage('default');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      providerId: 'groq',
      limitRequests: 10,
      limitTokens: 5000,
      usedRequests: 4,
      usedTokens: 900,
      remainingRequests: 6,
      unbounded: false,
    });
    expect(rows[0].requestUsageRate).toBeCloseTo(0.4, 6);
  });

  it('shows a provider that only has a ceiling configured (no traffic yet)', () => {
    holder.db
      .prepare('INSERT INTO settings (key, value) VALUES (?,?)')
      .run('provider-quota:cerebras', JSON.stringify({ maxRequestsPerDay: 100 }));
    const rows = getProviderQuotaUsage('default');
    expect(rows[0]).toMatchObject({ providerId: 'cerebras', usedRequests: 0, limitRequests: 100 });
    expect(rows[0].tokenUsageRate).toBeNull();
  });

  it('keeps daily quota counters separate per profile', () => {
    const iso = (offset: number) => new Date(Date.now() + offset).toISOString();
    const start = iso(-3600_000);
    const end = iso(86400_000);

    createQuotaPersistence('work').save({
      providerId: 'groq',
      requestCount: 7,
      tokenCount: 700,
      costUsd: 0.01,
      periodStart: start,
      periodEnd: end,
    });
    createQuotaPersistence('personal').save({
      providerId: 'groq',
      requestCount: 1,
      tokenCount: 100,
      costUsd: 0,
      periodStart: start,
      periodEnd: end,
    });

    expect(createQuotaPersistence('work').load()).toEqual([
      expect.objectContaining({ providerId: 'groq', requestCount: 7, tokenCount: 700 }),
    ]);
    expect(createQuotaPersistence('personal').load()[0].requestCount).toBe(1);
    expect(createQuotaPersistence(() => 'work').load()[0].requestCount).toBe(7);
  });

  it('upserts the same window instead of inserting duplicates', () => {
    const persistence = createQuotaPersistence('default');
    const start = iso(-1000);
    const end = iso(86400_000);
    persistence.save({ providerId: 'groq', requestCount: 1, tokenCount: 10, periodStart: start, periodEnd: end });
    persistence.save({ providerId: 'groq', requestCount: 2, tokenCount: 20, periodStart: start, periodEnd: end });
    const loaded = persistence.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({ requestCount: 2, tokenCount: 20 });
  });

  it('aggregates the dashboard totals for the active profile', () => {
    insertCall({ requestId: 'd1', promptTokens: 1000, completionTokens: 500 });
    insertCall({ requestId: 'd2', status: 'error', promptTokens: 0, completionTokens: 0 });
    insertCall({ requestId: 'd3', providerId: 'cerebras', profileId: 'work' });

    const stats = getDashboardStats('default');
    expect(stats.totalRequests).toBe(2);
    expect(stats.successRate).toBeCloseTo(0.5, 6);
    expect(stats.totalTokensUsed).toBe(1500);
    expect(stats.totalCostUsd).toBe(0);
    expect(stats.totalCostSaved).toBeGreaterThan(0);
    expect(stats.availableModels).toBe(1);
    expect(stats.providerStats).toHaveLength(1);
    expect(stats.providerStats[0]).toMatchObject({
      providerId: 'groq',
      requestCount: 2,
      successCount: 1,
      errorCount: 1,
    });
    expect(stats.recentCalls).toHaveLength(2);
    // Cross-profile traffic must not leak into the totals.
    expect(getDashboardStats('work').totalRequests).toBe(1);

    const single = getProviderStatistics('groq', 'default');
    expect(single.requestCount).toBe(2);
    expect(single.avgDurationMs).toBe(120);

    const health = getProviderHealth(10, 'default');
    expect(health[0]).toMatchObject({ providerId: 'groq', successRate: 0.5 });
  });

  it('supports paging through call logs scoped to a profile', () => {
    for (let i = 0; i < 3; i++) insertCall({ requestId: `r${i}`, profileId: i === 2 ? 'work' : 'default' });
    const page = queryCallLogs({ profileId: 'default', limit: 10 });
    expect(page.total).toBe(2);
    expect(page.items.every((call) => call.profileId === 'default')).toBe(true);
    expect(page.items[0].savedCostUsd).toBeGreaterThan(0);
  });

  it('purgeOldLogs only touches call logs, leaving the audit trail to its own sweep', () => {
    insertCall();
    holder.db.prepare("UPDATE call_logs SET timestamp = '2020-01-01T00:00:00.000Z'").run();
    beginRequestAudit({ requestId: 'keep-me', route: '/v1/chat/completions' });
    holder.db.prepare("UPDATE request_audit SET started_at = '2020-01-01T00:00:00.000Z'").run();

    expect(purgeOldLogs(Date.now(), 30)).toBe(1);
    expect(listRequestAudit({ search: 'keep-me' }).total).toBe(1);
  });
});

function iso(offset: number): string {
  return new Date(Date.now() + offset).toISOString();
}

describe('audit query normalisation', () => {
  it('clamps pagination, status and free-text shapes before they reach SQL', () => {
    const query = normalizeAuditQuery({
      limit: 99999,
      offset: -5,
      status: 'not-a-status',
      providerId: '  groq  ',
      search: 'x'.repeat(500),
      from: '2026-10-01T00:00:00.000Z',
      to: 'drop table',
      failuresOnly: true,
    });

    expect(query.limit).toBe(MAX_AUDIT_PAGE_SIZE);
    expect(query.offset).toBe(0);
    expect(query.status).toBeUndefined();
    expect(query.providerId).toBe('groq');
    expect(query.search).toHaveLength(80);
    expect(query.from).toBe('2026-10-01T00:00:00.000Z');
    expect(query.to).toBeUndefined();
    expect(query.failuresOnly).toBe(true);
  });

  it('accepts nothing but plain objects', () => {
    expect(normalizeAuditQuery(undefined)).toEqual({});
    expect(normalizeAuditQuery('status=error')).toEqual({});
  });
});
