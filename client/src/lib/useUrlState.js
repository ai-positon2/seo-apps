import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * One piece of view state (a tab, a report step, an open issue) kept in the
 * page address, so Back steps back one level, a reload keeps the reader's
 * place, and the link can be shared.
 *
 *   const [tab, setTab] = useUrlState('tab', 'overview');
 *
 * Setting the default removes the parameter, so a page's plain address is its
 * first view. Each change is its own history entry unless { replace: true }.
 * Other parameters on the address are left alone.
 */
export function useUrlState(key, defaultValue = null) {
  const [params, setParams] = useSearchParams();
  const raw = params.get(key);
  const value = raw === null ? defaultValue : raw;

  const setValue = useCallback((next, { replace = false } = {}) => {
    setParams((prev) => {
      const out = new URLSearchParams(prev);
      if (next === null || next === undefined || next === '' || next === defaultValue) out.delete(key);
      else out.set(key, String(next));
      return out;
    }, { replace });
  }, [key, defaultValue, setParams]);

  return [value, setValue];
}
