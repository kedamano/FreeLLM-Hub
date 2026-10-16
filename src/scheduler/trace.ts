import type { ProviderId } from '../shared/types/index.js';

/**
 * Scheduler tracing.
 *
 * The scheduler used to make dozens of routing decisions per request — which
 * candidates were filtered, why a provider lost on circuit/rate-limit/quota, how many
 * retries happened — and then throw every one of them away, keeping at most the first
 * error. That is exactly the information needed to answer "why did my request go to
 * provider B" or "why is everything 429".
 *
 * A trace is an optional callback: nothing about routing behaviour changes when it is
 * absent, and the gateway supplies one that lands in `request_audit_events`.
 */

export type TraceStage =
  | 'candidate.skipped'
  | 'candidate.selected'
  | 'attempt.start'
  | 'attempt.success'
  | 'attempt.failed'
  | 'stream.started'
  | 'stream.first_token'
  | 'stream.failed'
  | 'credential.rotated';

export type SkipReason =
  | 'disabled'
  | 'no_adapter'
  | 'circuit_open'
  | 'rate_limited'
  | 'rate_limit_slot_taken'
  | 'quota_exceeded'
  | 'already_attempted'
  | 'no_candidates';

export interface TraceEvent {
  stage: TraceStage;
  providerId?: ProviderId;
  modelId?: string;
  attempt?: number;
  reason?: SkipReason | string;
  score?: number;
  durationMs?: number;
  statusCode?: number;
  message?: string;
  detail?: Record<string, unknown>;
}

export interface SchedulerTrace {
  emit(event: TraceEvent): void;
}

/** Never let a failing audit sink break routing. */
export function safeTrace(trace: SchedulerTrace | undefined): SchedulerTrace | undefined {
  if (!trace) return undefined;
  return {
    emit: (event) => {
      try {
        trace.emit(event);
      } catch {
        /* auditing is best-effort */
      }
    },
  };
}

export function traceEvent(
  trace: SchedulerTrace | undefined,
  event: TraceEvent
): void {
  safeTrace(trace)?.emit(event);
}
