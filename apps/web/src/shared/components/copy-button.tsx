'use client';

import { CheckIcon, CopyIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/shared/ui/button';

/** How long "Copied" stays before the button reads "Copy" again. */
const CONFIRMATION_MS = 2_000;

type CopyState = 'idle' | 'copied' | 'failed';

const ANNOUNCEMENT: Record<CopyState, string> = {
  idle: '',
  copied: 'Copied to the clipboard.',
  failed: 'Could not copy. Select the text and copy it instead.',
};

type CopyButtonProps = {
  value: string;
  label: string;
  className?: string;
};

/**
 * A clipboard that refuses (permissions, insecure context) says so; the outcome is also
 * announced in a polite live region.
 */
function CopyButton({ value, label, className }: CopyButtonProps) {
  const [state, setState] = useState<CopyState>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(value);
      setState('copied');
    } catch {
      setState('failed');
    }
    timer.current = setTimeout(() => setState('idle'), CONFIRMATION_MS);
  };

  return (
    <>
      <Button
        size="sm"
        icon={state === 'copied' ? CheckIcon : CopyIcon}
        aria-label={label}
        className={className}
        onClick={() => void copy()}
      >
        {state === 'copied' ? 'Copied' : 'Copy'}
      </Button>
      <span role="status" className="sr-only">
        {ANNOUNCEMENT[state]}
      </span>
    </>
  );
}

export { CopyButton, type CopyButtonProps };
