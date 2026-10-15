import { getDatabase } from '../core/database/database.js';
import type { CallLog, ProviderId, TaskType } from '../shared/types/index.js';
import { generateId } from '../shared/utils/index.js';

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
}

export function recordCall(record: CallRecord): void {
  const db = getDatabase();
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
  };

  const stmt = db.prepare(
    `INSERT INTO call_logs (id, request_id, timestamp, provider_id, model_id, task_type, status, duration_ms, prompt_tokens, completion_tokens, error_message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  stmt.run(
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
    log.errorMessage || null
  );
}

export function getRecentCalls(limit: number = 100): CallLog[] {
  const db = getDatabase();
  const stmt = db.prepare('SELECT * FROM call_logs ORDER BY timestamp DESC LIMIT ?');
  return stmt.all(limit) as CallLog[];
}

export function getCallsByProvider(providerId: ProviderId, limit: number = 100): CallLog[] {
  const db = getDatabase();
  const stmt = db.prepare('SELECT * FROM call_logs WHERE provider_id = ? ORDER BY timestamp DESC LIMIT ?');
  return stmt.all(providerId, limit) as CallLog[];
}

export function deleteOldLogs(beforeTime: string): number {
  const db = getDatabase();
  const stmt = db.prepare('DELETE FROM call_logs WHERE timestamp < ?');
  const result = stmt.run(beforeTime);
  return result.changes;
}
