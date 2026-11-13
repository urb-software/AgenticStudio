import { useSyncExternalStore } from 'react';

const noSubscription = () => () => {};

/**
 * `false` in the server render and during hydration, `true` afterwards: for UI that depends on
 * browser-only state (stored theme, viewport) and must match the server markup until then.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    noSubscription,
    () => true,
    () => false,
  );
}
