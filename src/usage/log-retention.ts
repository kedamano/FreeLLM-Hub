import { deleteOldLogs } from './usage-recorder.js';
import { readSetting } from '../core/settings/settings-store.js';

export const LOG_RETENTION_SETTING_KEY = 'log_retention_days';
export const DEFAULT_LOG_RETENTION_DAYS = 30;
const DEFAULT_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function resolveRetentionDays(raw: string | null = readSetting(LOG_RETENTION_SETTING_KEY)): number {
  const days = Number(raw);
  if (!Number.isFinite(days) || days <= 0) return DEFAULT_LOG_RETENTION_DAYS;
  return Math.min(Math.floor(days), 3650);
}

/** Delete call logs older than the configured retention window. Returns rows removed. */
export function purgeOldLogs(now: number = Date.now(), days: number = resolveRetentionDays()): number {
  const cutoff = new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
  return deleteOldLogs(cutoff);
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
      const removed = purgeOldLogs();
      if (removed > 0) console.log(`[Usage] 已清理 ${removed} 条过期调用记录`);
    } catch (err) {
      console.warn('[Usage] 调用记录清理失败:', err instanceof Error ? err.message : err);
    }
  };

  sweep();
  const timer = setInterval(sweep, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  return () => clearInterval(timer);
}
