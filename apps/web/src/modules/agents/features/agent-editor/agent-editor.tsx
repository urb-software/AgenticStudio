'use client';

import { RefreshCwIcon, TriangleAlertIcon } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useId, useMemo, useState } from 'react';
import { Banner } from '@/shared/components/banner';
import { EmptyState } from '@/shared/components/empty-state';
import { Button } from '@/shared/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/ui/card';
import { Label } from '@/shared/ui/label';
import { NativeSelect } from '@/shared/ui/native-select';
import { Skeleton } from '@/shared/ui/skeleton';
import type { AgentSummaryOutput } from '../../../../platform/api';
import {
  useAgentFile,
  useAgentFiles,
  useAgents,
  useEditorAgents,
  useReloadEditor,
} from '../../api/agents-queries';
import { EditorPane, type PaneState } from './editor-pane';
import {
  ancestorsOf,
  buildTree,
  frontMatterKeyLine,
  problemTarget,
  type ProblemTarget,
} from './editor-model';
import { FileTree } from './file-tree';

const TITLE_ID = 'agent-editor-title';

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** The editor's URL for a file: the file is the only state worth keeping in a link. */
function editorUrl(path: string): string {
  return `/agents/editor?${new URLSearchParams({ path })}`;
}

/**
 * A read-only view over the definitions Repository: a file tree on the left, the
 * selected file in Monaco on the right. It shows one commit and moves to a newer one only when
 * the operator reloads.
 */
export function AgentEditor() {
  return (
    <>
      <h1 className="m-0 text-page-title font-semibold tracking-[-0.015em]">Agent editor</h1>
      <EditorBody />
    </>
  );
}

function EditorBody() {
  const files = useAgentFiles();
  const marks = useEditorAgents();
  const latest = useAgents();
  const reload = useReloadEditor();
  const router = useRouter();
  const initial = useSearchParams().get('path') ?? undefined;

  const [path, setPath] = useState(initial);
  const [reveal, setReveal] = useState<{ target: ProblemTarget; token: number }>();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(initial ? ancestorsOf(initial) : []),
  );
  const chooserId = useId();

  const commit = files.data?.commit ?? undefined;
  const entries = useMemo(() => files.data?.entries ?? [], [files.data]);
  const nodes = useMemo(() => buildTree(entries), [entries]);
  const agents = useMemo(
    () =>
      new Map<string, AgentSummaryOutput>(
        (marks.data?.agents ?? [])
          .filter((agent) => agent.source === 'definitions')
          .map((agent) => [agent.name, agent]),
      ),
    [marks.data],
  );
  const entry =
    path === undefined ? undefined : entries.find((candidate) => candidate.path === path);
  const readable = entry?.openable ? path : undefined;
  const file = useAgentFile(readable, commit);

  function open(next: string, target?: ProblemTarget) {
    setPath(next);
    setReveal(target ? { target, token: (reveal?.token ?? 0) + 1 } : undefined);
    setExpanded((current) => new Set([...current, ...ancestorsOf(next)]));
    router.replace(editorUrl(next), { scroll: false });
  }

  function toggle(folder: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(folder)) next.add(folder);
      return next;
    });
  }

  if (files.isPending || marks.isPending) {
    return (
      <div
        role="status"
        aria-busy="true"
        aria-label="Loading the files"
        className="flex flex-col gap-3"
      >
        <Skeleton className="h-3.5 w-64 max-w-full" />
        <Skeleton className="h-3.5 w-40" />
      </div>
    );
  }
  if (files.isError || marks.isError) {
    return (
      <EmptyState
        tone="error"
        icon={TriangleAlertIcon}
        title="Couldn't load the files"
        description={
          <span className="font-mono text-small">GET /api/agents/definitions-repository/files</span>
        }
        action={
          <Button
            icon={RefreshCwIcon}
            loading={files.isRefetching || marks.isRefetching}
            onClick={() => void reload()}
          >
            Retry
          </Button>
        }
      />
    );
  }

  const newestCommit = latest.data?.commit ?? undefined;
  const newer = commit !== undefined && newestCommit !== undefined && newestCommit !== commit;
  const problems = [...agents.values()].flatMap((agent) =>
    agent.problems.map((problem) => ({ agent: agent.name, problem })),
  );
  const openable = entries.filter((candidate) => candidate.openable);

  let pane: PaneState;
  if (path === undefined) pane = { kind: 'none' };
  else if (!entry) pane = { kind: 'missing', path };
  else if (!entry.openable) pane = { kind: 'refused', entry };
  else if (file.isError) pane = { kind: 'error', path };
  else if (!file.data) pane = { kind: 'loading', path };
  else {
    const key = reveal?.target.path === path ? reveal.target.key : undefined;
    const line =
      key !== undefined && file.data.kind === 'text'
        ? frontMatterKeyLine(file.data.content, key)
        : undefined;
    pane = { kind: 'file', file: file.data, revealLine: line, revealToken: reveal?.token };
  }

  return (
    <Card aria-labelledby={TITLE_ID}>
      <CardHeader>
        <CardTitle id={TITLE_ID}>Agent definitions</CardTitle>
        <span className="text-small text-text-muted">
          {commit ? (
            <>
              Read at commit{' '}
              <code className="text-code" title={commit}>
                {shortSha(commit)}
              </code>
            </>
          ) : (
            'No commit read'
          )}
        </span>
      </CardHeader>
      <CardContent flush>
        {newer ? (
          <Banner
            tone="info"
            className="m-4"
            action={
              <Button size="sm" onClick={() => void reload()}>
                Reload
              </Button>
            }
          >
            A newer commit, <code className="text-code">{shortSha(newestCommit ?? '')}</code>, has
            been fetched. The files below are still at the earlier commit.
          </Banner>
        ) : null}
        {commit === undefined ? (
          <Banner tone="warning" className="m-4">
            Nothing has been fetched from the definitions Repository yet, so there are no files to
            show.
          </Banner>
        ) : (
          <>
            {files.data.truncated ? (
              <Banner tone="warning" className="m-4">
                The Repository holds more files than are listed here.
              </Banner>
            ) : null}
            {problems.length > 0 ? (
              <section
                aria-labelledby="agent-editor-problems"
                className="border-b border-border p-4"
              >
                <h2 id="agent-editor-problems" className="m-0 mb-2 text-label font-semibold">
                  Problems
                </h2>
                <ul className="m-0 flex list-none flex-col gap-1 p-0 text-small">
                  {problems.map(({ agent, problem }, index) => {
                    const target = problemTarget(agent, problem);
                    return (
                      <li
                        key={`${agent}:${problem.code}:${problem.path}:${problem.key ?? ''}:${index}`}
                      >
                        <button
                          type="button"
                          onClick={() => open(target.path, target)}
                          className="cursor-pointer rounded-sm text-left text-run-failed hover:underline focus-visible:outline-2 focus-visible:outline-ring pointer-coarse:min-h-11"
                        >
                          <span className="font-mono text-code break-all">{target.path}</span>
                          {problem.key ? (
                            <>
                              {' · '}
                              <code className="text-code">{problem.key}</code>
                            </>
                          ) : null}
                          {' — '}
                          {problem.message}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ) : null}
            <div className="flex flex-col md:flex-row">
              <div className="border-b border-border p-3 md:hidden">
                <Label htmlFor={chooserId}>File</Label>
                <NativeSelect
                  id={chooserId}
                  className="mt-1.5 w-full"
                  value={readable ?? ''}
                  onChange={(event) => event.target.value && open(event.target.value)}
                >
                  <option value="">No file open</option>
                  {openable.map((candidate) => (
                    <option key={candidate.path} value={candidate.path}>
                      {candidate.path}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <nav
                aria-label="Files"
                className="hidden max-h-[70vh] w-72 shrink-0 overflow-auto border-r border-border p-2 md:block"
              >
                <FileTree
                  nodes={nodes}
                  selected={path}
                  expanded={expanded}
                  agents={agents}
                  onToggle={toggle}
                  onOpen={(next) => open(next)}
                />
              </nav>
              <div className="min-w-0 flex-1 md:h-[70vh]">
                <EditorPane state={pane} />
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
