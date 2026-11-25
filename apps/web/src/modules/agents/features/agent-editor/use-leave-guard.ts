'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

/**
 * While `active`, a reload or a close asks the browser to confirm, and a click on a link to
 * another page is held back and offered as `target` until the operator leaves or stays. Edits
 * stay in session storage either way; the Back button is not intercepted.
 */
export function useLeaveGuard(active: boolean) {
  const router = useRouter();
  const [target, setTarget] = useState<string>();

  useEffect(() => {
    if (!active) return undefined;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element | null)?.closest?.('a[href]');
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if ((anchor.target && anchor.target !== '_self') || anchor.hasAttribute('download')) return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname) return;
      // Captured before the framework's own link handler, which would navigate.
      event.preventDefault();
      event.stopPropagation();
      setTarget(`${url.pathname}${url.search}${url.hash}`);
    };
    window.addEventListener('beforeunload', beforeUnload);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      document.removeEventListener('click', onClick, true);
    };
  }, [active]);

  const stay = useCallback(() => setTarget(undefined), []);
  const leave = useCallback(() => {
    if (target === undefined) return;
    const destination = target;
    setTarget(undefined);
    router.push(destination);
  }, [router, target]);

  return { target, stay, leave };
}
