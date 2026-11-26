'use client';

import { RefreshCwIcon, TriangleAlertIcon } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Banner } from '@/shared/components/banner';
import { EmptyState } from '@/shared/components/empty-state';
import { SegmentedControl } from '@/shared/components/segmented-control';
import { Button } from '@/shared/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/ui/card';
import { Label } from '@/shared/ui/label';
import { NativeSelect } from '@/shared/ui/native-select';
import { Skeleton } from '@/shared/ui/skeleton';
import type {
  AgentDraftOutput,
  AgentSummaryOutput,
  SkillSummaryOutput,
} from '../../../../platform/api';
import {
  useAgentFile,
  useAgentFiles,
  useAgents,
  useEditorAgents,
  useEditorSkills,
  useProviders,
  useReloadEditor,
} from '../../api/agents-queries';
import {
  draftFailureOf,
  useAgentDraftFile,
  useAgentDraftTexts,
  useDeleteDraftFile,
  useDiscardDraft,
  useDropDraftFilesExcept,
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
  NewSkillDialog,
  type FileContent,
} from './draft-dialogs';
import {
  agentOfPath,
  listProblems,
  newAgentFile,
  overlayDraft,
  validateAgentLive,
} from './draft-model';
import { clearAllBuffers, readBuffers, syncBuffers } from './editor-buffers';
import {
  ancestorsOf,
  buildTree,
  CHANGE_LABEL,
  frontMatterKeyLine,
  type ProblemTarget,
} from './editor-model';
import { EditorPane, type PaneState } from './editor-pane';
import { agentState, FileTree } from './file-tree';
import {
  agentsNaming,
  namingAgentProblems,
  newSkillFile,
  NOT_JUDGED_TEXT,
  skillOfPath,
  skillStandings,
  validateSkillLive,
} from './skill-model';
import { PublishDialog } from './publish-dialog';
import { useDebouncedValue } from './use-debounced-value';
import { useLeaveGuard } from './use-leave-guard';

const TITLE_ID = 'agent-editor-title';

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** The editor's URL for a file: the file is the only state worth keeping in a link. */
function editorUrl(path: string): string {
  return `/agents/editor?${new URLSearchParams({ path })}`;
}

function skillStateOf(skill: SkillSummaryOutput | undefined): string | undefined {
  if (!skill) return undefined;
  if (skill.valid) return 'Valid';
  const count = skill.problems.length;
  return count === 0 ? 'Not valid' : `${count} ${count === 1 ? 'problem' : 'problems'}`;
}

function agentStateOfCount(count: number): string {
  if (count === 0) return 'Valid';
  return `${count} ${count === 1 ? 'problem' : 'problems'}`;
}

const utf8 = new TextEncoder();

type DialogKind =
  | 'add'
  | 'rename'
  | 'replace'
  | 'delete'
  | 'revert'
  | 'discard'
  | 'new-agent'
  | 'new-skill'
  | 'confirm-save'
  | 'publish';

const TYPING_DELAY_MS = 300;

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
  const skillMarks = useEditorSkills();
  const latest = useAgents();
  const draftQuery = useDraft();
  const providers = useProviders();
  const reload = useReloadEditor();
  const reloadDraft = useReloadDraft();
  const router = useRouter();
  const params = useSearchParams();
  const initial = params.get('path') ?? undefined;

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
  const [dialog, setDialog] = useState<DialogKind | undefined>(() =>
    params.get('new') === 'skill' ? 'new-skill' : undefined,
  );
  const [failure, setFailure] = useState<DraftFailure>();
  const [stale, setStale] = useState(false);
  const [storageFailed, setStorageFailed] = useState(false);
  const chooserId = useId();

  const dirty = Object.keys(buffers).length > 0;
  const guard = useLeaveGuard(dirty);

  // A write of this tab answers with the version it made. Any other number means another writer
  // was in between, so the cached files may be old and the notice stays up.
  const acceptedRef = useRef<AgentDraftOutput | undefined>(undefined);
  const buffersRef = useRef(buffers);
  useEffect(() => {
    acceptedRef.current = accepted;
    buffersRef.current = buffers;
  });
  const dropFiles = useDropDraftFilesExcept();
  function accept(draft: AgentDraftOutput, keep?: string) {
    const previous = acceptedRef.current;
    if (previous && draft.version !== previous.version + 1) {
      dropFiles(keep);
      setStale(true);
    }
    acceptedRef.current = draft;
    setAccepted(draft);
  }
  const save = useSaveDraftFile((draft, saved) => accept(draft, saved));
  const move = useMoveDraftFile((draft) => accept(draft));
  const revert = useRevertDraftFile((draft) => accept(draft));
  const remove = useDeleteDraftFile((draft) => accept(draft));
  const discard = useDiscardDraft((draft) => {
    accept(draft);
    setStale(false);
  });

  // Edits reach session storage once typing pauses, and when the view goes away.
  useEffect(() => {
    const timer = setTimeout(() => setStorageFailed(!syncBuffers(buffers)), TYPING_DELAY_MS);
    return () => clearTimeout(timer);
  }, [buffers]);
  useEffect(() => {
    const flush = () => void syncBuffers(buffersRef.current);
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', flush);
      flush();
    };
  }, []);
  const settled = useDebouncedValue(buffers, TYPING_DELAY_MS);

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

  // An unsaved edit of a file that is gone (reverted elsewhere, say) is real text: it stays listed.
  const known = new Set(entries.filter((item) => item.change !== 'deleted').map((i) => i.path));
  const listComplete = files.data !== undefined && !files.data.truncated && draftQuery.isSuccess;
  const nodes = useMemo(() => buildTree(entries), [entries]);
  const baseSkills = useMemo(
    () =>
      new Map<string, SkillSummaryOutput>((skillMarks.data?.skills ?? []).map((s) => [s.name, s])),
    [skillMarks.data],
  );
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

  // The open agent or skill is validated here while it is edited; elsewhere the API's answer stands.
  const agentOpen = path === undefined ? null : agentOfPath(path);
  const skillOpen = path === undefined ? null : skillOfPath(path);
  const touchedByDraft = useMemo(
    () =>
      new Set(
        (draft?.files ?? []).flatMap((item) => {
          const agent = agentOfPath(item.path);
          return agent === null ? [] : [agent];
        }),
      ),
    [draft?.files],
  );
  const touchedSkillsByDraft = useMemo(
    () =>
      new Set(
        (draft?.files ?? []).flatMap((item) => {
          const skill = skillOfPath(item.path);
          return skill === null ? [] : [skill];
        }),
      ),
    [draft?.files],
  );
  const touched = new Set(touchedByDraft);
  const touchedSkills = new Set(touchedSkillsByDraft);
  const bufferedPaths = Object.keys(buffers);
  const liveWanted =
    (agentOpen !== null &&
      (touched.has(agentOpen) || bufferedPaths.some((item) => agentOfPath(item) === agentOpen))) ||
    (skillOpen !== null &&
      (touchedSkills.has(skillOpen) ||
        bufferedPaths.some((item) => skillOfPath(item) === skillOpen)));
  const entryPath = !liveWanted
    ? undefined
    : agentOpen !== null
      ? `agents/${agentOpen}/AGENT.md`
      : skillOpen !== null
        ? `skills/${skillOpen}/SKILL.md`
        : undefined;
  const entryEntry = entries.find((candidate) => candidate.path === entryPath);
  const entryWritten = entryEntry?.change === 'added' || entryEntry?.change === 'modified';
  const entryReadable =
    entryEntry?.openable && entryEntry.change !== 'deleted' ? entryPath : undefined;
  const entryBase = useAgentFile(entryWritten ? undefined : entryReadable, commit);
  const entryDraft = useAgentDraftFile(entryWritten ? entryReadable : undefined);
  const entryData = (entryWritten ? entryDraft : entryBase).data;

  // The agents the Draft writes are read, to find those that name a skill it changes.
  const draftAgentEntries = entries
    .filter((item) => /^agents\/[^/]+\/AGENT\.md$/.test(item.path))
    .filter((item) => item.change === 'added' || item.change === 'modified')
    .map((item) => item.path);
  const skillEntryPath = path === undefined ? null : /^skills\/[^/]+\/SKILL\.md$/.exec(path);
  const draftAgentTexts = useAgentDraftTexts(
    touchedSkills.size > 0 || skillEntryPath !== null || skillOpen !== null
      ? draftAgentEntries
      : [],
  );

  const sizes = useMemo(
    () => new Map(Object.entries(settled).map(([name, text]) => [name, utf8.encode(text).length])),
    [settled],
  );
  const knownTexts = useMemo(() => {
    const texts = new Map(Object.entries(settled));
    if (entryPath !== undefined && !texts.has(entryPath) && entryData?.kind === 'text') {
      texts.set(entryPath, entryData.content);
    }
    return texts;
  }, [settled, entryPath, entryData]);
  const liveSkillProblems = useMemo(
    () =>
      liveWanted && skillOpen !== null
        ? validateSkillLive(skillOpen, entries, knownTexts, sizes)
        : undefined,
    [liveWanted, skillOpen, entries, knownTexts, sizes],
  );
  if (liveSkillProblems && skillOpen !== null) touchedSkills.add(skillOpen);
  const skillsWithProblems = new Set((draft?.skillProblems ?? []).map((item) => item.skill));
  if (liveSkillProblems && skillOpen !== null) {
    skillsWithProblems.delete(skillOpen);
    if (liveSkillProblems.length > 0) skillsWithProblems.add(skillOpen);
  }
  const standings = skillStandings(
    entries,
    skillMarks.data?.skills ?? [],
    skillsWithProblems,
    touchedSkills,
  );
  const live = useMemo(
    () =>
      liveWanted && agentOpen !== null && entryPath !== undefined
        ? validateAgentLive(agentOpen, entries, knownTexts.get(entryPath), sizes, standings)
        : undefined,
    // The standings are rebuilt each render from the values listed here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      liveWanted,
      entryPath,
      agentOpen,
      entries,
      knownTexts,
      sizes,
      skillMarks.data,
      draft?.skillProblems,
      liveSkillProblems,
    ],
  );
  if (live && agentOpen !== null) touched.add(agentOpen);
  // The agents the Draft leaves alone that name a skill it changes are judged with the Draft.
  const named = new Set<string>();
  for (const skill of touchedSkills) {
    for (const agent of agentsNaming(skill, marks.data?.agents ?? [], entries, draftAgentTexts)) {
      if (!touched.has(agent)) named.add(agent);
    }
  }
  const liveSkill =
    liveSkillProblems && skillOpen !== null
      ? {
          skill: skillOpen,
          problems: liveSkillProblems,
          naming: namingAgentProblems(skillOpen, marks.data?.agents ?? [], touched, standings),
        }
      : undefined;
  const problems = listProblems({
    base: marks.data?.agents ?? [],
    baseSkills: skillMarks.data?.skills ?? [],
    draft: draft?.problems ?? [],
    draftSkills: draft?.skillProblems ?? [],
    touched,
    touchedSkills,
    named,
    live: live && agentOpen !== null ? { agent: agentOpen, problems: live } : undefined,
    liveSkill,
  });

  const states = new Map<string, string>();
  for (const item of entries) {
    if (item.agent !== null && !states.has(`agents/${item.agent}`)) {
      const count = problems.filter((problem) => problem.agent === item.agent).length;
      states.set(
        `agents/${item.agent}`,
        (touched.has(item.agent) || named.has(item.agent)
          ? agentStateOfCount(count)
          : agentState(baseAgents.get(item.agent))) ?? '',
      );
    }
    if (item.skill !== null && !states.has(`skills/${item.skill}`)) {
      const count = problems.filter((problem) => problem.skill === item.skill).length;
      states.set(
        `skills/${item.skill}`,
        (touchedSkills.has(item.skill)
          ? agentStateOfCount(count)
          : skillStateOf(baseSkills.get(item.skill))) ?? '',
      );
    }
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

  async function storeOpenFile() {
    const text = path === undefined ? undefined : buffers[path];
    if (path === undefined || text === undefined) return;
    await save.mutateAsync({ path, text });
    setBuffer(path, undefined);
  }

  async function saveOpenFile() {
    setFailure(undefined);
    try {
      await storeOpenFile();
    } catch (error) {
      setFailure(draftFailureOf(error));
    }
  }

  function reloadFromServer() {
    setFailure(undefined);
    setStale(false);
    if (draftQuery.data) setAccepted(draftQuery.data);
    void reloadDraft();
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

  async function newSkill(name: string) {
    const target = `skills/${name}/SKILL.md`;
    await save.mutateAsync({ path: target, text: newSkillFile(name) });
    open(target);
    setEditing(true);
  }

  async function newAgent(name: string, provider: string) {
    const target = `agents/${name}/AGENT.md`;
    await save.mutateAsync({ path: target, text: newAgentFile(name, provider) });
    open(target);
    setEditing(true);
  }

  if (files.isPending || marks.isPending || skillMarks.isPending || draftQuery.isPending) {
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
  if (
    files.isError ||
    marks.isError ||
    skillMarks.isError ||
    draftQuery.isError ||
    draft === undefined
  ) {
    return (
      <EmptyState
        tone="error"
        icon={TriangleAlertIcon}
        title="Couldn't load the files"
        description={
          <span className="font-mono text-small">
            {skillMarks.isError && !files.isError && !marks.isError && !draftQuery.isError
              ? 'GET /api/skills'
              : draftQuery.isError && !files.isError && !marks.isError
                ? 'GET /api/agents/definitions-repository/draft'
                : 'GET /api/agents/definitions-repository/files'}
          </span>
        }
        action={
          <Button
            icon={RefreshCwIcon}
            loading={
              files.isRefetching ||
              marks.isRefetching ||
              skillMarks.isRefetching ||
              draftQuery.isRefetching
            }
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
  const takenSkills = new Set(
    entries.flatMap((candidate) => (candidate.skill === null ? [] : [candidate.skill])),
  );
  // Taking the entry file of a skill away makes the agents that name it invalid.
  const skillUsers =
    skillEntryPath === null
      ? []
      : agentsNaming(
          skillEntryPath[0].split('/')[1]!,
          marks.data?.agents ?? [],
          entries,
          draftAgentTexts,
        );
  const usersWarning =
    skillUsers.length === 0
      ? undefined
      : `${skillUsers.length === 1 ? 'This agent names' : 'These agents name'} this skill and would become invalid: ${skillUsers.join(', ')}.`;
  const existing = new Set(entries.filter((c) => c.change !== 'deleted').map((c) => c.path));
  const deletedPaths = new Set(entries.filter((c) => c.change === 'deleted').map((c) => c.path));
  const working =
    save.isPending || move.isPending || revert.isPending || remove.isPending || discard.isPending;
  // Untouched files are read at the commit this view shows; the Draft keeps the commit it began at.
  const commitDiffers = newer || (draft.baseCommit !== null && commit !== draft.baseCommit);
  const unsaved = new Set(Object.keys(buffers));
  const entryChange = (candidate: { change?: 'added' | 'modified' | 'deleted' }) =>
    candidate.change ? ` (${CHANGE_LABEL[candidate.change]})` : '';

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
  const draftProblemCount = problems.filter(
    (problem) =>
      (problem.agent !== null && (touched.has(problem.agent) || named.has(problem.agent))) ||
      (problem.skill !== null && touchedSkills.has(problem.skill)),
  ).length;
  // Why Publish is not offered now; the dialog and the API judge again.
  const publishBlock = dirty
    ? 'Save or discard your unsaved edits first.'
    : changeCount === 0
      ? 'The Draft has no changes to publish.'
      : draft.judged === false
        ? NOT_JUDGED_TEXT[draft.notJudgedReason ?? 'clone_unreadable']
        : draftProblemCount > 0
          ? `Fix the ${draftProblemCount} ${draftProblemCount === 1 ? 'problem' : 'problems'} of the Draft first.`
          : moved
            ? 'The Repository moved since the Draft began, so the Draft cannot be published. Copy what you need, discard it, and make the changes again.'
            : elsewhere || stale
              ? 'Reload the Draft before publishing it.'
              : draft.baseCommit === null
                ? 'The Draft has no base commit to publish onto.'
                : undefined;
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
        {elsewhere || stale ? (
          <Banner
            tone="warning"
            className="m-4"
            action={
              <Button size="sm" onClick={reloadFromServer}>
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
                <Button size="sm" onClick={reloadFromServer}>
                  Reload the Draft
                </Button>
              ) : undefined
            }
          >
            {failure.message}
          </Banner>
        ) : null}
        {draft.judged === false && draft.baseCommit !== null ? (
          <Banner tone="warning" className="m-4" title="The Draft was not checked">
            {NOT_JUDGED_TEXT[draft.notJudgedReason ?? 'clone_unreadable']} The problems below may be
            incomplete.
          </Banner>
        ) : null}
        {storageFailed ? (
          <Banner tone="warning" className="m-4">
            This browser refused to keep your unsaved edits for a reload. They stay in this page
            until you save them or leave it.
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
                onClick={() => (commitDiffers ? setDialog('confirm-save') : void saveOpenFile())}
              >
                Save
              </Button>
              <span className="ml-auto flex flex-wrap items-center gap-2">
                <Button size="sm" onClick={() => setDialog('new-agent')}>
                  New agent
                </Button>
                <Button size="sm" onClick={() => setDialog('new-skill')}>
                  New skill
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
                <Button
                  size="sm"
                  variant="primary"
                  disabled={publishBlock !== undefined || working}
                  aria-describedby={publishBlock ? 'agent-editor-publish-block' : undefined}
                  onClick={() => setDialog('publish')}
                >
                  Publish
                </Button>
              </span>
              {publishBlock ? (
                <p
                  id="agent-editor-publish-block"
                  className="m-0 w-full text-small text-text-muted"
                >
                  {publishBlock}
                </p>
              ) : null}
            </div>
            {editing ? (
              <p className="m-0 border-b border-border px-3 py-2 text-small text-text-muted">
                Tab inserts a tab here. Press Ctrl+M to make Tab move focus instead.
              </p>
            ) : null}
            {dirty ? (
              <section
                aria-labelledby="agent-editor-unsaved"
                className="border-b border-border p-4"
              >
                <h2 id="agent-editor-unsaved" className="m-0 mb-2 text-label font-semibold">
                  Unsaved edits
                </h2>
                <ul className="m-0 flex list-none flex-col gap-1 p-0 text-small">
                  {Object.keys(buffers).map((buffered) => (
                    <li key={buffered} className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => open(buffered)}
                        className="cursor-pointer rounded-sm text-left font-mono text-code break-all hover:underline focus-visible:outline-2 focus-visible:outline-ring pointer-coarse:min-h-11"
                      >
                        {buffered}
                      </button>
                      {listComplete && !known.has(buffered) ? (
                        <span className="text-text-muted">
                          This file no longer exists in the Draft or the Repository.
                        </span>
                      ) : null}
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Discard unsaved edit of ${buffered}`}
                        onClick={() => setBuffer(buffered, undefined)}
                      >
                        Discard unsaved edit
                      </Button>
                    </li>
                  ))}
                </ul>
              </section>
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
                  {problems.map(({ agent, skill, code, message, target, note }, index) => (
                    <li
                      key={`${agent ?? skill}:${code}:${target.path}:${target.key ?? ''}:${index}`}
                    >
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
                        {note ? <span className="text-text-muted"> {note}</span> : null}
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
                        {entryChange(candidate)}
                        {unsaved.has(candidate.path) ? ' (Unsaved)' : ''}
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
                    unsaved={unsaved}
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
          onReload={reloadFromServer}
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
          onReload={reloadFromServer}
          mode="rename"
          initialPath={path}
          existing={existing}
          deleted={deletedPaths}
          warning={usersWarning}
          action={(target) => renameFile(target)}
        />
      ) : null}
      {dialog === 'replace' && path !== undefined ? (
        <FileDialog
          open
          onOpenChange={closeDialog}
          onReload={reloadFromServer}
          mode="replace"
          initialPath={path}
          existing={existing}
          deleted={deletedPaths}
          action={replaceFile}
        />
      ) : null}
      {dialog === 'new-skill' ? (
        <NewSkillDialog
          open
          onOpenChange={closeDialog}
          onReload={reloadFromServer}
          taken={takenSkills}
          action={newSkill}
        />
      ) : null}
      {dialog === 'new-agent' ? (
        <NewAgentDialog
          open
          onOpenChange={closeDialog}
          onReload={reloadFromServer}
          providers={providers.data ?? []}
          taken={taken}
          action={newAgent}
        />
      ) : null}
      {dialog === 'delete' && path !== undefined ? (
        <ConfirmDialog
          open
          onOpenChange={closeDialog}
          onReload={reloadFromServer}
          title="Delete file"
          description={<code className="text-code break-all">{path}</code>}
          confirmLabel="Delete file"
          consequences={[
            ...(usersWarning ? [usersWarning] : []),
            ...(entry?.change === 'added'
              ? [
                  'This file exists only in the Draft: its content is removed for good.',
                  'Nothing is left to revert; the Repository never had it.',
                ]
              : [
                  'The file is marked deleted in the Draft.',
                  'The Repository keeps it until the Draft is published.',
                  'Revert brings it back.',
                ]),
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
          onReload={reloadFromServer}
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
          onReload={reloadFromServer}
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
      {dialog === 'publish' ? (
        <PublishDialog
          open
          onOpenChange={closeDialog}
          files={draft.files}
          baseCommit={draft.baseCommit ?? ''}
          version={draft.version}
          movedUpstream={draft.movedUpstream}
          onReload={reloadFromServer}
          onDiscard={() => setDialog('discard')}
          onRevertPaths={async (paths) => {
            for (const target of paths) {
              await revert.mutateAsync(target);
              setBuffer(target, undefined);
            }
          }}
          onPublished={() => {
            // The Draft is gone: the next answer of the API is the one to show.
            acceptedRef.current = undefined;
            setAccepted(undefined);
            setStale(false);
            setFailure(undefined);
            setChanged(undefined);
          }}
        />
      ) : null}
      {dialog === 'confirm-save' ? (
        <ConfirmDialog
          open
          onOpenChange={closeDialog}
          onReload={reloadFromServer}
          title="Save while the Repository has moved?"
          description="This view and the Draft are not at the same commit."
          confirmLabel="Save anyway"
          consequences={[
            'The Repository moved since the Draft began, or since this view was read.',
            'Saving keeps the Draft’s base commit; files you did not touch stay as the base has them.',
            'The text you edited is what this view shows, which may differ from the base: Reload first to see the newest.',
          ]}
          action={storeOpenFile}
        />
      ) : null}
      <LeaveDialog
        unsaved={Object.keys(buffers)}
        open={guard.target !== undefined}
        onOpenChange={(next) => {
          if (!next) guard.stay();
        }}
        onLeave={guard.leave}
      />
    </Card>
  );
}
