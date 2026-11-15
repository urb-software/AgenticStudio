import { RefreshCwIcon } from 'lucide-react';
import { Banner } from '@/shared/components/banner';
import { Button } from '@/shared/ui/button';

type StaleBannerProps = {
  /** What could not be refreshed ("the run", "the runs"). */
  what: string;
  retrying: boolean;
  onRetry: () => void;
};

/**
 * A background refresh failed but earlier data is on screen: the data stays, and this quiet
 * banner says it may be out of date. Polling goes on by itself; Retry reads it at once.
 */
export function StaleBanner({ what, retrying, onRetry }: StaleBannerProps) {
  return (
    <Banner
      tone="danger"
      announce="polite"
      title={`Couldn't refresh ${what}.`}
      action={
        <Button size="sm" icon={RefreshCwIcon} loading={retrying} onClick={onRetry}>
          Retry
        </Button>
      }
    >
      Showing the last known state.
    </Banner>
  );
}
