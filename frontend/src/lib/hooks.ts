import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { errorText } from './api';

/** Load data from an async function; re-runs when deps change. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const reload = useCallback(() => {
    const n = ++seq.current;
    setLoading(true);
    fn()
      .then((d) => { if (n === seq.current) { setData(d); setError(null); } })
      .catch((e) => { if (n === seq.current) setError(errorText(e)); })
      .finally(() => { if (n === seq.current) setLoading(false); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(reload, [reload]);
  return { data, error, loading, reload, setData };
}

/** Filters stored in the URL query string, so views are shareable and survive refresh. */
export function useUrlFilters<T extends Record<string, string>>(defaults: T) {
  const [params, setParams] = useSearchParams();
  const values = { ...defaults } as T;
  for (const k of Object.keys(defaults)) {
    const v = params.get(k);
    if (v !== null) (values as Record<string, string>)[k] = v;
  }
  const set = (patch: Partial<T>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === '' || v === defaults[k]) next.delete(k);
      else next.set(k, String(v));
    }
    if (!('page' in patch)) next.delete('page');
    setParams(next, { replace: true });
  };
  const reset = () => setParams(new URLSearchParams(), { replace: true });
  return { values, set, reset, key: params.toString() };
}
