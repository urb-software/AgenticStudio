import { isWorkingCopyPath } from '../../components/finding-path';
import type { RunOutput } from '../../../../platform/api';

type Finding = NonNullable<RunOutput['phases']>[number]['findings'][number];

/**
 * One finding of a review: the reviewer's text as plain text (never Markdown or HTML), and the
 * file and line it names. A file leads to the Changes tab only when it is a relative path inside
 * the Working copy; any other is shown as text and never opened.
 */
export function FindingItem({
  finding,
  onShowFile,
}: {
  finding: Finding;
  onShowFile: ((path: string) => void) | undefined;
}) {
  const { file, line } = finding;
  const leads = file !== undefined && onShowFile !== undefined && isWorkingCopyPath(file);
  return (
    <li data-testid="run-finding" className="flex min-w-0 flex-col gap-0.5">
      {file !== undefined ? (
        <span className="text-small text-text-muted">
          {leads ? (
            <button
              type="button"
              onClick={() => onShowFile(file)}
              className="cursor-pointer border-0 bg-transparent p-0 text-left font-mono text-code break-all text-brand underline hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring pointer-coarse:min-h-11"
            >
              {file}
              <span className="sr-only"> (show it on the Changes tab)</span>
            </button>
          ) : (
            <span data-testid="run-finding-file" className="font-mono text-code break-all">
              {file}
            </span>
          )}
          {line !== undefined ? (
            <span className="font-mono text-code">
              <span aria-hidden="true">:</span>
              <span className="sr-only"> line </span>
              {line}
            </span>
          ) : null}
        </span>
      ) : null}
      <span
        data-testid="run-finding-text"
        className="min-w-0 text-small break-words whitespace-pre-wrap text-text"
      >
        {finding.text}
      </span>
    </li>
  );
}
