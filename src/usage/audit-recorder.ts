import { redactSecrets } from '../main/security/secret-redaction.js';
import { getActiveProfileId } from '../core/settings/profile-store.js';
import { prepared } from '../core/database/statement-cache.js';
import { queueWrite, readDatabase } from './write-buffer.js';
import type { ProviderId, TaskType } from '../shared/types/index.js';
import type {
  AuditEventType,
  AuditListResult,
  AuditQuery,
  AuditStatus,
  AuditSummary,
  RequestAuditEvent,
  RequestAuditRecord,
} from '../shared/types/observability.js';
import { AUDIT_EVENT_TYPES, AUDIT_STATUSES } from '../shared/types/observability.js';

/**
 * Gateway-side request auditing.
 *
 * `call_logs` is the billing-ish ledger: one row per provider attempt that the
 * scheduler actually dispatched. It cannot answer "what happened to this request"
 * because requests rejected before dispatch (bad token, invalid body, unknown
 * route) never reach it, and the candidate that lost on quota/circuit/rate-limit is
 * invisible. `request_audit` is one row per gateway request, with an ordered
 * `request_audit_events` trail explaining every decision inside it.
 *
 * The payload shapes are declared once in `src/shared/types/observability.ts` because
 * the renderer may only import from `src/shared`; they are re-exported here so
 * main-process callers keep a single import site.
 *
 * Auditing must never take down the data path, so every write is best-effort and
 * failures are swallowed into a returned boolean rather than thrown.
 */

export { AUDIT_EVENT_TYPES, AUDIT_STATUSES };
export type {
  AuditEventType,
  AuditListResult,
  AuditQuery,
  AuditStatus,
  AuditSummary,
  RequestAuditEvent,
  RequestAuditRecord,
};

export interface BeginAuditInput {
  requestId: string;
  route: string;
  method?: string;
  stream?: boolean;
  requestedModel?: string;
  taskType?: TaskType;
  profileId?: string;
  clientAddress?: string;
  /** Non-message request parameters (max_tokens, temperature, tools, ...). */
  params?: Record<string, unknown>;
}

export interface AuditEventInput {
  requestId: string;
  event: AuditEventType;
  providerId?: ProviderId;
  modelId?: string;
  attempt?: number;
  status?: string;
  statusCode?: number;
  reason?: string;
  durationMs?: number;
  detail?: unknown;
}

export interface CompleteAuditInput {
  requestId: string;
  status: AuditStatus;
  statusCode?: number;
  providerId?: ProviderId;
  modelId?: string;
  attempts?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  durationMs?: number;
  timeToFirstTokenMs?: number;
  errorCode?: string;
  errorMessage?: string;
  costUsd?: number;
  savedCostUsd?: number;
}


interface AuditRow {
  request_id: string;
  profile_id: string | null;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  route: string;
  method: string | null;
  stream: number | null;
  requested_model: string | null;
  task_type: string | null;
  status: string;
  status_code: number | null;
  provider_id: string | null;
  model_id: string | null;
  attempts: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  time_to_first_token_ms: number | null;
  error_code: string | null;
  error_message: string | null;
  cost_usd: number | null;
  saved_cost_usd: number | null;
  params: string | null;
  client_address: string | null;
}

function safeStringify(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  try {
    return redactSecrets(JSON.stringify(value)).slice(0, 4000);
  } catch {
    return null;
  }
}

function parseJsonObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function mapAuditRow(row: AuditRow): RequestAuditRecord {
  return {
    requestId: row.request_id,
    profileId: row.profile_id ?? 'default',
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? null,
    durationMs: Number(row.duration_ms ?? 0),
    route: row.route,
    method: row.method ?? 'POST',
    stream: Number(row.stream ?? 0) === 1,
    requestedModel: row.requested_model,
    taskType: row.task_type,
    status: row.status as AuditStatus,
    statusCode: row.status_code,
    providerId: row.provider_id,
    modelId: row.model_id,
    attempts: Number(row.attempts ?? 0),
    promptTokens: Number(row.prompt_tokens ?? 0),
    completionTokens: Number(row.completion_tokens ?? 0),
    totalTokens: Number(row.total_tokens ?? 0),
    timeToFirstTokenMs: row.time_to_first_token_ms === null ? null : Number(row.time_to_first_token_ms),
    errorCode: row.error_code,
    errorMessage: row.error_message,
    costUsd: Number(row.cost_usd ?? 0),
    savedCostUsd: Number(row.saved_cost_usd ?? 0),
    params: parseJsonObject(row.params),
    clientAddress: row.client_address,
  };
}

/** Redact anything that looks like a secret before it is written to the audit trail. */
function sanitize(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  return redactSecrets(text).slice(0, 500);
}

const INSERT_AUDIT_SQL = `
  INSERT INTO request_audit (
    request_id, profile_id, started_at, route, method, stream, requested_model, task_type,
    status, params, client_address
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'in_progress', ?, ?)
  ON CONFLICT(request_id) DO NOTHING
`;

const INSERT_EVENT_SQL = `
  INSERT INTO request_audit_events
    (request_id, seq, at, event, provider_id, model_id, attempt, status, status_code, reason, duration_ms, detail)
  VALUES (?,
          (SELECT COALESCE(MAX(seq), 0) + 1 FROM request_audit_events WHERE request_id = ?),
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

interface QueuedEvent {
  requestId: string;
  at: string;
  event: AuditEventType | string;
  providerId?: ProviderId | null;
  modelId?: string | null;
  attempt?: number | null;
  status?: string | null;
  statusCode?: number | null;
  reason?: string | null;
  durationMs?: number | null;
  detail?: string | null;
}

/** `seq` is derived inside the statement, so queued events keep their enqueue order. */
function queueAuditEventWrite(input: QueuedEvent): void {
  queueWrite((db) =>
    prepared(db, INSERT_EVENT_SQL).run(
      input.requestId,
      input.requestId,
      input.at,
      input.event,
      input.providerId ?? null,
      input.modelId ?? null,
      input.attempt ?? null,
      input.status ?? null,
      input.statusCode ?? null,
      input.reason ?? null,
      input.durationMs ?? null,
      input.detail ?? null
    )
  );
}

/**
 * Open the audit record for a request. Called as soon as the request id exists —
 * including for requests that are about to be rejected, which is precisely the
 * traffic the old `call_logs` ledger never saw.
 */
export function beginRequestAudit(input: BeginAuditInput): boolean {
  try {
    const startedAt = new Date().toISOString();
    const profileId = input.profileId ?? getActiveProfileId();
    queueWrite((db) =>
      prepared(db, INSERT_AUDIT_SQL).run(
        input.requestId,
        profileId,
        startedAt,
        input.route,
        input.method ?? 'POST',
        input.stream ? 1 : 0,
        input.requestedModel ?? null,
        input.taskType ?? null,
        safeStringify(input.params),
        input.clientAddress ?? null
      )
    );
    recordAuditEvent({
      requestId: input.requestId,
      event: 'request.received',
      detail: { route: input.route, stream: Boolean(input.stream) },
    });
    return true;
  } catch {
    return false;
  }
}

export function recordAuditEvent(input: AuditEventInput): boolean {
  try {
    queueAuditEventWrite({
      requestId: input.requestId,
      at: new Date().toISOString(),
      event: input.event,
      providerId: input.providerId ?? null,
      modelId: input.modelId ?? null,
      attempt: input.attempt ?? null,
      status: input.status ?? null,
      statusCode: input.statusCode ?? null,
      reason: input.reason ? sanitize(input.reason) ?? null : null,
      durationMs: input.durationMs ?? null,
      detail: safeStringify(input.detail),
    });
    return true;
  } catch {
    return false;
  }
}

const UPDATE_AUDIT_SQL = `
  UPDATE request_audit SET
    finished_at = ?,
    duration_ms = COALESCE(?, duration_ms),
    status = ?,
    status_code = COALESCE(?, status_code),
    provider_id = COALESCE(?, provider_id),
    model_id = COALESCE(?, model_id),
    attempts = COALESCE(?, attempts),
    prompt_tokens = COALESCE(?, prompt_tokens),
    completion_tokens = COALESCE(?, completion_tokens),
    total_tokens = COALESCE(?, total_tokens),
    time_to_first_token_ms = COALESCE(?, time_to_first_token_ms),
    error_code = COALESCE(?, error_code),
    error_message = COALESCE(?, error_message),
    cost_usd = COALESCE(?, cost_usd),
    saved_cost_usd = COALESCE(?, saved_cost_usd)
  WHERE request_id = ?
`;

export function completeRequestAudit(input: CompleteAuditInput): boolean {
  try {
    const finishedAt = new Date().toISOString();
    const errorMessage = input.errorMessage ? sanitize(input.errorMessage) ?? null : null;
    queueWrite((db) =>
      prepared(db, UPDATE_AUDIT_SQL).run(
        finishedAt,
        input.durationMs ?? null,
        input.status,
        input.statusCode ?? null,
        input.providerId ?? null,
        input.modelId ?? null,
        input.attempts ?? null,
        input.promptTokens ?? null,
        input.completionTokens ?? null,
        input.totalTokens ?? null,
        input.timeToFirstTokenMs ?? null,
        input.errorCode ?? null,
        errorMessage,
        input.costUsd ?? null,
        input.savedCostUsd ?? null,
        input.requestId
      )
    );
    queueAuditEventWrite({
      requestId: input.requestId,
      at: finishedAt,
      event: input.status === 'success' ? 'request.completed' : 'request.failed',
      providerId: input.providerId ?? null,
      modelId: input.modelId ?? null,
      status: input.status,
      statusCode: input.statusCode ?? null,
      reason: input.errorCode ?? null,
      durationMs: input.durationMs ?? null,
    });
    return true;
  } catch {
    return false;
  }
}

/** One-shot audit write for traffic rejected before dispatch (auth, bad body, unknown route). */
export function auditRejectedRequest(
  input: BeginAuditInput & { statusCode: number; errorCode: string; errorMessage?: string }
): boolean {
  beginRequestAudit(input);
  recordAuditEvent({
    requestId: input.requestId,
    event: 'request.rejected',
    statusCode: input.statusCode,
    reason: input.errorCode,
    detail: { message: sanitize(input.errorMessage) },
  });
  return completeRequestAudit({
    requestId: input.requestId,
    status: 'rejected',
    statusCode: input.statusCode,
    errorCode: input.errorCode,
    errorMessage: input.errorMessage,
    durationMs: 0,
  });
}

function buildWhere(query: AuditQuery): { sql: string; values: Array<string | number> } {
  const clauses: string[] = [];
  const values: Array<string | number> = [];

  if (query.profileId) {
    clauses.push('profile_id = ?');
    values.push(query.profileId);
  }
  if (query.status) {
    clauses.push('status = ?');
    values.push(query.status);
  }
  if (query.providerId) {
    clauses.push('provider_id = ?');
    values.push(query.providerId);
  }
  if (query.modelId) {
    clauses.push('model_id = ?');
    values.push(query.modelId);
  }
  if (query.requestId) {
    clauses.push('request_id = ?');
    values.push(query.requestId);
  }
  if (query.from) {
    clauses.push('started_at >= ?');
    values.push(query.from);
  }
  if (query.to) {
    clauses.push('started_at <= ?');
    values.push(query.to);
  }
  if (query.failuresOnly) {
    clauses.push("status <> 'success'");
  }
  if (query.search) {
    clauses.push(
      '(request_id LIKE ? OR provider_id LIKE ? OR model_id LIKE ? OR error_message LIKE ? OR error_code LIKE ?)'
    );
    const like = `%${query.search.slice(0, 120)}%`;
    values.push(like, like, like, like, like);
  }

  return { sql: clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '', values };
}

const MAX_AUDIT_PAGE_SIZE = 500;

export function listRequestAudit(query: AuditQuery = {}): AuditListResult {
  const db = readDatabase();
  const { sql, values } = buildWhere(query);
  const limit = Math.min(Math.max(query.limit ?? 50, 1), MAX_AUDIT_PAGE_SIZE);
  const offset = Math.max(query.offset ?? 0, 0);

  const total = (
    db.prepare(`SELECT COUNT(*) as count FROM request_audit${sql}`).get(...values) as {
      count: number;
    }
  ).count;

  const rows = db
    .prepare(`SELECT * FROM request_audit${sql} ORDER BY started_at DESC LIMIT ? OFFSET ?`)
    .all(...values, limit, offset) as AuditRow[];

  return { total, items: rows.map(mapAuditRow) };
}

export function getRequestAuditDetail(requestId: string): { request: RequestAuditRecord; events: RequestAuditEvent[] } | null {
  const db = readDatabase();
  const row = db.prepare('SELECT * FROM request_audit WHERE request_id = ?').get(requestId) as
    | AuditRow
    | undefined;
  if (!row) return null;

  const eventRows = db
    .prepare('SELECT * FROM request_audit_events WHERE request_id = ? ORDER BY seq ASC')
    .all(requestId) as Array<{
    seq: number;
    at: string;
    event: string;
    provider_id: string | null;
    model_id: string | null;
    attempt: number | null;
    status: string | null;
    status_code: number | null;
    reason: string | null;
    duration_ms: number | null;
    detail: string | null;
  }>;

  return {
    request: mapAuditRow(row),
    events: eventRows.map((event) => ({
      seq: event.seq,
      at: event.at,
      event: event.event,
      providerId: event.provider_id,
      modelId: event.model_id,
      attempt: event.attempt,
      status: event.status,
      statusCode: event.status_code,
      reason: event.reason,
      durationMs: event.duration_ms,
      detail: decodeDetail(event.detail),
    })),
  };
}

/** Event payloads are stored as redacted JSON text; decode them back for the UI. */
function decodeDetail(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function percentile(sortedValues: number[], fraction: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(sortedValues.length * fraction) - 1));
  return Math.round(sortedValues[index]);
}

/** A still-running request must not be counted as a failure by the panel. */
function classifyCounts(row: { status: string; duration_ms: number | null }) {
  const isSuccess = row.status === 'success';
  const isInFlight = row.status === 'in_progress';
  return { isSuccess, isInFlight, duration: Number(row.duration_ms ?? 0) };
}

export function getAuditSummary(options: { days?: number; profileId?: string } = {}): AuditSummary {
  const days = Math.min(Math.max(options.days ?? 7, 1), 365);
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const db = readDatabase();
  const profileId = options.profileId ?? getActiveProfileId();
  const scopeValues: string[] = [cutoff, profileId];
  const scopeSql = 'WHERE started_at >= ? AND (profile_id = ? OR profile_id IS NULL)';

  const rows = db
    .prepare(
      `SELECT status, duration_ms, total_tokens, cost_usd, saved_cost_usd, time_to_first_token_ms
       FROM request_audit ${scopeSql}`
    )
    .all(...scopeValues) as Array<{
    status: string;
    duration_ms: number | null;
    total_tokens: number | null;
    cost_usd: number | null;
    saved_cost_usd: number | null;
    time_to_first_token_ms: number | null;
  }>;

  const durations: number[] = [];
  const ttftValues: number[] = [];
  let success = 0;
  let inFlight = 0;
  let settled = 0;
  let totalTokens = 0;
  let costUsd = 0;
  let savedCostUsd = 0;

  const statusCounts = new Map<string, number>();
  for (const row of rows) {
    const { isSuccess, isInFlight, duration } = classifyCounts(row);
    statusCounts.set(row.status, (statusCounts.get(row.status) ?? 0) + 1);
    if (isInFlight) inFlight += 1;
    else settled += 1;
    if (isSuccess) success += 1;
    if (!isInFlight) durations.push(duration);
    if (row.time_to_first_token_ms !== null && row.time_to_first_token_ms > 0) {
      ttftValues.push(Number(row.time_to_first_token_ms));
    }
    totalTokens += Number(row.total_tokens ?? 0);
    costUsd += Number(row.cost_usd ?? 0);
    savedCostUsd += Number(row.saved_cost_usd ?? 0);
  }

  durations.sort((a, b) => a - b);
  ttftValues.sort((a, b) => a - b);

  const byStatus = [...statusCounts.entries()]
    .map(([status, count]) => ({ status, count }))
    .sort((a, b) => b.count - a.count);

  const topErrors = (
    db
      .prepare(
        `SELECT COALESCE(error_code, 'UNKNOWN') as code, error_message as message, COUNT(*) as count
         FROM request_audit ${scopeSql} AND status NOT IN ('success', 'in_progress')
         GROUP BY code, message ORDER BY count DESC LIMIT 5`
      )
      .all(...scopeValues) as Array<{ code: string; message: string | null; count: number }>
  ).map((row) => ({ code: row.code, message: row.message ?? '', count: row.count }));

  const providerBreakdown = (
    db
      .prepare(
        `SELECT provider_id,
                COUNT(*) as requests,
                SUM(CASE WHEN status = 'success' THEN 0 ELSE 1 END) as failures,
                SUM(total_tokens) as tokens,
                AVG(duration_ms) as avg_duration,
                SUM(cost_usd) as cost
         FROM request_audit ${scopeSql} AND provider_id IS NOT NULL
         GROUP BY provider_id ORDER BY requests DESC LIMIT 20`
      )
      .all(...scopeValues) as Array<{
        provider_id: string;
        requests: number;
        failures: number;
        tokens: number | null;
        avg_duration: number | null;
        cost: number | null;
      }>
  ).map((row) => ({
    providerId: row.provider_id,
    requests: row.requests,
    failures: Number(row.failures ?? 0),
    tokens: Number(row.tokens ?? 0),
    avgDurationMs: Math.round(Number(row.avg_duration ?? 0)),
    costUsd: Number(row.cost ?? 0),
  }));

  const volumeSeries = (
    db
      .prepare(
        `SELECT date(started_at) as day,
                COUNT(*) as requests,
                SUM(CASE WHEN status = 'success' THEN 0 ELSE 1 END) as failures,
                SUM(total_tokens) as tokens
         FROM request_audit ${scopeSql}
         GROUP BY date(started_at) ORDER BY day ASC`
      )
      .all(...scopeValues) as Array<{ day: string; requests: number; failures: number; tokens: number | null }>
  ).map((row) => ({
    date: row.day,
    requests: row.requests,
    failures: Number(row.failures ?? 0),
    tokens: Number(row.tokens ?? 0),
  }));

  const total = rows.length;
  const avgDurationMs = durations.length > 0
    ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length)
    : 0;

  return {
    windowDays: days,
    requests: total,
    inFlight,
    successRate: settled > 0 ? success / settled : 0,
    failureRate: settled > 0 ? (settled - success) / settled : 0,
    avgDurationMs,
    p50DurationMs: percentile(durations, 0.5),
    p95DurationMs: percentile(durations, 0.95),
    avgTimeToFirstTokenMs:
      ttftValues.length > 0
        ? Math.round(ttftValues.reduce((sum, value) => sum + value, 0) / ttftValues.length)
        : null,
    totalTokens,
    costUsd: Number(costUsd.toFixed(6)),
    savedCostUsd: Number(savedCostUsd.toFixed(6)),
    byStatus,
    topErrors,
    providerBreakdown,
    volumeSeries,
  };
}

/** Count of requests still marked in_progress — stale rows mean a crash mid-request. */
export function getInFlightRequestCount(): number {
  try {
    const db = readDatabase();
    const row = db
      .prepare("SELECT COUNT(*) as count FROM request_audit WHERE status = 'in_progress'")
      .get() as { count: number };
    return row.count;
  } catch {
    return 0;
  }
}

/**
 * Delete audit rows older than the cutoff. Events are removed by joining on the
 * parent request ids so the trail never outlives its request.
 */
export function deleteOldAuditRecords(cutoffIso: string): number {
  const db = readDatabase();
  const run = db.transaction(() => {
    db.prepare(
      `DELETE FROM request_audit_events
        WHERE request_id IN (SELECT request_id FROM request_audit WHERE started_at < ?)`
    ).run(cutoffIso);
    const result = db.prepare('DELETE FROM request_audit WHERE started_at < ?').run(cutoffIso);
    return result.changes;
  });
  return run();
}

/** Collapse a stream of scheduler trace events into the audit tables. */
export function auditProviderSkip(input: {
  requestId: string;
  providerId: ProviderId;
  modelId: string;
  reason: string;
  score?: number;
}): void {
  recordAuditEvent({
    requestId: input.requestId,
    event: 'candidate.skipped',
    providerId: input.providerId,
    modelId: input.modelId,
    reason: input.reason,
    detail: input.score === undefined ? undefined : { score: input.score },
  });
}
