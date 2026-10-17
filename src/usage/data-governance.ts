import { getDatabase } from '../core/database/database.js';
import { deleteOldAuditRecords } from './audit-recorder.js';
import { deleteOldLogs } from './usage-recorder.js';
import { readProfileSetting } from '../core/settings/profile-store.js';

/**
 * Data governance for the two append-only tables.
 *
 * One retention knob for both tables was the original sin: the audit trail (routing
 * decisions, one event row per candidate) grows several times faster than the call
 * ledger but is worth far less after a few days. So the retention window is split:
 *
 *   log_retention_days      call ledger (default 30)
 *   audit_retention_days    audit trail + events (default 7)
 *
 * Both accept 'off' (keep forever). Exports and manual wipes are here too, so the
 * settings page can offer a real "数据管理" section instead of sending users into
 * %APPDATA% with a file explorer.
 */

export const AUDIT_RETENTION_SETTING_KEY = 'audit_retention_days';

export type RetentionValue = number | 'off';

/** 'off' / 'forever' keep everything; anything numeric is a day count (capped at 3650). */
export function parseRetentionValue(raw: string | null, fallback: number): RetentionValue {
  if (raw === 'off' || raw === 'forever') return 'off';
  const days = Number(raw);
  if (!Number.isFinite(days) || days <= 0) return fallback;
  return Math.min(Math.floor(days), 3650);
}

export function resolveAuditRetention(raw: string | null = readProfileSetting(AUDIT_RETENTION_SETTING_KEY)): RetentionValue {
  return parseRetentionValue(raw, 7);
}

export function resolveLogRetention(raw: string | null): RetentionValue {
  return parseRetentionValue(raw, 30);
}

export interface PurgeSummary {
  callLogs: number;
  auditRequests: number;
  auditEvents: number;
}

/** Apply the split retention windows. `now`/`days` parameters keep this testable. */
export function purgeWithRetentionPolicies(
  now: number = Date.now(),
  logDays: RetentionValue = 30,
  auditDays: RetentionValue = 7
): PurgeSummary {
  const db = getDatabase();
  const summary: PurgeSummary = { callLogs: 0, auditRequests: 0, auditEvents: 0 };

  if (logDays !== 'off') {
    const cutoff = new Date(now - logDays * 86_400_000).toISOString();
    summary.callLogs = deleteOldLogs(cutoff);
  }

  if (auditDays !== 'off') {
    const cutoff = new Date(now - auditDays * 86_400_000).toISOString();
    try {
      summary.auditEvents = db
        .prepare(
          `DELETE FROM request_audit_events
            WHERE request_id IN (SELECT request_id FROM request_audit WHERE started_at < ?)`
        )
        .run(cutoff).changes;
      summary.auditRequests = db
        .prepare('DELETE FROM request_audit WHERE started_at < ?')
        .run(cutoff).changes;
    } catch {
      /* audit tables may be mid-migration on a first run; the next sweep retries */
    }
  }

  return summary;
}

export interface WipeResult {
  callLogs: number;
  auditRequests: number;
  auditEvents: number;
  quotaRows: number;
}

/** Manual wipe: everything the user produced, never configuration or credentials. */
export function wipeUserData(profileId?: string): WipeResult {
  const db = getDatabase();
  const result: WipeResult = { callLogs: 0, auditRequests: 0, auditEvents: 0, quotaRows: 0 };

  result.callLogs = profileId
    ? db.prepare("DELETE FROM call_logs WHERE COALESCE(profile_id, 'default') = ?").run(profileId).changes
    : db.prepare('DELETE FROM call_logs').run().changes;

  result.auditEvents = profileId
    ? db
        .prepare(
          `DELETE FROM request_audit_events
            WHERE request_id IN (SELECT request_id FROM request_audit WHERE COALESCE(profile_id, 'default') = ?)`
        )
        .run(profileId).changes
    : db.prepare('DELETE FROM request_audit_events').run().changes;
  result.auditRequests = profileId
    ? db
        .prepare("DELETE FROM request_audit WHERE COALESCE(profile_id, 'default') = ?")
        .run(profileId).changes
    : db.prepare('DELETE FROM request_audit').run().changes;

  result.quotaRows = profileId
    ? db.prepare('DELETE FROM quota_tracking WHERE COALESCE(profile_id, ?) = ?').run(profileId ?? 'default', profileId ?? 'default').changes
    : db.prepare('DELETE FROM quota_tracking').run().changes;

  return result;
}

export type ExportFormat = 'csv' | 'jsonl';

function csvCell(value: unknown): string {
  const str = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

/**
 * Export call logs as CSV (RFC 4180 quoting) or JSONL. Column order is fixed so
 * spreadsheets stay stable across versions.
 */
export function exportCallLogs(
  options: { profileId?: string; limit?: number; format?: ExportFormat } = {},
  now: Date = new Date()
): string {
  const db = getDatabase();
  const limit = Math.min(Math.max(options.limit ?? 10_000, 1), 100_000);
  const profileClause = options.profileId
    ? "WHERE COALESCE(profile_id, 'default') = ?"
    : '';
  const params = options.profileId ? [options.profileId, limit] : [limit];

  const rows = db
    .prepare(
      `SELECT id, request_id, timestamp, provider_id, model_id, task_type, status,
              duration_ms, prompt_tokens, completion_tokens, total_tokens, attempt,
              cost_usd, saved_cost_usd, pricing_type, currency, profile_id, error_message
       FROM call_logs ${profileClause}
       ORDER BY timestamp DESC LIMIT ?`
    )
    .all(...params) as Array<Record<string, unknown>>;

  if ((options.format ?? 'csv') === 'jsonl') {
    return rows
      .map((row) => JSON.stringify({ ...row, exported_at: now.toISOString() }))
      .join('\n');
  }

  const header = [
    'timestamp',
    'request_id',
    'provider',
    'model',
    'task_type',
    'status',
    'duration_ms',
    'prompt_tokens',
    'completion_tokens',
    'total_tokens',
    'attempt',
    'cost_usd',
    'saved_cost_usd',
    'pricing_type',
    'currency',
    'profile',
    'error',
  ];
  const lines = [header.join(',')];
  for (const row of rows) {
    lines.push(
      [
        row.timestamp,
        row.request_id,
        row.provider_id,
        row.model_id,
        row.task_type,
        row.status,
        row.duration_ms,
        row.prompt_tokens,
        row.completion_tokens,
        row.total_tokens,
        row.attempt,
        row.cost_usd,
        row.saved_cost_usd,
        row.pricing_type,
        row.currency,
        row.profile_id,
        row.error_message,
      ]
        .map(csvCell)
        .join(',')
    );
  }
  return lines.join('\r\n');
}
