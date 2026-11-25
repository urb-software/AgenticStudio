'use client';

import { useEffect, useState } from 'react';

/** `value` as it stood `delay` ms ago: it follows only once the value has stopped changing. */
export function useDebouncedValue<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return settled;
}
