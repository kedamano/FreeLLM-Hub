import { getDatabase } from '../core/database/database.js';
import type { CallLog, ModelPricingType, ProviderId, TaskType } from '../shared/types/index.js';
import { generateId } from '../shared/utils/index.js';
import { quoteCallCost } from './cost-model.js';
import { getActiveProfileId } from '../core/settings/profile-store.js';

export interface CallRecord {
  requestId: string;
  providerId: ProviderId;
  modelId: string;
  taskType?: TaskType;
  status: 'success' | 'error' | 'timeout' | 'rate_limited';
  durationMs: number;
  promptTokens: number;
  completionTokens: number;
  errorMessage?: string;
  /** HTTP status returned to the client, for correlation with the audit trail. */
  statusCode?: number;
  /** True when the response was streamed (SSE) rather than returned in one body. */
  stream?: boolean;
  /** Profile whose pool served this call; defaults to the active profile. */
  profileId?: string;
  /** 1-based attempt number within the request, so a fallback chain is legible. */
  attempt?: number;
  /** Override the derived total (upstream reported zero while billing nothing). */
  totalTokens?: number;
  /** Skip the pricing lookup when the caller already knows the cost. */
  cost?: { costUsd: number; referenceCostUsd: number; savedCostUsd: number; pricingType?: ModelPricingType; currency?: string };
}

const INSERT_CALL_LOG_SQL = `
  INSERT INTO call_logs (
    id, request_id, timestamp, provider_id, model_id, task_type, status, duration_ms,
    prompt_tokens, completion_tokens, error_message, profile_id, status_code, stream,
    total_tokens, attempt, cost_usd, reference_cost_usd, saved_cost_usd, pricing_type, currency
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

export function recordCall(record: CallRecord): void {
  const db = getDatabase();
  const totalTokens =
    record.totalTokens ?? record.promptTokens + record.completionTokens;
  const cost =
    record.cost ??
    quoteCallCost(record.providerId, record.modelId, {
      promptTokens: record.promptTokens,
      completionTokens: record.completionTokens,
    });

  const log: CallLog = {
    id: generateId(),
    requestId: record.requestId,
    timestamp: new Date().toISOString(),
    providerId: record.providerId,
    modelId: record.modelId,
    taskType: record.taskType,
    status: record.status,
    durationMs: record.durationMs,
    promptTokens: record.promptTokens,
    completionTokens: record.completionTokens,
    errorMessage: record.errorMessage,
    totalTokens,
    profileId: record.profileId ?? getActiveProfileId(),
    statusCode: record.statusCode,
    stream: record.stream,
    attempt: record.attempt,
    costUsd: cost.costUsd,
    referenceCostUsd: cost.referenceCostUsd,
    savedCostUsd: cost.savedCostUsd,
    pricingType: cost.pricingType,
    currency: cost.currency,
  };

  db.prepare(INSERT_CALL_LOG_SQL).run(
    log.id,
    log.requestId,
    log.timestamp,
    log.providerId,
    log.modelId,
    log.taskType || null,
    log.status,
    log.durationMs,
    log.promptTokens,
    log.completionTokens,
    log.errorMessage || null,
    log.profileId ?? null,
    log.statusCode ?? null,
    log.stream ? 1 : 0,
    log.totalTokens ?? 0,
    log.attempt ?? 1,
    log.costUsd ?? 0,
    cost.referenceCostUsd ?? 0,
    log.savedCostUsd ?? 0,
    log.pricingType ?? null,
    log.currency ?? 'USD'
  );
}

export interface CallLogRow {
  id: string;
  request_id: string;
  timestamp: string;
  provider_id: string;
  model_id: string;
  task_type: string | null;
  status: string;
  duration_ms: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  error_message: string | null;
  profile_id?: string | null;
  status_code?: number | null;
  stream?: number | null;
  total_tokens?: number | null;
  attempt?: number | null;
  cost_usd?: number | null;
  reference_cost_usd?: number | null;
  saved_cost_usd?: number | null;
  pricing_type?: string | null;
  currency?: string | null;
}

const CALL_STATUSES = ['success', 'error', 'timeout', 'rate_limited'];

export function mapCallLogRow(row: CallLogRow): CallLog {
  return {
    id: row.id,
    requestId: row.request_id,
    timestamp: row.timestamp,
    providerId: row.provider_id,
    modelId: row.model_id,
    taskType: (row.task_type ?? undefined) as CallLog['taskType'],
    status: (CALL_STATUSES.includes(row.status) ? row.status : 'error') as CallLog['status'],
    durationMs: Number(row.duration_ms ?? 0),
    promptTokens: Number(row.prompt_tokens ?? 0),
    completionTokens: Number(row.completion_tokens ?? 0),
    errorMessage: row.error_message ?? undefined,
    totalTokens: Number(row.total_tokens ?? (Number(row.prompt_tokens ?? 0) + Number(row.completion_tokens ?? 0))),
    profileId: row.profile_id ?? 'default',
    statusCode: row.status_code === null || row.status_code === undefined ? undefined : Number(row.status_code),
    stream: Number(row.stream ?? 0) === 1,
    attempt: row.attempt === null || row.attempt === undefined ? undefined : Number(row.attempt),
    costUsd: Number(row.cost_usd ?? 0),
    referenceCostUsd: Number(row.reference_cost_usd ?? 0),
    savedCostUsd: Number(row.saved_cost_usd ?? 0),
    pricingType: (row.pricing_type ?? undefined) as ModelPricingType | undefined,
    currency: row.currency ?? 'USD',
  };
}

export function getRecentCalls(limit: number = 100): CallLog[] {
  const db = getDatabase();
  const stmt = db.prepare('SELECT * FROM call_logs ORDER BY timestamp DESC LIMIT ?');
  return (stmt.all(limit) as CallLogRow[]).map(mapCallLogRow);
}

export function getCallsByProvider(providerId: ProviderId, limit: number = 100): CallLog[] {
  const db = getDatabase();
  const stmt = db.prepare('SELECT * FROM call_logs WHERE provider_id = ? ORDER BY timestamp DESC LIMIT ?');
  return (stmt.all(providerId, limit) as CallLogRow[]).map(mapCallLogRow);
}

/**
 * Call log query used by the usage page: optional profile and day window.
 * `call_logs.timestamp` is ISO-8601, so the window bound must be ISO too —
 * comparing against `datetime('now')` output mis-orders the boundary day.
 */
export interface CallLogQuery {
  limit?: number;
  offset?: number;
  profileId?: string;
  fromIso?: string;
  providerId?: ProviderId;
  modelId?: string;
  status?: CallLog['status'];
}

export function queryCallLogs(query: CallLogQuery = {}): { total: number; items: CallLog[] } {
  const db = getDatabase();
  const clauses: string[] = [];
  const values: Array<string | number> = [];

  if (query.profileId) {
    clauses.push("COALESCE(profile_id, 'default') = ?");
    values.push(query.profileId);
  }
  if (query.fromIso) {
    clauses.push('timestamp >= ?');
    values.push(query.fromIso);
  }
  if (query.providerId) {
    clauses.push('provider_id = ?');
    values.push(query.providerId);
  }
  if (query.modelId) {
    clauses.push('model_id = ?');
    values.push(query.modelId);
  }
  if (query.status) {
    clauses.push('status = ?');
    values.push(query.status);
  }

  const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
  const offset = Math.max(query.offset ?? 0, 0);

  const total = (
    db.prepare(`SELECT COUNT(*) as count FROM call_logs${where}`).get(...values) as { count: number }
  ).count;
  const rows = db
    .prepare(`SELECT * FROM call_logs${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`)
    .all(...values, limit, offset) as CallLogRow[];

  return { total, items: rows.map(mapCallLogRow) };
}

export function deleteOldLogs(beforeTime: string): number {
  const db = getDatabase();
  const stmt = db.prepare('DELETE FROM call_logs WHERE timestamp < ?');
  const result = stmt.run(beforeTime);
  return result.changes;
}
