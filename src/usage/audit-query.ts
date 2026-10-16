import { AUDIT_STATUSES, type AuditQuery } from './audit-recorder.js';

export const MAX_AUDIT_PAGE_SIZE = 500;

/**
 * Filter normalisation shared by the IPC layer and the web Admin API.
 *
 * Both entry points receive free-form filters from the renderer, so limits, status
 * values and LIKE terms are clamped here once rather than in two places — and this
 * module deliberately has no Electron dependency so `src/server` can import it.
 */
export function normalizeAuditQuery(input: unknown): AuditQuery {
  const raw = (input ?? {}) as Record<string, unknown>;
  const query: AuditQuery = {};

  const num = (value: unknown): number | undefined => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };

  const limit = num(raw.limit);
  if (limit !== undefined) query.limit = Math.min(Math.max(Math.floor(limit), 1), MAX_AUDIT_PAGE_SIZE);
  const offset = num(raw.offset);
  if (offset !== undefined) query.offset = Math.max(Math.floor(offset), 0);

  if (typeof raw.status === 'string' && (AUDIT_STATUSES as readonly string[]).includes(raw.status)) {
    query.status = raw.status as AuditQuery['status'];
  }

  for (const key of ['providerId', 'modelId', 'requestId', 'profileId', 'search'] as const) {
    const value = raw[key];
    if (typeof value === 'string' && value.trim()) query[key] = value.trim().slice(0, 80);
  }
  for (const key of ['from', 'to'] as const) {
    const value = raw[key];
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value.trim())) {
      query[key] = value.trim().slice(0, 40);
    }
  }
  if (raw.failuresOnly === true) query.failuresOnly = true;

  return query;
}

export function clampDays(value: string | number | undefined, fallback: number): number {
  const days = Number(value);
  if (!Number.isFinite(days) || days <= 0) return fallback;
  return Math.min(Math.floor(days), 365);
}
