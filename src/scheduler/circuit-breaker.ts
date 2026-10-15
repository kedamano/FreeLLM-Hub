export type CircuitState = 'closed' | 'open' | 'half-open';

interface BreakerState {
  state: CircuitState;
  failureCount: number;
  lastFailureAt: number;
  lastStateChangeAt: number;
}

export interface CircuitBreakerOptions {
  failureThreshold: number;
  resetTimeoutMs: number;
  halfOpenMaxRequests: number;
}

const DEFAULT_OPTIONS: CircuitBreakerOptions = {
  failureThreshold: 5,
  resetTimeoutMs: 60000,
  halfOpenMaxRequests: 1,
};

export class CircuitBreaker {
  private states = new Map<string, BreakerState>();
  private options: CircuitBreakerOptions;

  constructor(options?: Partial<CircuitBreakerOptions>) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  canExecute(key: string): boolean {
    const state = this.getState(key);

    switch (state.state) {
      case 'closed':
        return true;
      case 'open': {
        const elapsed = Date.now() - state.lastStateChangeAt;
        if (elapsed >= this.options.resetTimeoutMs) {
          state.state = 'half-open';
          state.lastStateChangeAt = Date.now();
          return true;
        }
        return false;
      }
      case 'half-open':
        return true;
    }
  }

  recordSuccess(key: string): void {
    const state = this.getState(key);
    state.failureCount = 0;
    state.state = 'closed';
    state.lastStateChangeAt = Date.now();
  }

  recordFailure(key: string): void {
    const state = this.getState(key);
    state.failureCount += 1;
    state.lastFailureAt = Date.now();

    if (state.failureCount >= this.options.failureThreshold) {
      state.state = 'open';
      state.lastStateChangeAt = Date.now();
    }
  }

  getState(key: string): BreakerState {
    let state = this.states.get(key);
    if (!state) {
      state = {
        state: 'closed',
        failureCount: 0,
        lastFailureAt: 0,
        lastStateChangeAt: Date.now(),
      };
      this.states.set(key, state);
    }
    return state;
  }

  isClosed(key: string): boolean {
    return this.getState(key).state === 'closed';
  }

  reset(key: string): void {
    this.states.delete(key);
  }

  resetAll(): void {
    this.states.clear();
  }
}
