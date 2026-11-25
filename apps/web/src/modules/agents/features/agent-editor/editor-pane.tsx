'use client';

import dynamic from 'next/dynamic';
import { Banner } from '@/shared/components/banner';
import { Skeleton } from '@/shared/ui/skeleton';
import type { AgentFileEntryOutput, AgentFileOutput } from '../../../../platform/api';
import { formatSize } from '../../components/format-size';
import { languageOf } from './editor-model';
import type { MonacoMarker } from './monaco-view';

// Monaco is the heavy part of the app: it is fetched here, on the editor route only, and never
// rendered on the server. The import stays in this one place.
const MonacoView = dynamic(() => import('./monaco-view'), {
  ssr: false,
  loading: () => (
    <div role="status" aria-busy="true" aria-label="Loading the editor" className="p-4">
      <Skeleton className="h-3.5 w-48" />
    </div>
  ),
});

export type PaneState =
  | { kind: 'none' }
  | { kind: 'missing'; path: string }
  | { kind: 'refused'; entry: AgentFileEntryOutput }
  | { kind: 'loading'; path: string }
  | { kind: 'error'; path: string }
  | { kind: 'deleted'; path: string }
  | {
      kind: 'file';
      file: AgentFileOutput;
      /** The text to show: the unsaved edit when there is one, else the file's own. */
      value?: string;
      editable?: boolean;
      markers?: readonly MonacoMarker[];
      revealLine?: number;
      revealToken?: number;
    };

/** Why the entry cannot be opened, in words for the pane. */
function refusalOf(entry: AgentFileEntryOutput): string {
  if (entry.kind === 'symlink') return 'It is a symbolic link, which is never followed.';
  if (entry.kind === 'submodule') return 'It is a submodule, which is never read.';
  return 'It is larger than the size the editor reads, or its path is not one it accepts.';
}

interface EditorPaneProps {
  state: PaneState;
  onChange?: (text: string) => void;
}

/** The right-hand side: one file at the commit the editor reads, or why there is none. */
export function EditorPane({ state, onChange }: EditorPaneProps) {
  switch (state.kind) {
    case 'none':
      return (
        <p className="m-0 p-4 text-small text-text-muted">
          Choose a file to read it, or switch on Edit to change it.
        </p>
      );
    case 'missing':
      return (
        <Banner tone="warning" className="m-4">
          <span className="font-mono text-code break-all">{state.path}</span> is not in this commit.
        </Banner>
      );
    case 'deleted':
      return (
        <Banner tone="warning" className="m-4">
          <span className="font-mono text-code break-all">{state.path}</span> is deleted in the
          Draft. Revert it to bring it back.
        </Banner>
      );
    case 'refused':
      return (
        <Banner tone="warning" className="m-4">
          <span className="font-mono text-code break-all">{state.entry.path}</span> cannot be opened
          here. {refusalOf(state.entry)}
        </Banner>
      );
    case 'loading':
      return (
        <div
          role="status"
          aria-busy="true"
          aria-label={`Loading ${state.path}`}
          className="flex flex-col gap-3 p-4"
        >
          <Skeleton className="h-3.5 w-64 max-w-full" />
          <Skeleton className="h-3.5 w-40" />
        </div>
      );
    case 'error':
      return (
        <Banner tone="danger" className="m-4">
          Couldn&apos;t read this file:{' '}
          <span className="font-mono text-code break-all">{state.path}</span>.
        </Banner>
      );
    case 'file': {
      const { file } = state;
      if (file.kind === 'binary') {
        return (
          <p className="m-0 p-4 text-small text-text-muted">
            This is a binary file of <strong>{formatSize(file.size)}</strong>; its content is not
            shown.
          </p>
        );
      }
      if (file.kind === 'too_large') {
        return (
          <p className="m-0 p-4 text-small text-text-muted">
            This file is too large to show: <strong>{formatSize(file.size)}</strong>.
          </p>
        );
      }
      return (
        <MonacoView
          value={state.value ?? file.content}
          language={languageOf(file.path)}
          path={file.path}
          readOnly={!state.editable}
          onChange={onChange}
          markers={state.markers}
          revealLine={state.revealLine}
          revealToken={state.revealToken}
        />
      );
    }
  }
}
