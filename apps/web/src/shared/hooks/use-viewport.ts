import * as React from 'react';

/** Phones are below 768px, tablets 768–1279px, desktops from 1280px (frontend.md §9). */
const MOBILE_BREAKPOINT = 768;
const DESKTOP_BREAKPOINT = 1280;
const MOBILE_QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`;
const TABLET_QUERY = `(min-width: ${MOBILE_BREAKPOINT}px) and (max-width: ${DESKTOP_BREAKPOINT - 1}px)`;

function subscribeTo(query: string) {
  return (onChange: () => void) => {
    const mql = window.matchMedia(query);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  };
}

const subscribeMobile = subscribeTo(MOBILE_QUERY);
const subscribeTablet = subscribeTo(TABLET_QUERY);

/**
 * Whether the viewport is phone-sized. Read through useSyncExternalStore (no setState in an
 * effect); the server render assumes a wider screen.
 */
export function useIsMobile() {
  return React.useSyncExternalStore(
    subscribeMobile,
    () => window.innerWidth < MOBILE_BREAKPOINT,
    () => false,
  );
}

/** Whether the viewport is tablet-sized; the server render assumes a desktop. */
export function useIsTablet() {
  return React.useSyncExternalStore(
    subscribeTablet,
    () => window.innerWidth >= MOBILE_BREAKPOINT && window.innerWidth < DESKTOP_BREAKPOINT,
    () => false,
  );
}
