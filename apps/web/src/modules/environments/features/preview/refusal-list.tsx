import { Banner } from '@/shared/components/banner';
import type { PreviewRefusal } from '../../../../platform/api';

/**
 * Every reason the API refused the settings, each with its place in the Compose file (or the
 * request field). The wording is the API's: fixed per code, never a value from the file.
 */
export function RefusalList({ refusals }: { refusals: PreviewRefusal[] }) {
  return (
    <Banner tone="danger" title="The Preview settings were not saved.">
      <p className="m-0 mb-2">
        The file or the choice was refused for{' '}
        {refusals.length === 1 ? 'this reason' : 'these reasons'}. Fix{' '}
        {refusals.length === 1 ? 'it' : 'them'} in the repository, merge the change into the
        integration branch and let Studio fetch it, then save again.
      </p>
      <ul aria-label="Refusals" className="m-0 flex list-none flex-col gap-2 p-0">
        {refusals.map((refusal, index) => (
          <li
            key={`${refusal.code}-${refusal.place}-${index}`}
            className="flex min-w-0 flex-col gap-0.5"
          >
            <span className="text-body">{refusal.message}</span>
            <span className="text-small">
              <code className="font-mono text-code break-all">{refusal.place}</code>
              <span className="text-text-muted"> · {refusal.code}</span>
            </span>
          </li>
        ))}
      </ul>
    </Banner>
  );
}
