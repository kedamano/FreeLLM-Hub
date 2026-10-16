import { deleteOldLogs } from './usage-recorder.js';
import { deleteOldAuditRecords } from './audit-recorder.js';
import { readSetting } from '../core/settings/settings-store.js';

export const LOG_RETENTION_SETTING_KEY = 'log_retention_days';
export const DEFAULT_LOG_RETENTION_DAYS = 30;
const DEFAULT_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function resolveRetentionDays(raw: string | null = readSetting(LOG_RETENTION_SETTING_KEY)): number {
  const days = Number(raw);
  if (!Number.isFinite(days) || days <= 0) return DEFAULT_LOG_RETENTION_DAYS;
  return Math.min(Math.floor(days), 3650);
}

export interface PurgeResult {
  callLogs: number;
  auditRequests: number;
}

/**
 * Delete call logs *and* the gateway audit trail older than the configured
 * retention window. Auditing would otherwise grow without bound and quietly fill
 * the user's disk, since it keeps an event row per routing decision.
 */
export function purgeOldLogs(now: number = Date.now(), days: number = resolveRetentionDays()): number {
  const cutoff = new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
  return deleteOldLogs(cutoff);
}

export function purgeAuditAndLogs(now: number = Date.now(), days: number = resolveRetentionDays()): PurgeResult {
  const cutoff = new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
  const result: PurgeResult = { callLogs: 0, auditRequests: 0 };
  result.callLogs = deleteOldLogs(cutoff);
  try {
    result.auditRequests = deleteOldAuditRecords(cutoff);
  } catch {
    /* audit table may be mid-migration on a first run; the next sweep retries */
  }
  return result;
}

/**
 * Sweep once now and then on a fixed interval. Returns a dispose function so both the
 * Electron main process and the standalone web server can stop the timer on shutdown.
 */
export function startLogRetentionSchedule(
  intervalMs: number = DEFAULT_SWEEP_INTERVAL_MS
): () => void {
  const sweep = () => {
    try {
      const removed = purgeAuditAndLogs();
      if (removed.callLogs > 0 || removed.auditRequests > 0) {
        console.log(
          `[Usage] 已清理 ${removed.callLogs} 条过期调用记录、${removed.auditRequests} 条请求审计`
        );
      }
    } catch (err) {
      console.warn('[Usage] 调用记录清理失败:', err instanceof Error ? err.message : err);
    }
  };

  sweep();
  const timer = setInterval(sweep, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  return () => clearInterval(timer);
}
