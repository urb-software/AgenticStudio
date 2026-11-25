'use client';

import { RefreshCwIcon, TriangleAlertIcon } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useId, useMemo, useState } from 'react';
import { Banner } from '@/shared/components/banner';
import { EmptyState } from '@/shared/components/empty-state';
import { SegmentedControl } from '@/shared/components/segmented-control';
import { Button } from '@/shared/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/ui/card';
import { Label } from '@/shared/ui/label';
import { NativeSelect } from '@/shared/ui/native-select';
import { Skeleton } from '@/shared/ui/skeleton';
import type { AgentDraftOutput, AgentSummaryOutput } from '../../../../platform/api';
import {
  useAgentFile,
  useAgentFiles,
  useAgents,
  useEditorAgents,
  useProviders,
  useReloadEditor,
} from '../../api/agents-queries';
import {
  draftFailureOf,
  useAgentDraftFile,
  useDeleteDraftFile,
  useDiscardDraft,
  useDraft,
  useMoveDraftFile,
  useReloadDraft,
  useRevertDraftFile,
  useSaveDraftFile,
  type DraftFailure,
} from '../../api/draft-queries';
import { ChangesView } from './changes-view';
import {
  ConfirmDialog,
  FileDialog,
  LeaveDialog,
  NewAgentDialog,
  type FileContent,
} from './draft-dialogs';
import {
  agentOfPath,
  listProblems,
  newAgentFile,
  overlayDraft,
  validateAgentLive,
} from './draft-model';
import { clearAllBuffers, clearBuffer, readBuffers, writeBuffer } from './editor-buffers';
import { ancestorsOf, buildTree, frontMatterKeyLine, type ProblemTarget } from './editor-model';
import { EditorPane, type PaneState } from './editor-pane';
import { agentState, FileTree } from './file-tree';
import { useLeaveGuard } from './use-leave-guard';

const TITLE_ID = 'agent-editor-title';

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** The editor's URL for a file: the file is the only state worth keeping in a link. */
function editorUrl(path: string): string {
  return `/agents/editor?${new URLSearchParams({ path })}`;
}

function agentStateOfCount(count: number): string {
  if (count === 0) return 'Valid';
  return `${count} ${count === 1 ? 'problem' : 'problems'}`;
}

const utf8 = new TextEncoder();

type DialogKind = 'add' | 'rename' | 'replace' | 'delete' | 'revert' | 'discard' | 'new-agent';

/**
 * The definitions Repository as a file tree on the left and the selected file in Monaco on the
 * right. It shows one commit and moves to a newer one only when the operator reloads. Changes
 * go into the Draft, never into the Repository.
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
  const draftQuery = useDraft();
  const providers = useProviders();
  const reload = useReloadEditor();
  const reloadDraft = useReloadDraft();
  const router = useRouter();
  const initial = useSearchParams().get('path') ?? undefined;

  const [path, setPath] = useState(initial);
  const [reveal, setReveal] = useState<{ target: ProblemTarget; token: number }>();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(initial ? ancestorsOf(initial) : []),
  );
  const [view, setView] = useState<'files' | 'changes'>('files');
  const [changed, setChanged] = useState<string>();
  const [buffers, setBuffers] = useState<Record<string, string>>(readBuffers);
  const [editing, setEditing] = useState(() => Object.keys(readBuffers()).length > 0);
  const [accepted, setAccepted] = useState<AgentDraftOutput>();
  const [dialog, setDialog] = useState<DialogKind>();
  const [failure, setFailure] = useState<DraftFailure>();
  const chooserId = useId();

  const dirty = Object.keys(buffers).length > 0;
  const guard = useLeaveGuard(dirty);

  const save = useSaveDraftFile((draft) => setAccepted(draft));
  const move = useMoveDraftFile((draft) => setAccepted(draft));
  const revert = useRevertDraftFile((draft) => setAccepted(draft));
  const remove = useDeleteDraftFile((draft) => setAccepted(draft));
  const discard = useDiscardDraft((draft) => setAccepted(draft));

  // The first answer is what the view shows until it is reloaded or a write of this tab replaces
  // it; a newer `version` seen later only raises the notice.
  if (accepted === undefined && draftQuery.data) setAccepted(draftQuery.data);
  const elsewhere =
    accepted !== undefined &&
    draftQuery.data !== undefined &&
    draftQuery.data.version !== accepted.version;
  const draft = elsewhere ? accepted : (draftQuery.data ?? accepted);

  const commit = files.data?.commit ?? undefined;
  const entries = useMemo(
    () => overlayDraft(files.data?.entries ?? [], draft?.files ?? []),
    [files.data, draft?.files],
  );
  const nodes = useMemo(() => buildTree(entries), [entries]);
  const baseAgents = useMemo(
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
  const written = entry?.change === 'added' || entry?.change === 'modified';
  const readable = entry?.openable && entry.change !== 'deleted' ? path : undefined;
  const baseFile = useAgentFile(written ? undefined : readable, commit);
  const draftFile = useAgentDraftFile(written ? readable : undefined);
  const file = written ? draftFile : baseFile;

  // The open agent is validated here while it is edited; elsewhere the API's answer stands.
  const agentOpen = path === undefined ? null : agentOfPath(path);
  const touched = new Set(
    (draft?.files ?? []).flatMap((item) => {
      const agent = agentOfPath(item.path);
      return agent === null ? [] : [agent];
    }),
  );
  const liveWanted =
    agentOpen !== null &&
    (touched.has(agentOpen) ||
      Object.keys(buffers).some((buffered) => agentOfPath(buffered) === agentOpen));
  const entryPath = liveWanted ? `agents/${agentOpen}/AGENT.md` : undefined;
  const entryEntry = entries.find((candidate) => candidate.path === entryPath);
  const entryWritten = entryEntry?.change === 'added' || entryEntry?.change === 'modified';
  const entryReadable =
    entryEntry?.openable && entryEntry.change !== 'deleted' ? entryPath : undefined;
  const entryBase = useAgentFile(entryWritten ? undefined : entryReadable, commit);
  const entryDraft = useAgentDraftFile(entryWritten ? entryReadable : undefined);
  const entryData = (entryWritten ? entryDraft : entryBase).data;

  const live =
    liveWanted && entryPath !== undefined
      ? validateAgentLive(
          agentOpen,
          entries,
          buffers[entryPath] ?? (entryData?.kind === 'text' ? entryData.content : undefined),
          new Map(Object.entries(buffers).map(([name, text]) => [name, utf8.encode(text).length])),
        )
      : undefined;
  if (live && agentOpen !== null) touched.add(agentOpen);
  const problems = listProblems({
    base: marks.data?.agents ?? [],
    draft: draft?.problems ?? [],
    touched,
    live: live && agentOpen !== null ? { agent: agentOpen, problems: live } : undefined,
  });

  const states = new Map<string, string>();
  for (const item of entries) {
    if (item.agent === null || states.has(item.agent)) continue;
    const count = problems.filter((problem) => problem.agent === item.agent).length;
    states.set(
      item.agent,
      (touched.has(item.agent)
        ? agentStateOfCount(count)
        : agentState(baseAgents.get(item.agent))) ?? '',
    );
  }

  const savedText = file.data?.kind === 'text' ? file.data.content : undefined;
  const value = path !== undefined ? (buffers[path] ?? savedText) : undefined;

  function open(next: string, target?: ProblemTarget) {
    setView('files');
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

  function setBuffer(target: string, text: string | undefined) {
    if (text === undefined) clearBuffer(target);
    else writeBuffer(target, text);
    setBuffers((current) => {
      const next = { ...current };
      if (text === undefined) delete next[target];
      else next[target] = text;
      return next;
    });
  }

  function edited(text: string) {
    if (path === undefined) return;
    setBuffer(path, text === savedText ? undefined : text);
  }

  async function saveOpenFile() {
    const text = path === undefined ? undefined : buffers[path];
    if (path === undefined || text === undefined) return;
    setFailure(undefined);
    try {
      await save.mutateAsync({ path, text });
      setBuffer(path, undefined);
    } catch (error) {
      setFailure(draftFailureOf(error));
    }
  }

  async function addFile(target: string, content: FileContent | undefined) {
    await save.mutateAsync({ path: target, ...(content ?? { text: '' }) });
    open(target);
    if (content && 'text' in content) setEditing(true);
  }

  async function renameFile(target: string) {
    if (path === undefined) return;
    const from = path;
    await move.mutateAsync({ from, to: target });
    const unsaved = buffers[from];
    setBuffer(from, undefined);
    if (unsaved !== undefined) setBuffer(target, unsaved);
    open(target);
  }

  async function replaceFile(target: string, content: FileContent | undefined) {
    if (content) await save.mutateAsync({ path: target, ...content });
  }

  async function newAgent(name: string, provider: string) {
    const target = `agents/${name}/AGENT.md`;
    await save.mutateAsync({ path: target, text: newAgentFile(name, provider) });
    open(target);
    setEditing(true);
  }

  if (files.isPending || marks.isPending || draftQuery.isPending) {
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
  if (files.isError || marks.isError || draftQuery.isError || draft === undefined) {
    return (
      <EmptyState
        tone="error"
        icon={TriangleAlertIcon}
        title="Couldn't load the files"
        description={
          <span className="font-mono text-small">
            {draftQuery.isError && !files.isError && !marks.isError
              ? 'GET /api/agents/definitions-repository/draft'
              : 'GET /api/agents/definitions-repository/files'}
          </span>
        }
        action={
          <Button
            icon={RefreshCwIcon}
            loading={files.isRefetching || marks.isRefetching || draftQuery.isRefetching}
            onClick={() => {
              void reload();
              void reloadDraft();
            }}
          >
            Retry
          </Button>
        }
      />
    );
  }

  const newestCommit = latest.data?.commit ?? undefined;
  // Also when the marks were read at another commit than the tree: they would describe files
  // that are not shown.
  const marksCommit = marks.data?.commit ?? undefined;
  const newer =
    (newestCommit !== undefined && newestCommit !== commit) ||
    (marksCommit !== undefined && marksCommit !== commit);
  const openable = entries.filter((candidate) => candidate.openable);
  const moved =
    draft.baseCommit !== null &&
    draft.currentCommit !== null &&
    draft.baseCommit !== draft.currentCommit;
  const taken = new Set(
    entries.flatMap((candidate) => (candidate.agent === null ? [] : [candidate.agent])),
  );
  const existing = new Set(entries.filter((c) => c.change !== 'deleted').map((c) => c.path));
  const deletedPaths = new Set(entries.filter((c) => c.change === 'deleted').map((c) => c.path));
  const working = save.isPending || move.isPending || revert.isPending || remove.isPending;

  let pane: PaneState;
  if (path === undefined) pane = { kind: 'none' };
  else if (!entry) pane = { kind: 'missing', path };
  else if (entry.change === 'deleted') pane = { kind: 'deleted', path };
  else if (!entry.openable) pane = { kind: 'refused', entry };
  else if (file.isError) pane = { kind: 'error', path };
  else if (!file.data) pane = { kind: 'loading', path };
  else {
    const key = reveal?.target.path === path ? reveal.target.key : undefined;
    const line =
      key !== undefined && file.data.kind === 'text'
        ? frontMatterKeyLine(value ?? file.data.content, key)
        : undefined;
    const markers = problems
      .filter((problem) => problem.target.path === path)
      .map((problem) => ({
        line:
          problem.target.key !== undefined && value !== undefined
            ? (frontMatterKeyLine(value, problem.target.key) ?? 1)
            : 1,
        message: problem.message,
      }));
    pane = {
      kind: 'file',
      file: file.data,
      value,
      editable: editing && file.data.kind === 'text' && !working,
      markers,
      revealLine: line,
      revealToken: reveal?.token,
    };
  }
  const changeCount = draft.files.length;
  const openFileKind = pane.kind === 'file' ? pane.file.kind : undefined;
  const closeDialog = () => setDialog(undefined);

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
          {draft.baseCommit ? (
            <>
              {' · Draft based on commit '}
              <code className="text-code" title={draft.baseCommit}>
                {shortSha(draft.baseCommit)}
              </code>
            </>
          ) : null}
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
            The Repository is now at commit{' '}
            <code className="text-code">
              {shortSha((newestCommit !== commit ? newestCommit : marksCommit) ?? '')}
            </code>
            , not the one shown here.
          </Banner>
        ) : null}
        {moved ? (
          <Banner tone="warning" className="m-4" title="The Repository moved on">
            The Repository is at commit{' '}
            <code className="text-code">{shortSha(draft.currentCommit ?? '')}</code>; this Draft
            began at <code className="text-code">{shortSha(draft.baseCommit ?? '')}</code>.
            {draft.movedUpstream.length > 0 ? (
              <>
                {' '}
                These Draft files changed there too:
                <ul className="m-0 mt-1 list-disc pl-5">
                  {draft.movedUpstream.map((upstream) => (
                    <li key={upstream} className="font-mono text-code break-all">
                      {upstream}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </Banner>
        ) : null}
        {elsewhere ? (
          <Banner
            tone="warning"
            className="m-4"
            action={
              <Button
                size="sm"
                onClick={() => {
                  if (draftQuery.data) setAccepted(draftQuery.data);
                  void reloadDraft();
                }}
              >
                Reload the Draft
              </Button>
            }
          >
            The Draft changed elsewhere since you opened it. Reload it to see its files.
          </Banner>
        ) : null}
        {failure ? (
          <Banner
            tone="danger"
            className="m-4"
            action={
              failure.kind === 'base-missing' ? (
                <Button size="sm" variant="danger" onClick={() => setDialog('discard')}>
                  Discard the Draft
                </Button>
              ) : failure.kind === 'conflict' ? (
                <Button
                  size="sm"
                  onClick={() => {
                    setFailure(undefined);
                    if (draftQuery.data) setAccepted(draftQuery.data);
                    void reloadDraft();
                  }}
                >
                  Reload the Draft
                </Button>
              ) : undefined
            }
          >
            {failure.message}
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
            <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
              <SegmentedControl
                label="View"
                value={view}
                onChange={setView}
                options={[
                  { value: 'files', label: 'Files' },
                  { value: 'changes', label: `Changes (${changeCount})` },
                ]}
              />
              <Button
                size="sm"
                aria-pressed={editing}
                variant={editing ? 'primary' : 'secondary'}
                onClick={() => setEditing((current) => !current)}
              >
                Edit
              </Button>
              <Button
                size="sm"
                disabled={path === undefined || buffers[path] === undefined}
                loading={save.isPending}
                onClick={() => void saveOpenFile()}
              >
                Save
              </Button>
              <span className="ml-auto flex flex-wrap items-center gap-2">
                <Button size="sm" onClick={() => setDialog('new-agent')}>
                  New agent
                </Button>
                <Button size="sm" onClick={() => setDialog('add')}>
                  New file
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={changeCount === 0 && !dirty}
                  onClick={() => setDialog('discard')}
                >
                  Discard Draft
                </Button>
              </span>
            </div>
            {problems.length > 0 ? (
              <section
                aria-labelledby="agent-editor-problems"
                className="border-b border-border p-4"
              >
                <h2 id="agent-editor-problems" className="m-0 mb-2 text-label font-semibold">
                  Problems
                </h2>
                <ul className="m-0 flex list-none flex-col gap-1 p-0 text-small">
                  {problems.map(({ agent, code, message, target }, index) => (
                    <li key={`${agent}:${code}:${target.path}:${target.key ?? ''}:${index}`}>
                      <button
                        type="button"
                        onClick={() => open(target.path, target)}
                        className="cursor-pointer rounded-sm text-left text-run-failed hover:underline focus-visible:outline-2 focus-visible:outline-ring pointer-coarse:min-h-11"
                      >
                        <span className="font-mono text-code break-all">{target.path}</span>
                        {target.key ? (
                          <>
                            {' · '}
                            <code className="text-code">{target.key}</code>
                          </>
                        ) : null}
                        {' — '}
                        {message}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {view === 'changes' ? (
              <ChangesView
                files={draft.files}
                baseCommit={draft.baseCommit}
                selected={changed}
                onSelect={setChanged}
              />
            ) : (
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
                    states={states}
                    onToggle={toggle}
                    onOpen={(next) => open(next)}
                  />
                </nav>
                <div className="min-w-0 flex-1 md:h-[70vh]">
                  {entry ? (
                    <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
                      <span className="min-w-0 flex-1 font-mono text-code break-all">
                        {entry.path}
                      </span>
                      {entry.openable && entry.change !== 'deleted' ? (
                        <>
                          <Button size="sm" onClick={() => setDialog('rename')}>
                            Rename
                          </Button>
                          <Button size="sm" onClick={() => setDialog('delete')}>
                            Delete
                          </Button>
                        </>
                      ) : null}
                      {openFileKind === 'binary' || openFileKind === 'too_large' ? (
                        <Button size="sm" onClick={() => setDialog('replace')}>
                          Replace file
                        </Button>
                      ) : null}
                      {entry.change ? (
                        <Button size="sm" onClick={() => setDialog('revert')}>
                          Revert
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                  <EditorPane state={pane} onChange={edited} />
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
      {dialog === 'add' ? (
        <FileDialog
          open
          onOpenChange={closeDialog}
          mode="add"
          initialPath={path === undefined ? '' : path.slice(0, path.lastIndexOf('/') + 1)}
          existing={existing}
          deleted={deletedPaths}
          action={addFile}
        />
      ) : null}
      {dialog === 'rename' && path !== undefined ? (
        <FileDialog
          open
          onOpenChange={closeDialog}
          mode="rename"
          initialPath={path}
          existing={existing}
          deleted={deletedPaths}
          action={(target) => renameFile(target)}
        />
      ) : null}
      {dialog === 'replace' && path !== undefined ? (
        <FileDialog
          open
          onOpenChange={closeDialog}
          mode="replace"
          initialPath={path}
          existing={existing}
          deleted={deletedPaths}
          action={replaceFile}
        />
      ) : null}
      {dialog === 'new-agent' ? (
        <NewAgentDialog
          open
          onOpenChange={closeDialog}
          providers={providers.data ?? []}
          taken={taken}
          action={newAgent}
        />
      ) : null}
      {dialog === 'delete' && path !== undefined ? (
        <ConfirmDialog
          open
          onOpenChange={closeDialog}
          title="Delete file"
          description={<code className="text-code break-all">{path}</code>}
          confirmLabel="Delete file"
          consequences={[
            'The file is marked deleted in the Draft.',
            'The Repository keeps it until the Draft is published.',
            'Revert brings it back.',
          ]}
          action={async () => {
            await remove.mutateAsync(path);
            setBuffer(path, undefined);
          }}
        />
      ) : null}
      {dialog === 'revert' && path !== undefined ? (
        <ConfirmDialog
          open
          onOpenChange={closeDialog}
          title="Revert file"
          description={<code className="text-code break-all">{path}</code>}
          confirmLabel="Revert file"
          consequences={[
            'The Draft drops its change to this file; it is the Repository’s again.',
            'Unsaved edits of this file are lost.',
          ]}
          action={async () => {
            await revert.mutateAsync(path);
            setBuffer(path, undefined);
          }}
        />
      ) : null}
      {dialog === 'discard' ? (
        <ConfirmDialog
          open
          onOpenChange={closeDialog}
          title="Discard the Draft"
          description="Every change in the Draft."
          confirmLabel="Discard the Draft"
          consequences={[
            'All added, changed and deleted files of the Draft are dropped.',
            'Unsaved edits are lost.',
            'The Repository is not changed.',
          ]}
          action={async () => {
            await discard.mutateAsync();
            clearAllBuffers();
            setBuffers({});
            setFailure(undefined);
          }}
        />
      ) : null}
      <LeaveDialog
        open={guard.target !== undefined}
        onOpenChange={(next) => {
          if (!next) guard.stay();
        }}
        onLeave={guard.leave}
      />
    </Card>
  );
}
