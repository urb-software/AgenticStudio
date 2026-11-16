import * as React from 'react';
import { cn } from '@/shared/lib/utils';

/**
 * One row of a unified diff (design-system/components/DiffView): an added, deleted or context
 * line with its old and new line numbers, a hunk header, or a `meta` line Git adds (e.g.
 * "\ No newline at end of file").
 */
export interface DiffLine {
  type: 'add' | 'del' | 'ctx' | 'hunk' | 'meta';
  old?: number;
  new?: number;
  text: string;
}

const ROW_CLASS: Record<DiffLine['type'], string> = {
  add: 'bg-run-succeeded-soft',
  del: 'bg-run-failed-soft',
  ctx: '',
  hunk: 'bg-run-running-soft text-run-running',
  meta: 'text-text-dim',
};

const SIGN: Record<DiffLine['type'], string> = { add: '+', del: '−', ctx: '', hunk: '', meta: '' };

const SIGN_CLASS: Partial<Record<DiffLine['type'], string>> = {
  add: 'text-run-succeeded',
  del: 'text-run-failed',
};

type DiffViewProps = {
  /** The file's path, in the header (mono); no header without it. */
  path?: string;
  additions?: number;
  deletions?: number;
  /** At the right of the header, e.g. a link to the file in the pull request. */
  actions?: React.ReactNode;
  lines: readonly DiffLine[];
  /** The scrolling code box's accessible name (default: "Diff of <path>"). */
  label?: string;
  className?: string;
};

/**
 * Unified diff of one file (design-system/components/DiffView): a header with the path in mono,
 * green +additions and red −deletions; rows of 20px with the old and new line numbers, a sign
 * column and the text, additions on `run-succeeded-soft`, deletions on `run-failed-soft`, hunk
 * headers on `run-running-soft`. The code scrolls sideways inside its own box (focusable, so a
 * keyboard can scroll it). Every line is plain text: nothing in it is rendered as markup.
 */
function DiffView({ path, additions, deletions, actions, lines, label, className }: DiffViewProps) {
  const added = additions ?? lines.filter((line) => line.type === 'add').length;
  const deleted = deletions ?? lines.filter((line) => line.type === 'del').length;
  return (
    <div
      data-slot="diff-view"
      className={cn(
        'min-w-0 overflow-hidden rounded-lg border border-border bg-surface',
        className,
      )}
    >
      {path !== undefined ? (
        <div className="flex min-w-0 items-center gap-2.5 border-b border-border px-3 py-2 font-mono text-code">
          <span className="min-w-0 flex-auto truncate" title={path}>
            {path}
          </span>
          <span className="flex-none font-mono text-[11.5px] text-run-succeeded tabular-nums">
            +{added}
          </span>
          <span className="flex-none font-mono text-[11.5px] text-run-failed tabular-nums">
            −{deleted}
          </span>
          {actions}
        </div>
      ) : null}
      <div
        role="region"
        aria-label={label ?? (path ? `Diff of ${path}` : 'Diff')}
        tabIndex={0}
        className="overflow-x-auto bg-code-bg font-mono text-code focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-brand"
      >
        <div className="w-max min-w-full">
          {lines.map((line, index) => (
            <div
              // Rows never move: a diff is shown whole and read only.
              key={index}
              data-type={line.type}
              className={cn('flex h-5 whitespace-pre', ROW_CLASS[line.type])}
            >
              <span className="w-[46px] flex-none pr-2.5 text-right text-text-dim tabular-nums select-none">
                {line.old ?? ''}
              </span>
              <span className="w-[46px] flex-none pr-2.5 text-right text-text-dim tabular-nums select-none">
                {line.new ?? ''}
              </span>
              <span
                className={cn('w-[18px] flex-none text-center select-none', SIGN_CLASS[line.type])}
              >
                {SIGN[line.type]}
              </span>
              <span className="pr-4">{line.text}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export { DiffView, type DiffViewProps };
