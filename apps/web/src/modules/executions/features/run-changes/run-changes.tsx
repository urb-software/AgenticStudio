'use client';

import {
  ArrowLeftIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CloudUploadIcon,
  ExternalLinkIcon,
  FileDiffIcon,
  GitCommitHorizontalIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Banner } from '@/shared/components/banner';
import { DiffView } from '@/shared/components/diff-view';
import { EmptyState } from '@/shared/components/empty-state';
import { SegmentedControl } from '@/shared/components/segmented-control';
import { cn } from '@/shared/lib/utils';
import { Button } from '@/shared/ui/button';
import { Skeleton } from '@/shared/ui/skeleton';
import {
  ApiError,
  type RunDiffFileSummaryOutput,
  type RunDiffOutput,
  type RunOutput,
} from '../../../../platform/api';
import {
  type PatchSource,
  useFilePatch,
  useRefreshRunDiffFiles,
  useRunDiff,
} from '../../api/runs-queries';
import { failedRequest } from '../../components/failed-request';
import { FINAL_STATES } from '../../components/run-states';
import { patchLines } from './patch-lines';
import { usePullRequestFileUrl } from './pull-request-file-url';

type Scope = RunDiffOutput['scope'];

const SCOPES = [
  { value: 'run', label: 'Whole run' },
  { value: 'last', label: 'Since previous result' },
] as const satisfies readonly { value: Scope; label: string }[];

/** How many files start expanded; the rest start collapsed and load when opened. */
export const EXPANDED_FILES = 5;

/** The requests the tab makes (generated `getRunDiff`, `getRunDiffFile`), shown when they fail. */
const DIFF_REQUEST = 'GET /api/runs/{runId}/diff';
const FILE_REQUEST = 'GET /api/runs/{runId}/diff/file';
const REVIEW_FILE_REQUEST = 'GET /api/runs/{runId}/merge-review/file';

const STATUS_LABEL: Record<RunDiffFileSummaryOutput['status'], string> = {
  added: 'Added',
  modified: 'Modified',
  deleted: 'Deleted',
  renamed: 'Renamed',
};

/**
 * What the file list and the file sections need of a changed file, from either source: the
 * agent worker's reported diff, or Studio's merge review (which has no line counts).
 */
export interface ChangedFile {
  path: string;
  previousPath?: string;
  status: RunDiffFileSummaryOutput['status'];
  additions?: number;
  deletions?: number;
  binary?: true;
  /** A limit left the patch out. */
  tooLarge?: true;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** "+12 −4" in the run-state colours, with the words for screen readers. */
function Counts({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="inline-flex flex-none gap-1.5 font-mono text-[11.5px] tabular-nums">
      <span className="text-run-succeeded">
        +{additions}
        <span className="sr-only"> {additions === 1 ? 'line' : 'lines'} added,</span>
      </span>
      <span className="text-run-failed">
        −{deletions}
        <span className="sr-only"> {deletions === 1 ? 'line' : 'lines'} removed</span>
      </span>
    </span>
  );
}

export function RunChanges({ run }: { run: RunOutput }) {
  const [scope, setScope] = useState<Scope>('run');
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <SegmentedControl
        label="Changes to show"
        options={SCOPES}
        value={scope}
        onChange={setScope}
      />
      <ScopeChanges key={scope} run={run} scope={scope} />
    </div>
  );
}

function ScopeChanges({ run, scope }: { run: RunOutput; scope: Scope }) {
  const diff = useRunDiff(run, scope);
  const refreshFiles = useRefreshRunDiffFiles(run.id, scope);
  // A new result replaces the diff: the patches of its files are read again.
  const seen = useRef(diff.data);
  useEffect(() => {
    if (seen.current !== undefined && seen.current !== diff.data) void refreshFiles();
    seen.current = diff.data;
  }, [diff.data, refreshFiles]);

  if (diff.isPending) {
    return (
      <div
        role="status"
        aria-busy="true"
        aria-label="Loading the changes"
        className="flex flex-col gap-2"
      >
        <Skeleton className="h-4 w-64 max-w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  if (diff.error instanceof ApiError && diff.error.status === 404) {
    const final = FINAL_STATES.includes(run.state);
    return (
      <EmptyState
        icon={FileDiffIcon}
        title={final ? 'No changes recorded' : 'No changes yet'}
        description={
          final
            ? 'This run ended without reporting a result, so there is no diff.'
            : 'The changes appear when the agent reports its first result.'
        }
      />
    );
  }
  if (!diff.data) {
    return (
      <EmptyState
        tone="error"
        icon={TriangleAlertIcon}
        title="Couldn't load the changes"
        description={
          <span className="font-mono text-small">{failedRequest(DIFF_REQUEST, diff.error)}</span>
        }
        action={
          <Button
            icon={RefreshCwIcon}
            loading={diff.isRefetching}
            onClick={() => void diff.refetch()}
          >
            Retry
          </Button>
        }
      />
    );
  }
  const data = diff.data;
  if (data.unavailableReason !== undefined) {
    return (
      <EmptyState
        tone="error"
        icon={TriangleAlertIcon}
        title="Couldn't compute the changes"
        description={
          <span className="break-words whitespace-pre-wrap">{data.unavailableReason}</span>
        }
      />
    );
  }
  if (data.files.length === 0) {
    return (
      <EmptyState
        icon={FileDiffIcon}
        title="No changes"
        description={
          scope === 'last'
            ? 'Nothing changed since the previous result.'
            : 'The run has not changed any files.'
        }
      />
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Summary diff={data} scope={scope} />
      {data.truncated ? (
        <Banner tone="warning" title="Not every change is shown.">
          This diff reached its size limit: some files are listed without their content, or not
          listed at all.
        </Banner>
      ) : null}
      <ChangedFiles
        source={{ kind: 'diff', runId: run.id, scope }}
        files={data.files}
        truncated={data.truncated}
        // A link to the file in the pull request only when every change shown there is pushed.
        pullRequest={data.includesUnpushed === false ? run.pullRequest : undefined}
      />
    </div>
  );
}

/** The summary line: files changed, lines added and removed, where the diff starts, pushed or not. */
function Summary({ diff, scope }: { diff: RunDiffOutput; scope: Scope }) {
  const additions = diff.files.reduce((total, file) => total + file.additions, 0);
  const deletions = diff.files.reduce((total, file) => total + file.deletions, 0);
  return (
    <div className="flex flex-col gap-1.5 text-small text-text-muted">
      <p className="m-0 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium text-text">
          {plural(diff.files.length, 'file changed', 'files changed')}
        </span>
        <Counts additions={additions} deletions={deletions} />
      </p>
      <p className="m-0 flex flex-wrap items-center gap-x-4 gap-y-1">
        {diff.baseCommit ? (
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <GitCommitHorizontalIcon aria-hidden="true" className="size-3.5 flex-none" />
            {scope === 'run' ? 'From the start commit' : 'From the previous result at'}
            <code className="font-mono text-code break-all text-text" title={diff.baseCommit}>
              {diff.baseCommit.slice(0, 12)}
            </code>
          </span>
        ) : null}
        {/* Only a computed diff knows whether it is pushed. */}
        {diff.includesUnpushed !== undefined ? (
          <span className="inline-flex items-center gap-1.5">
            <CloudUploadIcon aria-hidden="true" className="size-3.5 flex-none" />
            {diff.includesUnpushed
              ? 'Includes changes that are not pushed'
              : 'Every change here is pushed'}
          </span>
        ) : null}
      </p>
    </div>
  );
}

/**
 * The file list and the files' diffs. At desktop width the list sits beside the diffs, the first
 * {@link EXPANDED_FILES} files expanded; selecting a file expands it and scrolls to it. On a
 * phone the list is a step of its own: selecting a file shows only its diff, with a way back.
 */
export function ChangedFiles({
  source,
  files,
  truncated,
  pullRequest,
}: {
  source: PatchSource;
  files: readonly ChangedFile[];
  truncated: boolean;
  pullRequest: { url: string; number: number } | undefined;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(files.slice(0, EXPANDED_FILES).map((file) => file.path)),
  );
  const [selected, setSelected] = useState<string | null>(null);
  const sections = useRef(new Map<string, HTMLElement>());

  const toggle = (path: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  const select = (path: string) => {
    setSelected(path);
    setExpanded((current) => new Set(current).add(path));
    requestAnimationFrame(() => {
      const section = sections.current.get(path);
      section?.scrollIntoView?.({ block: 'start' });
      section
        ?.querySelector<HTMLButtonElement>('button[aria-expanded]')
        ?.focus({ preventScroll: true });
    });
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-[minmax(0,16rem)_minmax(0,1fr)] md:items-start">
        <nav
          aria-label="Changed files"
          className={cn('min-w-0 md:sticky md:top-16', selected !== null && 'max-md:hidden')}
        >
          <ul className="m-0 flex list-none flex-col gap-0.5 rounded-lg border border-border bg-surface p-1">
            {files.map((file) => (
              <li key={file.path} className="min-w-0">
                <button
                  type="button"
                  onClick={() => select(file.path)}
                  aria-current={selected === file.path ? 'true' : undefined}
                  className={cn(
                    'flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2 py-1.5 text-left text-small text-text hover:bg-hover pointer-coarse:min-h-11',
                    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                    selected === file.path && 'bg-brand-soft',
                  )}
                >
                  <span
                    className="min-w-0 flex-auto truncate font-mono text-code"
                    title={file.path}
                  >
                    {file.path}
                  </span>
                  <span className="sr-only">{STATUS_LABEL[file.status]},</span>
                  {file.additions !== undefined && file.deletions !== undefined ? (
                    <Counts additions={file.additions} deletions={file.deletions} />
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div className={cn('flex min-w-0 flex-col gap-3', selected === null && 'max-md:hidden')}>
          {selected !== null ? (
            <Button
              variant="ghost"
              size="sm"
              icon={ArrowLeftIcon}
              className="self-start md:hidden"
              onClick={() => setSelected(null)}
            >
              All files
            </Button>
          ) : null}
          {files.map((file) => (
            <FileChanges
              key={file.path}
              ref={(element) => {
                if (element) sections.current.set(file.path, element);
                else sections.current.delete(file.path);
              }}
              source={source}
              file={file}
              truncated={truncated}
              open={expanded.has(file.path)}
              onToggle={() => toggle(file.path)}
              pullRequest={pullRequest}
              className={cn(selected !== file.path && 'max-md:hidden')}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/** A link to this file in the Run's pull request on GitHub, when its changes are pushed. */
function PullRequestFileLink({
  pullRequest,
  path,
}: {
  pullRequest: { url: string; number: number };
  path: string;
}) {
  const url = usePullRequestFileUrl(pullRequest.url, path);
  if (!url) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="inline-flex flex-none items-center gap-1 font-sans text-small text-brand no-underline hover:underline"
    >
      In pull request
      <ExternalLinkIcon aria-hidden="true" className="size-3" />
      <span className="sr-only">
        #{pullRequest.number}: {path} (opens GitHub in a new tab)
      </span>
    </a>
  );
}

/** One file: a header that collapses and expands it, and its diff, loaded once it is open. */
function FileChanges({
  ref,
  source,
  file,
  truncated,
  open,
  onToggle,
  pullRequest,
  className,
}: {
  ref: (element: HTMLElement | null) => void;
  source: PatchSource;
  file: ChangedFile;
  truncated: boolean;
  open: boolean;
  onToggle: () => void;
  pullRequest: { url: string; number: number } | undefined;
  className?: string;
}) {
  const bodyId = `diff-${source.kind === 'diff' ? source.scope : source.kind}-${encodeURIComponent(file.path)}`;
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon;
  return (
    <section
      ref={ref}
      aria-label={file.path}
      className={cn(
        'min-w-0 scroll-mt-20 overflow-hidden rounded-lg border border-border bg-surface',
        className,
      )}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 px-3 py-2">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={onToggle}
          className="flex min-w-0 flex-auto cursor-pointer items-center gap-2 border-0 bg-transparent p-0 text-left font-mono text-code text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring pointer-coarse:min-h-11"
        >
          <Chevron aria-hidden="true" className="size-3.5 flex-none text-text-dim" />
          <span className="min-w-0 truncate" title={file.path}>
            {file.path}
          </span>
        </button>
        <span className="flex-none text-caption font-medium text-text-muted">
          {STATUS_LABEL[file.status]}
          {file.previousPath ? (
            <span className="font-normal">
              {' '}
              from <code className="font-mono break-all">{file.previousPath}</code>
            </span>
          ) : null}
        </span>
        {file.additions !== undefined && file.deletions !== undefined ? (
          <Counts additions={file.additions} deletions={file.deletions} />
        ) : null}
        {pullRequest ? <PullRequestFileLink pullRequest={pullRequest} path={file.path} /> : null}
      </div>
      <div id={bodyId} hidden={!open} className="border-t border-border">
        {open ? <FileBody source={source} file={file} truncated={truncated} /> : null}
      </div>
    </section>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <p className="m-0 px-3 py-3 text-small text-text-muted">{children}</p>;
}

/** The file's diff: loaded per file; binary, too large and left-out files say why instead. */
function FileBody({
  source,
  file,
  truncated,
}: {
  source: PatchSource;
  file: ChangedFile;
  truncated: boolean;
}) {
  const needsPatch = !file.binary && !file.tooLarge;
  const query = useFilePatch(source, file.path, needsPatch);
  if (file.binary) return <Note>Binary file: its content is not shown.</Note>;
  if (file.tooLarge) {
    return file.additions !== undefined && file.deletions !== undefined ? (
      <Note>
        Too large to show: {plural(file.additions, 'line', 'lines')} added,{' '}
        {plural(file.deletions, 'line', 'lines')} removed.
      </Note>
    ) : (
      <Note>Too large to show: its changes are over the size limit.</Note>
    );
  }
  if (query.isPending) {
    return (
      <div role="status" aria-busy="true" aria-label={`Loading ${file.path}`} className="p-3">
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }
  if (!query.data) {
    return (
      <div className="p-3">
        <Banner
          tone="danger"
          title="Couldn't load this file's changes."
          action={
            <Button size="sm" icon={RefreshCwIcon} onClick={() => void query.refetch()}>
              Retry
            </Button>
          }
        >
          <span className="font-mono text-small">
            {failedRequest(
              source.kind === 'diff' ? FILE_REQUEST : REVIEW_FILE_REQUEST,
              query.error,
            )}
          </span>
        </Banner>
      </div>
    );
  }
  if (query.data.patch === undefined) {
    return (
      <Note>
        {truncated
          ? 'Not shown: the diff reached its size limit before this file.'
          : 'No content to show.'}
      </Note>
    );
  }
  const lines = patchLines(query.data.patch);
  if (lines.length === 0) {
    return <Note>No changes to the content (the file was renamed, or its mode changed).</Note>;
  }
  return (
    <DiffView lines={lines} label={`Diff of ${file.path}`} className="rounded-none border-0" />
  );
}
