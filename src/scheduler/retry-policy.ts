export interface RetryPolicyOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  retryableErrors: string[];
}

const DEFAULT_OPTIONS: RetryPolicyOptions = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
  retryableErrors: ['RATE_LIMITED', 'TIMEOUT', 'SERVER_ERROR', 'ALL_FAILED', 'NETWORK_ERROR'],
};

export class RetryPolicy {
  private options: RetryPolicyOptions;

  constructor(options?: Partial<RetryPolicyOptions>) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  shouldRetry(attempt: number, errorCode?: string): boolean {
    if (attempt >= this.options.maxRetries) return false;
    if (errorCode && !this.options.retryableErrors.includes(errorCode)) return false;
    return true;
  }

  getDelay(attempt: number): number {
    const delay = this.options.baseDelayMs * Math.pow(this.options.backoffMultiplier, attempt);
    return Math.min(delay, this.options.maxDelayMs);
  }

  getMaxRetries(): number {
    return this.options.maxRetries;
  }
}
