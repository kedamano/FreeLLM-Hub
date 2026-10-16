export interface RateLimitLimits {
  requestsPerMinute?: number;
  tokensPerMinute?: number;
}

interface RateLimitState {
  tokens: number;
  lastRefill: number;
  requestCount: number;
  requestWindowStart: number;
}

export class RateLimiter {
  private states = new Map<string, RateLimitState>();

  constructor(
    private maxTokensPerMinute: number = 100000,
    private maxRequestsPerMinute: number = 30
  ) {}

  canProceed(key: string, estimatedTokens: number = 100, limits?: RateLimitLimits): boolean {
    const state = this.getOrCreateState(key);
    this.refill(state);

    const maxRequests = limits?.requestsPerMinute ?? this.maxRequestsPerMinute;
    const maxTokens = limits?.tokensPerMinute ?? this.maxTokensPerMinute;

    if (state.requestCount >= maxRequests) {
      return false;
    }

    if (state.tokens + estimatedTokens > maxTokens) {
      return false;
    }

    state.requestCount += 1;
    state.tokens += estimatedTokens;

    return true;
  }

  check(key: string, estimatedTokens: number = 100, limits?: RateLimitLimits): boolean {
    const state = this.getOrCreateState(key);
    this.refill(state);

    const maxRequests = limits?.requestsPerMinute ?? this.maxRequestsPerMinute;
    const maxTokens = limits?.tokensPerMinute ?? this.maxTokensPerMinute;

    return (
      state.requestCount < maxRequests && state.tokens + estimatedTokens <= maxTokens
    );
  }

  record(key: string, deltaTokens: number): void {
    const state = this.getOrCreateState(key);
    this.refill(state);
    state.tokens = Math.max(0, state.tokens + deltaTokens);
  }

  getRetryAfter(key: string): number {
    const state = this.states.get(key);
    if (!state) return 0;

    const now = Date.now();
    const windowEnd = state.requestWindowStart + 60000;
    return Math.max(0, windowEnd - now);
  }

  reset(key: string): void {
    this.states.delete(key);
  }

  private getOrCreateState(key: string): RateLimitState {
    let state = this.states.get(key);
    if (!state) {
      state = {
        tokens: 0,
        lastRefill: Date.now(),
        requestCount: 0,
        requestWindowStart: Date.now(),
      };
      this.states.set(key, state);
    }
    return state;
  }

  private refill(state: RateLimitState): void {
    const now = Date.now();
    const elapsed = now - state.requestWindowStart;

    if (elapsed >= 60000) {
      state.tokens = 0;
      state.requestCount = 0;
      state.requestWindowStart = now;
    }

    state.lastRefill = now;
  }
}
