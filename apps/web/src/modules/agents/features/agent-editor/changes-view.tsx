'use client';

import dynamic from 'next/dynamic';
import { Banner } from '@/shared/components/banner';
import { Skeleton } from '@/shared/ui/skeleton';
import type { AgentDraftFileOutput, AgentFileOutput } from '../../../../platform/api';
import { useAgentFile } from '../../api/agents-queries';
import { useAgentDraftFile } from '../../api/draft-queries';
import { formatSize } from '../../components/format-size';
import { CHANGE_LABEL, languageOf } from './editor-model';

// The diff editor lives in the same chunk as the editor, so this adds no second download.
const MonacoDiffView = dynamic(
  () => import('./monaco-view').then((module) => module.MonacoDiffView),
  {
    ssr: false,
    loading: () => (
      <div role="status" aria-busy="true" aria-label="Loading the changes" className="p-4">
        <Skeleton className="h-3.5 w-48" />
      </div>
    ),
  },
);

/** The text a side of the diff shows, or why it has none. */
type Side =
  | { kind: 'text'; content: string }
  | { kind: 'other'; file: Exclude<AgentFileOutput, { kind: 'text' }> };

function sideOf(file: AgentFileOutput): Side {
  return file.kind === 'text' ? { kind: 'text', content: file.content } : { kind: 'other', file };
}

interface ChangesViewProps {
  files: readonly AgentDraftFileOutput[];
  /** The commit the Draft began from; its files are the left side. */
  baseCommit: string | null;
  selected: string | undefined;
  onSelect: (path: string) => void;
}

/** The changed files of the Draft, and one of them against the base commit. */
export function ChangesView({ files, baseCommit, selected, onSelect }: ChangesViewProps) {
  if (files.length === 0) {
    return <p className="m-0 p-4 text-small text-text-muted">The Draft has no changes.</p>;
  }
  const current = files.find((file) => file.path === selected) ?? files[0]!;
  return (
    <div className="flex flex-col md:flex-row">
      <nav
        aria-label="Changed files"
        className="max-h-[70vh] w-full shrink-0 overflow-auto border-b border-border p-2 md:w-72 md:border-r md:border-b-0"
      >
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
          {files.map((file) => (
            <li key={file.path}>
              <button
                type="button"
                aria-current={file.path === current.path ? 'true' : undefined}
                onClick={() => onSelect(file.path)}
                className={`flex w-full cursor-pointer flex-col rounded-sm px-2 py-1 text-left text-code hover:bg-hover focus-visible:outline-2 focus-visible:outline-ring pointer-coarse:min-h-11 ${
                  file.path === current.path
                    ? 'bg-brand-soft font-medium text-text'
                    : 'text-text-muted'
                }`}
              >
                <span className="break-all">{file.path}</span>
                <span className="text-caption">
                  {CHANGE_LABEL[file.change]}
                  {file.movedFrom ? ` (moved from ${file.movedFrom})` : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <div className="min-w-0 flex-1 md:h-[70vh]">
        <FileDiff file={current} baseCommit={baseCommit} />
      </div>
    </div>
  );
}

function FileDiff({ file, baseCommit }: { file: AgentDraftFileOutput; baseCommit: string | null }) {
  const originalPath = file.change === 'added' ? (file.movedFrom ?? undefined) : file.path;
  const original = useAgentFile(originalPath, baseCommit ?? undefined);
  const modified = useAgentDraftFile(file.change === 'deleted' ? undefined : file.path);

  const waiting =
    (originalPath !== undefined && baseCommit !== null && !original.data && !original.isError) ||
    (file.change !== 'deleted' && !modified.data && !modified.isError);
  if (waiting) {
    return (
      <div role="status" aria-busy="true" aria-label={`Loading ${file.path}`} className="p-4">
        <Skeleton className="h-3.5 w-48" />
      </div>
    );
  }
  if (original.isError || modified.isError) {
    return (
      <Banner tone="danger" className="m-4">
        Couldn&apos;t read <span className="font-mono text-code break-all">{file.path}</span> to
        compare it.
      </Banner>
    );
  }

  const before: Side | undefined = original.data ? sideOf(original.data) : undefined;
  const after: Side | undefined = modified.data ? sideOf(modified.data) : undefined;
  const other = [before, after].find((side) => side?.kind === 'other');
  if (other?.kind === 'other') {
    return (
      <p className="m-0 p-4 text-small text-text-muted">
        This is a file whose content is not shown ({formatSize(other.file.size)}); it is{' '}
        {CHANGE_LABEL[file.change].toLowerCase()} in the Draft.
      </p>
    );
  }
  return (
    <MonacoDiffView
      original={before?.kind === 'text' ? before.content : ''}
      modified={after?.kind === 'text' ? after.content : ''}
      language={languageOf(file.path)}
      path={file.path}
    />
  );
}
