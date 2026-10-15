export class FreeLLMError extends Error {
  code: string;
  details?: Record<string, unknown>;

  constructor(message: string, code: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'FreeLLMError';
    this.code = code;
    this.details = details;
  }
}

export class ProviderError extends FreeLLMError {
  providerId: string;

  constructor(message: string, providerId: string, code: string, details?: Record<string, unknown>) {
    super(message, code, details);
    this.name = 'ProviderError';
    this.providerId = providerId;
  }
}

export class RateLimitError extends ProviderError {
  retryAfterMs?: number;

  constructor(providerId: string, retryAfterMs?: number) {
    super(
      `Rate limited by provider: ${providerId}`,
      providerId,
      'RATE_LIMITED',
      retryAfterMs ? { retryAfterMs } : undefined
    );
    this.name = 'RateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class AuthenticationError extends ProviderError {
  constructor(providerId: string, reason?: string) {
    super(
      `Authentication failed for provider: ${providerId}${reason ? ` - ${reason}` : ''}`,
      providerId,
      'AUTH_FAILED'
    );
    this.name = 'AuthenticationError';
  }
}

export class ModelNotFoundError extends FreeLLMError {
  modelId: string;

  constructor(modelId: string) {
    super(`Model not found: ${modelId}`, 'MODEL_NOT_FOUND', { modelId });
    this.name = 'ModelNotFoundError';
    this.modelId = modelId;
  }
}

export class AllProvidersFailedError extends FreeLLMError {
  errors: Array<{ providerId: string; error: string }>;

  constructor(errors: Array<{ providerId: string; error: string }>) {
    super('All providers failed to process the request', 'ALL_FAILED', { errors });
    this.name = 'AllProvidersFailedError';
    this.errors = errors;
  }
}

export class QuotaExceededError extends ProviderError {
  constructor(providerId: string) {
    super(`Quota exceeded for provider: ${providerId}`, providerId, 'QUOTA_EXCEEDED');
    this.name = 'QuotaExceededError';
  }
}

export class CircuitOpenError extends ProviderError {
  constructor(providerId: string) {
    super(`Circuit breaker open for provider: ${providerId}`, providerId, 'CIRCUIT_OPEN');
    this.name = 'CircuitOpenError';
  }
}
