/**
 * IPC/REST handlers never throw across the bridge: a failure arrives as a
 * `{ success: false, error }` payload that must never be treated as data.
 */
function isFailure(result: unknown): result is { success: false; error?: string } {
  return (
    typeof result === 'object' &&
    result !== null &&
    (result as { success?: unknown }).success === false
  );
}

/** For read paths: returns null instead of an error payload dressed up as data. */
export function unwrapIpc<T>(result: unknown): T | null {
  if (result === null || result === undefined) return null;
  return isFailure(result) ? null : (result as T);
}

export function unwrapIpcList<T>(result: unknown): T[] {
  return unwrapIpc<T[]>(result) ?? [];
}

/** For write paths: turns a failure payload into a thrown error the UI can toast. */
export function assertOk<T extends { success?: boolean; error?: string }>(
  result: T | null | undefined,
  fallback: string
): void {
  if (isFailure(result)) throw new Error(result.error || fallback);
}

/** For reads whose payload must exist: a failure payload throws instead of looking like empty data. */
export function unwrapOrThrow<T>(result: unknown, fallback: string): T {
  if (isFailure(result)) throw new Error(result.error || fallback);
  if (result === null || result === undefined) throw new Error(fallback);
  return result as T;
}
