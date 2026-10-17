import { useCallback, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * A screen's selection (which provider is open, which request is expanded, how wide the
 * time window is) belongs in the URL, not only in component state — otherwise a refresh
 * drops it and nobody can be sent a link to the thing they should look at.
 *
 * Writes use `replace` so tuning a filter does not bury the screen the user actually
 * navigated to under fifty back-button steps.
 */

type ParamValue = string | number | boolean | null | undefined;

export type QueryValues<K extends string> = Readonly<Record<K, string | undefined>>;

/** `null` (or `undefined` / `''`) removes the key, so a default never pollutes the link. */
export type QueryPatch<K extends string> = Partial<Record<K, ParamValue>>;

/**
 * Reads and writes one screen's URL state. `names` must be a stable (module-level) list.
 * The returned patcher keeps one identity across renders so a data-loading callback that
 * depends on it is not rebuilt — and re-run — every time the query string changes.
 */
export function useQueryParams<K extends string>(
  names: readonly K[]
): [QueryValues<K>, (patch: QueryPatch<K>) => void] {
  const [params, setParams] = useSearchParams();

  // A mutable mirror of the query string. It is re-synced whenever a render sees different
  // params (a link, the back button) and mutated in place by every write, so two patches
  // fired before React re-renders still compose instead of the second dropping the first —
  // react-router's `setSearchParams` replaces the whole query string, it does not merge.
  const mirror = useRef<URLSearchParams>(params);
  if (mirror.current.toString() !== params.toString()) mirror.current = new URLSearchParams(params);

  const navigateTo = useRef(setParams);
  navigateTo.current = setParams;

  const values = useMemo(() => {
    const out = {} as Record<K, string | undefined>;
    for (const name of names) out[name] = params.get(name) ?? undefined;
    return out;
  }, [params, names]);

  const patch = useCallback((next: QueryPatch<K>) => {
    const merged = mirror.current;
    for (const [key, value] of Object.entries(next as Record<string, ParamValue>)) {
      if (value === null || value === undefined || value === '') merged.delete(key);
      else merged.set(key, String(value));
    }
    navigateTo.current(new URLSearchParams(merged), { replace: true });
  }, []);

  return [values, patch];
}

/** For screens with a single URL field; screens with more must use `useQueryParams`. */
export function useQueryParam(
  name: string
): [string | undefined, (value: string | number | undefined) => void] {
  const names = useMemo(() => [name], [name]);
  const [values, patch] = useQueryParams(names);
  return [values[name], (value) => patch({ [name]: value })];
}

/** Numeric variant for windows and page indexes, with a floor so a bad link cannot break the view. */
export function useNumberQueryParam(
  name: string,
  fallback: number,
  min = 0
): [number, (value: number) => void] {
  const [raw, setRaw] = useQueryParam(name);
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  const value = Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
  return [value, (next: number) => setRaw(next === fallback ? undefined : next)];
}

/** Same coercion as `useNumberQueryParam`, for values read through `useQueryParams`. */
export function numberFromParam(
  raw: string | undefined,
  fallback: number,
  min = 0
): number {
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}
