import { useEffect, useState } from 'react';

/**
 * The current time as React state, refreshed every `intervalMs`.
 * Components must not call Date.now() while rendering (the result would change
 * between renders), so they read it from here instead.
 */
export function useNow(intervalMs = 60_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
