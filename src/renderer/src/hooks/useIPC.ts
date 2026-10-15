import { useState, useEffect, useCallback } from 'react';

export interface UseIPCReturn<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

type IPCCall<T> = () => Promise<T>;

export function useIPC<T>(ipcCall: IPCCall<T>, deps: unknown[] = []): UseIPCReturn<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const execute = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await ipcCall();
      setData(result as T);
    } catch (err) {
      const message = err instanceof Error ? err.message : '请求失败';
      setError(message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    execute();
  }, [execute]);

  return { data, loading, error, refetch: execute };
}

export function useIPCMutation<TArgs, TResult>() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mutate = useCallback(async (fn: (args: TArgs) => Promise<TResult>, args: TArgs): Promise<TResult | null> => {
    setLoading(true);
    setError(null);
    try {
      const result = await fn(args);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : '操作失败';
      setError(message);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  return { mutate, loading, error };
}
