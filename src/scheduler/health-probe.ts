/**
 * Active provider health probing.
 *
 * The circuit breaker is reactive: the first request that hits a dead provider pays the
 * latency (and the failure) for everyone. This probe asks each provider's `/models`
 * endpoint on a slow background cadence so the dashboard can say "Cerebras 目前探不通"
 * *before* a user request burns a retry chain on it.
 *
 * Deliberately a standalone class with injected targets: wiring it into the live
 * registry is a one-liner for whoever owns `scheduler.ts` at merge time, and every rule
 * here (thresholds, transitions, overlap protection) is testable without a network.
 */

export interface ProbeTarget {
  providerId: string;
  /** Cheap availability check; should resolve false rather than throw when down. */
  isAvailable: () => Promise<boolean>;
}

export interface ProbeResult {
  providerId: string;
  ok: boolean;
  latencyMs: number;
  checkedAt: string;
  /** 1-based count of consecutive failed probes; resets on success. */
  consecutiveFailures: number;
  /** Transition vs the previous round: these are the only interesting moments. */
  transition: 'up' | 'down' | 'still-down' | 'recovered' | null;
}

export interface HealthProbeOptions {
  targets: () => ProbeTarget[];
  intervalMs?: number;
  timeoutMs?: number;
  /** Consecutive failures before a provider is reported down (default 2). */
  failureThreshold?: number;
  now?: () => number;
  /** Only invoked on transitions (first crossing of the threshold, and recovery). */
  onTransition?: (result: ProbeResult) => void;
}

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_FAILURE_THRESHOLD = 2;

function withTimeout(promise: Promise<boolean>, timeoutMs: number, providerId: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    promise
      .then((ok) => {
        clearTimeout(timer);
        resolve(ok === true);
      })
      .catch(() => {
        clearTimeout(timer);
        resolve(false);
      });
    if (typeof timer.unref === 'function') timer.unref();
    void providerId;
  });
}

export class HealthProbe {
  private results = new Map<string, { ok: boolean; consecutiveFailures: number; latencyMs: number; checkedAt: string }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private roundInFlight = false;
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private readonly failureThreshold: number;

  constructor(private options: HealthProbeOptions) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
  }

  start(): () => void {
    if (this.timer) return () => this.stop();
    // First round runs immediately: a stale "all green" snapshot is worse than none.
    void this.runRound();
    this.timer = setInterval(() => void this.runRound(), this.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    return () => this.stop();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  snapshot(): ProbeResult[] {
    return [...this.results.entries()].map(([providerId, entry]) => ({
      providerId,
      ok: entry.ok,
      latencyMs: entry.latencyMs,
      checkedAt: entry.checkedAt,
      consecutiveFailures: entry.consecutiveFailures,
      transition: null,
    }));
  }

  isDown(providerId: string): boolean {
    const entry = this.results.get(providerId);
    return entry ? !entry.ok : false;
  }

  /** Probe every target once, in parallel. Overlapping rounds are skipped. */
  async probeNow(): Promise<ProbeResult[]> {
    await this.runRound();
    return this.snapshot();
  }

  private async runRound(): Promise<void> {
    if (this.roundInFlight) return;
    this.roundInFlight = true;
    try {
      const targets = this.options.targets() ?? [];
      await Promise.all(targets.map((target) => this.probeOne(target)));
    } finally {
      this.roundInFlight = false;
    }
  }

  private async probeOne(target: ProbeTarget): Promise<void> {
    const started = (this.options.now ?? Date.now)();
    const ok = await withTimeout(
      Promise.resolve(target.isAvailable()),
      this.timeoutMs,
      target.providerId
    );
    const latencyMs = (this.options.now ?? Date.now)() - started;
    const previous = this.results.get(target.providerId);
    const consecutiveFailures = ok ? 0 : (previous?.consecutiveFailures ?? 0) + 1;
    const checkedAt = new Date(this.options.now?.() ?? Date.now()).toISOString();

    const wasDown = previous ? !previous.ok : false;
    const isDown = !ok && consecutiveFailures >= this.failureThreshold;
    let transition: ProbeResult['transition'] = null;
    if (!previous) {
      // First sighting: a failure below the threshold is "unknown", not "up" - calling
      // it up would let the dashboard show green for a provider we never saw work.
      transition = isDown ? 'down' : null;
    } else if (wasDown && ok) {
      transition = 'recovered';
    } else if (!wasDown && isDown) {
      transition = 'down';
    } else if (wasDown && !ok) {
      transition = 'still-down';
    }

    this.results.set(target.providerId, { ok: isDown ? false : true, consecutiveFailures, latencyMs, checkedAt });

    const result: ProbeResult = {
      providerId: target.providerId,
      ok,
      latencyMs,
      checkedAt,
      consecutiveFailures,
      transition,
    };
    if (transition === 'down' || transition === 'recovered') {
      this.options.onTransition?.(result);
    }
  }
}
