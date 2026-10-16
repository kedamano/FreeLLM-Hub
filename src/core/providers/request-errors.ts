import {
  AuthenticationError,
  ProviderError,
  RateLimitError,
} from '../../shared/errors/index.js';

export const DEFAULT_REQUEST_TIMEOUT_MS = 60000;

export function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

export function withRequestTimeout(
  signal?: AbortSignal,
  timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeoutSignal;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, timeoutSignal]);

  const controller = new AbortController();
  if (signal.aborted) {
    controller.abort(signal.reason);
    return controller.signal;
  }
  signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  timeoutSignal.addEventListener('abort', () => controller.abort(timeoutSignal.reason), {
    once: true,
  });
  return controller.signal;
}

export function mapHttpError(
  providerId: string,
  status: number,
  body: string,
  retryAfterMs?: number
): ProviderError {
  const details = { status, body: body.slice(0, 300) };

  if (status === 429) return new RateLimitError(providerId, retryAfterMs);
  if (status === 401 || status === 403) return new AuthenticationError(providerId, `HTTP ${status}`);
  if (status === 404) {
    return new ProviderError(`Model not found at ${providerId}`, providerId, 'MODEL_NOT_FOUND', details);
  }
  if (status === 408) return new ProviderError(`Timeout from ${providerId}`, providerId, 'TIMEOUT', details);
  if (status >= 500) {
    return new ProviderError(
      `Provider ${providerId} returned server error (HTTP ${status})`,
      providerId,
      'SERVER_ERROR',
      details
    );
  }
  return new ProviderError(
    `Provider ${providerId} rejected the request (HTTP ${status})`,
    providerId,
    'BAD_REQUEST',
    details
  );
}

export function mapNetworkError(providerId: string, err: unknown): ProviderError {
  const name = err instanceof Error ? err.name : '';
  const message = err instanceof Error ? err.message : String(err);

  if (name === 'TimeoutError' || name === 'AbortError') {
    return new ProviderError(`Request to ${providerId} timed out`, providerId, 'TIMEOUT', { message });
  }
  return new ProviderError(`Failed to reach ${providerId}`, providerId, 'NETWORK_ERROR', { message });
}
